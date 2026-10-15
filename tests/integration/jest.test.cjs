const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const {runJest}=require('./process.cjs');
function run(dir,args=[]) {return runJest(dir,['--config',path.join(dir,'jest.config.cjs'),...args]);}
for (const verbose of [false, true])
  for (const parallel of [false, true])
    test(`Jest integration verbose=${verbose} workers=${parallel}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-jest-"));
      try {
        const config = path.join(dir, "audit.json");
        fs.writeFileSync(
          config,
          JSON.stringify({
            schemaVersion: 1,
            rules: [
              {
                id: "known",
                label: "Known",
                reason: "Negative case",
                levels: ["warn"],
                match: { exact: "EXPECTED_RAW" },
              },
            ],
            jsonReport: "report.json",
          })
        );
        fs.writeFileSync(
          path.join(dir, "jest.config.cjs"),
          "module.exports=" +
            JSON.stringify({
              rootDir: dir,
              testEnvironment: path.join(root, "dist/environments/node.js"),
              testEnvironmentOptions: { consoleAudit: { configFile: config } },
              reporters: [
                "default",
                [path.join(root, "dist/reporter.js"), { configFile: config }],
              ],
              verbose,
              maxWorkers: 2,
            })
        );
        for (const name of ["a", "b"])
          fs.writeFileSync(
            path.join(dir, name + ".test.js"),
            "test('console',async()=>{for(let i=0;i<100;i++)console.warn('EXPECTED_RAW');console.warn('UNEXPECTED_RAW');await new Promise(r=>setTimeout(r,100));});"
          );
        const result = await run(dir, parallel ? [] : ["--runInBand"]);
        assert.equal(result.code, 0, result.text);
        const report = JSON.parse(
          fs.readFileSync(path.join(dir, "report.json"))
        );
        assert.equal(report.totals.expected, 200);
        assert.equal(report.totals.unexpected, 2);
        assert.equal(report.status, "complete");
        assert.equal((result.text.match(/console.warn/g) || []).length, 2);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
