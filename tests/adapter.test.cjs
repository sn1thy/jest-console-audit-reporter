const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const { wrapEnvironment } = require("../dist/environments/factory");
const { createRun, channel } = require("../dist/transport");
test("project silent setting takes precedence over the global setting", () => {
  class Base {}
  const Env = wrapEnvironment(Base);
  assert.throws(() => new Env({ globalConfig: {silent: false}, projectConfig: {silent: true} }, {}), /incompatible with --silent/);
  assert.throws(() => new Env({ globalConfig: {silent: true}, projectConfig: {silent: false, testEnvironmentOptions: {}} }, {}), /configFile must be absolute/);
  assert.throws(() => new Env({ globalConfig: {silent: true}, projectConfig: {} }, {}), /incompatible with --silent/);
});
test("runner-owned console suppresses only expected messages, survives freeze and writes final record", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      rules: [
        {
          id: "known",
          label: "Known",
          reason: "Intentional",
          levels: ["warn"],
          match: { exact: "known" },
        },
      ],
    })
  );
  const run = createRun(file);
  const prev = process.env[channel];
  process.env[channel] = JSON.stringify(run);
  let output = "";
  const write = process.stdout.write;
  process.stdout.write = (s) => {
    output += s;
    return true;
  };
  try {
    const c = {
      _log() {
        throw Error("buffer replay");
      },
      warn(...args) {
        this._log("warn", util.format(...args));
      },
      getBuffer() {
        return ["bad"];
      },
    };
    class Base {
      async teardown() {}
    }
    const Env = wrapEnvironment(Base);
    const env = new Env(
      {
        globalConfig: {},
        projectConfig: {
          rootDir: dir,
          testEnvironmentOptions: { consoleAudit: { configFile: file } },
        },
      },
      { console: c, testPath: path.join(dir, "a.test.js") }
    );
    for (let i = 0; i < 100; i++) c.warn("known");
    c.warn("unexpected %s", "value");
    assert.ok(output.includes("unexpected value"));
    assert.ok(!output.includes("known"));
    assert.equal(c.getBuffer(), undefined);
    let frozen = 0;
    c._log = () => frozen++;
    c.warn("late");
    assert.equal(frozen, 1);
    await env.teardown();
    const record = JSON.parse(
      fs.readFileSync(
        path.join(
          run.dir,
          fs.readdirSync(run.dir).find((f) => f.endsWith(".json"))
        )
      )
    );
    assert.equal(record.snapshot.expected, 100);
    assert.equal(record.snapshot.unexpected, 1);
    assert.ok(record.complete);
  } finally {
    process.stdout.write = write;
    if (prev === undefined) delete process.env[channel];
    else process.env[channel] = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(run.dir, { recursive: true, force: true });
  }
});
