import { Aggregate, load, levels, validate } from "../core";
import { atomic, readRun } from "../transport";
const path = require("path");
const crypto = require("crypto");
/** Jest 30 adapter: mutate the runner-owned console; retain its _log freeze hook. */
export function wrapEnvironment<T extends new (...args: any[]) => any>(
  Base: T
): T {
  const Parent: any = Base;
  return (class AuditEnvironment extends Parent {
    private flushAudit: (complete: boolean) => void;
    constructor(config: any, context: any) {
      super(config, context);
      if (config.projectConfig.silent ?? config.globalConfig.silent)
        throw Error(
          "Console audit is incompatible with --silent; remove silent"
        );
      const file =
        config.projectConfig.testEnvironmentOptions.consoleAudit?.configFile;
      if (!file || !path.isAbsolute(file))
        throw Error("consoleAudit.configFile must be absolute");
      const run = readRun(file);
      const audit = run.config ? validate(run.config) : load(file);
      const id = crypto.randomUUID();
      const testFile = path
        .relative(config.projectConfig.rootDir, context.testPath)
        .split(path.sep)
        .join("/");
      const aggregate = new Aggregate(audit);
      const target = context.console;
      if (
        typeof target?._log !== "function" ||
        typeof target?.getBuffer !== "function"
      )
        throw Error(
          "Unsupported Jest console adapter; this alpha requires Jest 30.5.2"
        );
      const record = path.join(run.dir, id + ".json");
      let failed = false;
      this.flushAudit = (complete) => {
        try {
          atomic(record, {
            schemaVersion: 1,
            runId: run.id,
            id,
            testPath: context.testPath,
            complete,
            failed,
            snapshot: aggregate.snapshot(),
          });
        } catch (e) {
          failed = true;
          process.stderr.write(
            "Console audit transport failed: " + String(e) + "\n"
          );
        }
      };
      this.flushAudit(false);
      const stdout = config.globalConfig.useStderr
        ? process.stderr
        : process.stdout;
      const originalLog = target._log;
      const originalError = target._logError;
      const emit = (type: string, message: string) => {
        if (!levels.includes(type as any)) {
          if (originalError && ["assert"].includes(type))
            originalError.call(target, type, message);
          else if (originalError) originalLog.call(target, type, message);
          else stdout.write(message + "\n");
          return;
        }
        const stack =
          String(new Error().stack || "")
            .split("\n")
            .filter(
              (s: string) =>
                !s.includes(__dirname + "/") &&
                !s.includes("node:") &&
                !s.includes("/@jest/console/")
            )
            .slice(1)
            .join("\n")
            .trim() || undefined;
        let live = true;
        try {
          const r = aggregate.add(type as any, message, testFile, stack);
          live = !r || !!r.live;
          this.flushAudit(false);
        } catch (e) {
          failed = true;
          process.stderr.write(
            "Console audit capture failed: " + String(e) + "\n"
          );
        }
        if (live || failed)
          stdout.write(
            "  console." +
              type +
              "\n    " +
              ("  ".repeat(target._groupDepth || 0) + message).replace(
                /\n/g,
                "\n    "
              ) +
              "\n" +
              (stack ? "    " + stack + "\n" : "")
          );
      };
      // BufferedConsole methods call _log; CustomConsole errors call _logError.
      target._log = emit;
      target._logError = (type: string, message: string) => {
        if (target._log !== emit) return target._log(type, message);
        return emit(type, message);
      };
      target.getBuffer = () => undefined;
    }
    async teardown(): Promise<void> {
      let complete = false;
      try {
        await super.teardown();
        complete = true;
      } finally {
        this.flushAudit(complete);
      }
    }
  } as unknown) as T;
}
