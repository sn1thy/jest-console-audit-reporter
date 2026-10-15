const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
async function fixture(source, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-lifecycle-"));
  let output = "";
  let unexpectedBeforeDone = false;
  try {
    const configFile = path.join(dir, "audit.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        schemaVersion: 1,
        rules: [
          {
            id: "expected",
            label: "Expected case",
            reason: "Intentional fixture",
            levels: ["warn"],
            match: { exact: "EXPECTED" },
          },
        ],
        jsonReport: "report.json",
        ...options.audit,
      })
    );
    const config = {
      rootDir: dir,
      testEnvironment: path.join(
        root,
        "dist/environments/" + (options.jsdom ? "jsdom" : "node") + ".js"
      ),
      testEnvironmentOptions: { consoleAudit: { configFile } },
      reporters: [
        "default",
        [path.join(root, "dist/reporter.js"), { configFile }],
      ],
      ...options.jest,
    };
    if (options.unpaired)
      config.testEnvironment = require.resolve("jest-environment-node");
    const configPath = path.join(
      dir,
      options.esm ? "jest.config.mjs" : "jest.config.cjs"
    );
    fs.writeFileSync(
      configPath,
      (options.esm ? "export default " : "module.exports=") +
        JSON.stringify(config)
    );
    if (options.setup) {
      const setup = path.join(dir, "setup.cjs");
      fs.writeFileSync(setup, options.setup);
      config.setupFiles = [setup];
      fs.writeFileSync(
        configPath,
        (options.esm ? "export default " : "module.exports=") +
          JSON.stringify(config)
      );
    }
    fs.writeFileSync(path.join(dir, "a.test.js"), source);
    const raw = await require('./process.cjs').runJest(dir,['--config',configPath,'--runInBand']);
    const result = {code:raw.code,output:raw.text,unexpectedBeforeDone:raw.unexpectedBeforeDone,report:fs.existsSync(path.join(dir,'report.json'))?JSON.parse(fs.readFileSync(path.join(dir,'report.json'))):null};
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("single file unexpected output is visible before test finishes, no replay", async () => {
  const r = await fixture(
    "test('live',async()=>{console.warn('UNEXPECTED_LIVE');await new Promise(r=>setTimeout(r,200));process.stdout.write('TEST_FINISHED\\n');});"
  );
  assert.equal(r.code, 0, r.output);
  assert.ok(r.unexpectedBeforeDone, r.output);
  assert.equal((r.output.match(/console.warn/g) || []).length, 1);
  assert.equal(r.report.totals.unexpected, 1);
});
test("setup, hooks, spies, fake timers and retries retain exact occurrences", async () => {
  const r = await fixture(
    "jest.retryTimes(1);let n=0;beforeEach(()=>console.warn('EXPECTED'));test('retry',()=>{console.warn('EXPECTED');expect(++n).toBe(2);});test('spy and fake timers',()=>{jest.useFakeTimers();const spy=jest.spyOn(console,'warn');console.warn('EXPECTED');expect(spy).toHaveBeenCalled();jest.restoreAllMocks();console.warn('EXPECTED');jest.useRealTimers();});",
    { setup: "console.warn('EXPECTED');" }
  );
  assert.equal(r.code, 0, r.output);
  assert.equal(r.report.totals.expected, 8);
  assert.equal(r.report.totals.unexpected, 0);
});
test("jsdom and ESM config load", async () => {
  const r = await fixture(
    "test('dom',()=>{expect(document.createElement('div').tagName).toBe('DIV');console.warn('EXPECTED');});",
    { jsdom: true, esm: true }
  );
  assert.equal(r.code, 0, r.output);
  assert.equal(r.report.status, "complete");
  assert.equal(r.report.totals.expected, 1);
});
for (const verbose of [false, true])
  test("late logs retain native diagnostic verbose=" + verbose, async () => {
    const r = await fixture(
      "test('late',()=>{require('node:timers').setTimeout(()=>console.warn('LATE_MESSAGE'),100);});",
      { jest: { verbose } }
    );
    assert.equal(r.code, 1, r.output);
    assert.ok(r.output.includes("Cannot log after tests are done"), r.output);
  });
test("formatting supports cyclic objects, errors and printf", async () => {
  const r = await fixture(
    "test('format',()=>{const x={};x.self=x;console.warn('value %d %s',42,'text');console.error(new Error('error-case'));console.log(x);});"
  );
  assert.equal(r.code, 0, r.output);
  assert.equal(r.report.totals.total, 3);
  assert.ok(r.output.includes("value 42 text"));
  assert.ok(r.output.includes("Circular"));
  assert.ok(r.output.includes("error-case"));
});
test("strict exits nonzero and ordinary test failure is retained", async () => {
  const strict = await fixture(
    "test('strict',()=>console.error('unexpected'));",
    { audit: { failOnUnexpected: true } }
  );
  assert.equal(strict.code, 1, strict.output);
  assert.equal(strict.report.status, "complete");
  const failure = await fixture(
    "test('failure',()=>{console.warn('EXPECTED');expect(1).toBe(2);});"
  );
  assert.equal(failure.code, 1, failure.output);
  assert.equal(failure.report.totals.expected, 1);
});
test("silent and absent environment fail actionably", async () => {
  const silent = await fixture("test('silent',()=>{});", {
    jest: { silent: true },
  });
  assert.equal(silent.code, 1, silent.output);
  assert.ok(silent.output.includes("silent"));
  const missing = await fixture("test('missing',()=>{});", { unpaired: true });
  assert.equal(missing.code, 1, missing.output);
  assert.equal(missing.report.status, "incomplete");
  assert.ok(
    missing.report.health.some((s) => s.includes("Missing audit environment"))
  );
});
