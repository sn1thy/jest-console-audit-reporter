import { AuditConfig, AuditRule, Level, Snapshot, Group } from "./types";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
export const levels: Level[] = ["log", "info", "debug", "warn", "error"];
export const stripAnsi = (s: string): string =>
  require("util").stripVTControlCharacters(s);
function fields(o: any, allowed: string[], name: string): void {
  if (!o || typeof o !== "object" || Array.isArray(o))
    throw Error(name + " must be an object");
  for (const key of Object.keys(o))
    if (!allowed.includes(key))
      throw Error("Unknown " + name + " field: " + key);
}
function nonempty(s: any): boolean {
  return typeof s === "string" && s.trim().length > 0;
}
export function validate(c: any): AuditConfig {
  fields(
    c,
    [
      "schemaVersion",
      "rules",
      "failOnUnexpected",
      "display",
      "jsonReport",
      "limits",
    ],
    "config"
  );
  if (c.schemaVersion !== 1 || !Array.isArray(c.rules))
    throw Error("schemaVersion must be 1 and rules an array");
  const ids = new Set<string>();
  c.rules.forEach((r: any) => {
    fields(
      r,
      [
        "id",
        "label",
        "reason",
        "levels",
        "match",
        "testFiles",
        "origins",
        "live",
      ],
      "rule"
    );
    if (![r.id, r.label, r.reason].every(nonempty) || ids.has(r.id))
      throw Error(
        "Rule IDs must be unique; id, label and reason must be nonempty"
      );
    ids.add(r.id);
    if (
      !Array.isArray(r.levels) ||
      !r.levels.length ||
      r.levels.some((x: any) => !levels.includes(x))
    )
      throw Error("Rule levels must be explicit supported levels");
    fields(r.match, ["exact", "substring", "regex"], "match");
    if (Object.keys(r.match).length !== 1)
      throw Error("Specify exactly one matcher");
    if ("regex" in r.match) {
      fields(r.match.regex, ["source", "flags"], "regex");
      const { source, flags = "" } = r.match.regex;
      if (
        typeof source !== "string" ||
        typeof flags !== "string" ||
        /[gy]/.test(flags)
      )
        throw Error("Invalid or stateful regex");
      new RegExp(source, flags);
    } else if (typeof Object.values(r.match)[0] !== "string")
      throw Error("Matcher must be a string");
    for (const key of ["testFiles", "origins"])
      if (
        r[key] !== undefined &&
        (!Array.isArray(r[key]) || !r[key].length || !r[key].every(nonempty))
      )
        throw Error(key + " must contain nonempty globs");
    if (r.live !== undefined && typeof r.live !== "boolean")
      throw Error("live must be boolean");
  });
  if (
    c.failOnUnexpected !== undefined &&
    typeof c.failOnUnexpected !== "boolean"
  )
    throw Error("failOnUnexpected must be boolean");
  if (c.jsonReport !== undefined && !nonempty(c.jsonReport))
    throw Error("jsonReport must be a nonempty path");
  if (c.display !== undefined) {
    fields(c.display, ["detail", "githubActions"], "display");
    if (
      c.display.detail !== undefined &&
      !["compact", "detailed"].includes(c.display.detail)
    )
      throw Error("Invalid detail");
    if (
      c.display.githubActions !== undefined &&
      !["auto", "on", "off"].includes(c.display.githubActions)
    )
      throw Error("Invalid githubActions");
  }
  if (c.limits !== undefined) {
    fields(c.limits, ["groups", "samples", "messageLength", "files"], "limits");
    for (const n of Object.values(c.limits))
      if (!Number.isSafeInteger(n as number) || (n as number) < 1)
        throw Error("Limits must be positive integers");
  }
  return c;
}
export function load(file: string): AuditConfig {
  if (!file || !path.isAbsolute(file))
    throw Error("consoleAudit.configFile must be absolute");
  return validate(JSON.parse(fs.readFileSync(file, "utf8")));
}
export function glob(pattern: string, value: string): boolean {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += "[\\s\\S]*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$").test(value);
}
export function match(
  config: AuditConfig,
  level: Level,
  text: string,
  file: string,
  origin?: string
): AuditRule | undefined {
  return config.rules.find(
    (r) =>
      r.levels.includes(level) &&
      (!r.testFiles || r.testFiles.some((p) => glob(p, file))) &&
      (!r.origins ||
        (origin !== undefined && r.origins.some((p) => glob(p, origin)))) &&
      ("exact" in r.match
        ? text === r.match.exact
        : "substring" in r.match
        ? text.includes(r.match.substring)
        : new RegExp(r.match.regex.source, r.match.regex.flags).test(text))
  );
}
export function limits(c: AuditConfig) {
  return {
    groups: 1000,
    samples: 3,
    messageLength: 4000,
    files: 100,
    ...c.limits,
  };
}
export class Aggregate {
  private groups = new Map<string, Group>();
  private used = new Set<string>();
  private data: Snapshot = {
    total: 0,
    expected: 0,
    unexpected: 0,
    levels: { log: 0, info: 0, debug: 0, warn: 0, error: 0 },
    groups: [],
    omittedGroups: 0,
    usedRules: [],
  };
  constructor(private config: AuditConfig) {}
  add(
    level: Level,
    message: string,
    file: string,
    origin?: string
  ): AuditRule | undefined {
    const text = stripAnsi(message);
    const rule = match(this.config, level, text, file, origin);
    const lim = limits(this.config);
    this.data.total++;
    this.data.levels[level]++;
    this.data[rule ? "expected" : "unexpected"]++;
    if (rule) this.used.add(rule.id);
    const key = JSON.stringify([
      rule ? rule.id : null,
      level,
      rule ? null : crypto.createHash("sha256").update(text).digest("hex"),
    ]);
    let g = this.groups.get(key);
    if (!g) {
      if (this.groups.size >= lim.groups) {
        this.data.omittedGroups++;
        return rule;
      }
      g = {
        key,
        level,
        ruleId: rule && rule.id,
        count: 0,
        files: [],
        omittedFiles: 0,
        samples: [],
        truncated: 0,
      };
      this.groups.set(key, g);
    }
    g.count++;
    if (!g.files.includes(file)) {
      if (g.files.length < lim.files) g.files.push(file);
      else g.omittedFiles++;
    }
    if (g.samples.length < lim.samples)
      g.samples.push({
        message: message.slice(0, lim.messageLength),
        file,
        origin: origin && origin.slice(0, lim.messageLength),
      });
    if (message.length > lim.messageLength) g.truncated++;
    return rule;
  }
  snapshot(): Snapshot {
    return {
      ...this.data,
      groups: Array.from(this.groups.values()).sort((a, b) =>
        a.key.localeCompare(b.key)
      ),
      usedRules: Array.from(this.used).sort(),
    };
  }
}
