const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
export const channel = "JEST_CONSOLE_AUDIT_RUN";
/** Bounded cleanup only removes old directories owned by a dead local process. */
export function cleanupStale(): void {
  const base = os.tmpdir();
  for (const name of fs
    .readdirSync(base)
    .filter((n: string) => n.startsWith("jest-console-audit-"))
    .sort()
    .slice(0, 128)) {
    const dir = path.join(base, name);
    try {
      const stat = fs.lstatSync(dir);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (process.getuid && stat.uid !== process.getuid())
      )
        continue;
      const owner = JSON.parse(
        fs.readFileSync(path.join(dir, "owner"), "utf8")
      );
      if (
        owner.host !== os.hostname() ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1 ||
        !Number.isFinite(owner.created) ||
        Date.now() - owner.created < 86400000
      )
        continue;
      try {
        process.kill(owner.pid, 0);
        continue;
      } catch (e) {
        if ((e as any).code !== "ESRCH") continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* Never delete unrecognized or unreadable directories. */
    }
  }
}
export function createRun(configFile: string, parent?: string) {
  const dir = fs.mkdtempSync(
    path.join(parent || os.tmpdir(), "jest-console-audit-")
  );
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(
    path.join(dir, "owner"),
    JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      created: Date.now(),
    }),
    { mode: 0o600 }
  );
  return { dir, id: crypto.randomUUID(), configFile };
}
export function atomic(file: string, data: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export function readRun(configFile: string): any {
  const raw = process.env[channel];
  if (!raw)
    throw Error("Console audit environment requires its companion reporter");
  const descriptor = JSON.parse(raw);
  const run = descriptor.manifest
    ? JSON.parse(fs.readFileSync(descriptor.manifest, "utf8"))
    : descriptor;
  if (run.configFile !== configFile)
    throw Error("Environment and reporter must use the same configFile");
  return run;
}
