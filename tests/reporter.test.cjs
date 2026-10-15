const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Reporter = require("../dist/reporter");
const { Aggregate } = require("../dist/core");
const { atomic, channel, readRun } = require("../dist/transport");
function fixture(config = { schemaVersion: 1, rules: [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-reporter-test-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ ...config, jsonReport: "report.json" })
  );
  const old = process.env[channel];
  const write = process.stderr.write;
  let output = "";
  process.stderr.write = (s) => {
    output += s;
    return true;
  };
  const reporter = new Reporter({}, { configFile: file });
  return {
    dir,
    file,
    reporter,
    output: () => output,
    finish() {
      process.stderr.write = write;
      if (old === undefined) delete process.env[channel];
      else process.env[channel] = old;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
function record(f, complete = true, message = "unexpected", origin) {
  const run = readRun(f.file);
  const a = new Aggregate({ schemaVersion: 1, rules: [] });
  a.add("warn", message, "a.test.js", origin);
  atomic(path.join(run.dir, "execution.json"), {
    schemaVersion: 1,
    runId: run.id,
    id: "execution",
    testPath: path.join(f.dir, "a.test.js"),
    complete,
    snapshot: a.snapshot(),
  });
}
test("summaries omit captured and Error stacks but JSON keeps the diagnostics", () => {
  for (const detail of ['compact', 'detailed']) {
    const f = fixture({schemaVersion: 1, rules: [], display: {detail}});
    try {
      f.reporter.onRunStart();
      f.reporter.onTestStart({path: path.join(f.dir, 'a.test.js')});
      const message = 'Error: meaningful failure\n    at errorSite (/app/error.js:4:2)\nUseful additional context';
      const origin = 'at consoleSite (/app/caller.js:5:3)';
      record(f, true, message, origin);
      f.reporter.onRunComplete(null, {});
      assert.ok(f.output().includes('Error: meaningful failure'));
      assert.ok(f.output().includes('Useful additional context'));
      assert.ok(!f.output().includes('errorSite'));
      assert.ok(!f.output().includes('consoleSite'));
      assert.equal((f.output().match(/meaningful failure/g) || []).length, 1);
      const sample = JSON.parse(fs.readFileSync(path.join(f.dir, 'report.json'))).totals.groups[0].samples[0];
      assert.equal(sample.message, message);
      assert.equal(sample.origin, origin);
    } finally { f.finish(); }
  }
});
test("reporter merges, reports JSON and observational mode preserves exit", () => {
  const f = fixture();
  try {
    f.reporter.onRunStart();
    f.reporter.onTestStart({ path: path.join(f.dir, "a.test.js") });
    record(f);
    f.reporter.onRunComplete(null, {});
    const r = JSON.parse(fs.readFileSync(path.join(f.dir, "report.json")));
    assert.equal(r.status, "complete");
    assert.equal(r.totals.unexpected, 1);
    assert.equal(f.reporter.getLastError(), undefined);
    assert.ok(f.output().includes("Possible flaws"));
  } finally {
    f.finish();
  }
});
test("strict, partial and missing environment fail", () => {
  for (const mode of ["strict", "partial", "missing"]) {
    const f = fixture({
      schemaVersion: 1,
      rules: [],
      failOnUnexpected: mode === "strict",
    });
    try {
      f.reporter.onRunStart();
      f.reporter.onTestStart({ path: path.join(f.dir, "a.test.js") });
      if (mode !== "missing") record(f, mode !== "partial");
      f.reporter.onRunComplete(null, {});
      assert.ok(f.reporter.getLastError());
      const r = JSON.parse(fs.readFileSync(path.join(f.dir, "report.json")));
      assert.equal(r.status, mode === "strict" ? "complete" : "incomplete");
    } finally {
      f.finish();
    }
  }
});
test("watch session manifest resets run IDs and totals; summary neutralizes commands", () => {
  const f = fixture({
    schemaVersion: 1,
    rules: [],
    display: { githubActions: "on" },
  });
  try {
    f.reporter.onRunStart();
    const descriptor = process.env[channel];
    const first = readRun(f.file).id;
    record(f, true, "::endgroup::\n::error::evil");
    f.reporter.onRunComplete(null, {});
    assert.ok(!f.output().includes("\n::error::evil"));
    f.reporter.onRunStart();
    assert.equal(process.env[channel], descriptor);
    assert.notEqual(readRun(f.file).id, first);
    f.reporter.onRunComplete(null, {});
    const r = JSON.parse(fs.readFileSync(path.join(f.dir, "report.json")));
    assert.equal(r.totals.total, 0);
    assert.equal((f.output().match(/^::group::/gm) || []).length, 2);
    assert.equal((f.output().match(/^::endgroup::/gm) || []).length, 2);
  } finally {
    f.finish();
  }
});
test("silent and mismatched companion config reject", () => {
  const f = fixture();
  try {
    assert.throws(
      () => new Reporter({ silent: true }, { configFile: f.file }),
      /silent/
    );
    assert.throws(() => readRun("/other.json"));
  } finally {
    f.finish();
  }
});
