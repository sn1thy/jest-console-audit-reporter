import { load, limits, levels, stripAnsi } from "./core";
import { AuditReport, Snapshot, Group } from "./types";
import { atomic, createRun, channel, cleanupStale } from "./transport";
const fs = require("fs");
const path = require("path");
const safe = (s: string) =>
  stripAnsi(s).replace(/::/g, ": :").replace(/\r/g, "");
// Error arguments can include their own stack in Jest's formatted message.
// Only simplify terminal summaries; retained JSON samples remain unchanged.
const summaryMessage = (message: string) =>
  stripAnsi(message).split("\n").filter(line => !/^\s+at\s/.test(line)).join("\n").trimEnd();
class Reporter {
  private config: any;
  private run: any;
  private error?: Error;
  private expected = new Set<string>();
  private session: any;
  constructor(private globalConfig: any, private options: any) {
    this.config = load(options.configFile);
    if (globalConfig.silent)
      throw Error("Remove --silent to use console audit");
    cleanupStale();
    this.session = createRun(options.configFile);
    process.env[channel] = JSON.stringify({
      manifest: path.join(this.session.dir, "manifest"),
    });
    process.once("exit", () =>
      fs.rmSync(this.session.dir, { recursive: true, force: true })
    );
  }
  onRunStart(): void {
    this.error = undefined;
    this.expected.clear();
    this.config = load(this.options.configFile);
    this.run = {
      ...createRun(this.options.configFile, this.session.dir),
      config: this.config,
    };
    atomic(path.join(this.session.dir, "manifest"), this.run);
  }
  onTestStart(test: any): void {
    this.expected.add(test.path);
  }
  onRunComplete(_contexts: any, results: any): void {
    const health: string[] = [];
    const seen = new Set<string>();
    const captured = new Set<string>();
    const groups = new Map<string, Group>();
    const affected = new Set<string>();
    const used = new Set<string>();
    const totals: Snapshot = {
      total: 0,
      expected: 0,
      unexpected: 0,
      levels: { log: 0, info: 0, debug: 0, warn: 0, error: 0 },
      groups: [],
      omittedGroups: 0,
      usedRules: [],
    };
    const lim = limits(this.config);
    try {
      for (const file of fs
        .readdirSync(this.run.dir)
        .filter((f: string) => f.endsWith(".json"))
        .sort()) {
        try {
          const r = JSON.parse(
            fs.readFileSync(path.join(this.run.dir, file), "utf8")
          );
          if (
            r.schemaVersion !== 1 ||
            r.runId !== this.run.id ||
            seen.has(r.id)
          )
            throw Error("Invalid or duplicate execution record");
          seen.add(r.id);
          captured.add(r.testPath);
          if (r.complete !== true || r.failed)
            health.push("Partial capture: " + r.testPath);
          const s: Snapshot = r.snapshot;
          if (
            !s ||
            !Array.isArray(s.groups) ||
            !Array.isArray(s.usedRules) ||
            !s.levels
          )
            throw Error("Invalid snapshot");
          for (const value of [
            s.total,
            s.expected,
            s.unexpected,
            s.omittedGroups,
            ...levels.map((l) => s.levels[l]),
          ])
            if (!Number.isSafeInteger(value) || value < 0)
              throw Error("Invalid snapshot count");
          if (
            s.total !== s.expected + s.unexpected ||
            s.total !== levels.reduce((n, l) => n + s.levels[l], 0)
          )
            throw Error("Inconsistent snapshot totals");
          for (const g of s.groups)
            if (
              !g ||
              typeof g.key !== "string" ||
              !levels.includes(g.level) ||
              !Number.isSafeInteger(g.count) ||
              g.count < 1 ||
              !Array.isArray(g.files) ||
              !Array.isArray(g.samples)
            )
              throw Error("Invalid group");
          if (s.total > 0) affected.add(r.testPath);
          for (const key of [
            "total",
            "expected",
            "unexpected",
            "omittedGroups",
          ] as const)
            totals[key] += s[key];
          for (const l of levels) totals.levels[l] += s.levels[l];
          s.usedRules.forEach((id) => used.add(id));
          for (const g of s.groups) {
            const old = groups.get(g.key);
            if (old) {
              old.count += g.count;
              old.truncated += g.truncated;
              old.omittedFiles += g.omittedFiles;
              for (const f of g.files)
                if (!old.files.includes(f)) {
                  if (old.files.length < lim.files) old.files.push(f);
                  else old.omittedFiles++;
                }
              old.samples.push(
                ...g.samples.slice(
                  0,
                  Math.max(0, lim.samples - old.samples.length)
                )
              );
            } else if (groups.size < lim.groups) groups.set(g.key, g);
            else totals.omittedGroups += g.count;
          }
        } catch (e) {
          health.push("Unreadable capture " + file + ": " + String(e));
        }
      }
      for (const file of this.expected)
        if (!captured.has(file))
          health.push("Missing audit environment: " + file);
      if (results.wasInterrupted) health.push("Jest run interrupted");
      totals.groups = Array.from(groups.values()).sort((a, b) =>
        a.key.localeCompare(b.key)
      );
      for (const g of totals.groups) {
        g.files.sort();
        g.samples.sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b))
        );
      }
      totals.usedRules = Array.from(used).sort();
      const report: AuditReport = {
        schemaVersion: 1,
        runId: this.run.id,
        status: health.length ? "incomplete" : "complete",
        interrupted: !!results.wasInterrupted,
        includesRetries: true,
        health,
        capture: {
          executions: seen.size,
          scheduledFiles: this.expected.size,
          capturedFiles: captured.size,
          affectedFiles: affected.size,
        },
        totals,
        rules: this.config.rules,
        unusedRules: this.config.rules
          .filter((r: any) => !used.has(r.id))
          .map((r: any) => r.id),
        limits: lim,
      };
      process.stderr.write(this.render(report));
      if (this.config.jsonReport)
        atomic(
          path.resolve(
            path.dirname(this.options.configFile),
            this.config.jsonReport
          ),
          report
        );
      if (health.length || (this.config.failOnUnexpected && totals.unexpected))
        this.error = Error(
          health.length
            ? "Console audit incomplete"
            : "Unexpected console messages"
        );
    } catch (e) {
      this.error = Error("Console audit failed: " + String(e));
      process.stderr.write(this.error.message + "\n");
    } finally {
      try {
        fs.rmSync(this.run.dir, { recursive: true, force: true });
      } catch (e) {
        this.error = Error("Console audit cleanup failed: " + String(e));
        process.stderr.write(this.error.message + "\n");
      }
    }
  }
  private render(r: AuditReport): string {
    const colorEnabled = process.env.NO_COLOR === undefined && (
      process.env.FORCE_COLOR !== undefined
        ? !["0", "false"].includes(process.env.FORCE_COLOR)
        : !!process.stderr.isTTY && process.env.TERM !== "dumb"
    );
    const paint = (text: string, code: string) =>
      colorEnabled ? "\u001b[" + code + "m" + text + "\u001b[0m" : text;
    const lines = [
      "\nConsole audit: " +
        r.totals.total +
        " messages; " +
        r.totals.expected +
        " expected; " +
        r.totals.unexpected +
        " unexpected (includes retries)",
      "Levels: " + levels.map((l) => l + " " + r.totals.levels[l]).join(", "),
    ];
    const gha =
      this.config.display?.githubActions === "on" ||
      (this.config.display?.githubActions !== "off" &&
        process.env.GITHUB_ACTIONS === "true");
    for (const expected of [false, true]) {
      lines.push(expected ? "Expected messages" : "Possible flaws");
      if (expected && gha)
        lines.push("::group::Expected console message details");
      for (const g of r.totals.groups.filter((g) => !!g.ruleId === expected)) {
        const rule = r.rules.find((x) => x.id === g.ruleId);
        if (expected) {
          const message = summaryMessage(g.samples[0]?.message || "").replace(/\s*\n\s*/g, " ");
          lines.push("  " + g.level.toUpperCase() + "\tx" + g.count + "\t" + message);
          continue;
        }
        lines.push(
          "  " +
            g.level.toUpperCase() +
            " " +
            (rule ? rule.label + " [" + rule.id + "]" : summaryMessage(g.samples[0]?.message || "")) +
            " — " +
            g.count +
            " occurrences in " +
            g.files.length +
            " retained files"
        );
        if (rule) lines.push("    Reason: " + rule.reason);
        const messages = [...new Set(g.samples.map(s => summaryMessage(s.message)))];
        for (const message of messages.slice(
          rule ? 0 : 1,
          this.config.display?.detail === "detailed" ? undefined : 1
        )) lines.push("    " + message.replace(/\n/g, "\n    "));
        if (this.config.display?.detail === "detailed")
          lines.push("    Files: " + g.files.join(", "));
        if (g.truncated || g.omittedFiles)
          lines.push(
            "    Truncated messages: " +
              g.truncated +
              "; omitted file occurrences: " +
              g.omittedFiles
          );
      }
      if (expected && gha) lines.push("::endgroup::");
    }
    lines.push(
      "Retained groups: " + r.totals.groups.length,
      "Affected files: " +
        r.capture.affectedFiles +
        "; captured executions: " +
        r.capture.executions,
      "Unused rules: " + (r.unusedRules.join(", ") || "none"),
      "Omitted group occurrences: " + r.totals.omittedGroups,
      "Capture: " + r.status,
      ...r.health
    );
    return (
      lines
        .map((l) => {
          if (l === "::group::Expected console message details" || l === "::endgroup::") return l;
          // Sanitize user content before applying our own terminal styling.
          const text = safe(l);
          if (l.startsWith("\nConsole audit:")) return paint(text, "1;36");
          if (l === "Possible flaws") return paint(text, "1;33");
          if (l === "Expected messages") return paint(text, "1;32");
          if (l.startsWith("Capture: ")) return paint(text, r.status === "complete" ? "32" : "1;31");
          if (r.health.includes(l)) return paint(text, "31");
          const levelColors: Record<string, string> = { ERROR: "31", WARN: "33", INFO: "36", LOG: "34", DEBUG: "35" };
          if (/^  (ERROR|WARN|INFO|LOG|DEBUG)[ \t]/.test(text))
            return text.replace(/^(  )(ERROR|WARN|INFO|LOG|DEBUG)([ \t])/, (_, indent, level, space) => indent + paint(level, "1;" + levelColors[level]) + space)
              .replace(/ — \d+ occurrences in \d+ retained files$/, suffix => paint(suffix, "2"));
          if (/^(Levels:|Retained groups:|Affected files:|Unused rules:|Omitted group occurrences:|    (Reason:|Files:|Truncated messages:))/.test(text)) return paint(text, "2");
          return text;
        })
        .join("\n") + "\n"
    );
  }
  getLastError(): Error | undefined {
    return this.error;
  }
}
export = Reporter;
