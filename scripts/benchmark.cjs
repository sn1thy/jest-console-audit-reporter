// Adapter-only diagnostic; not a Jest end-to-end performance claim.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { wrapEnvironment } = require("../dist/environments/factory");
const { createRun, channel } = require("../dist/transport");
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-benchmark-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      rules: [
        {
          id: "expected",
          label: "Expected",
          reason: "Benchmark",
          levels: ["log"],
          match: { substring: "message" },
        },
      ],
      limits: { groups: 100, samples: 1 },
    })
  );
  const write = process.stdout.write;
  const old = process.env[channel];
  let results = [];
  try {
    for (const mode of ["no-log", "repeated", "high-cardinality"]) {
      const run = createRun(file);
      process.env[channel] = JSON.stringify(run);
      const c = {
        _log() {},
        log(s) {
          this._log("log", s);
        },
      };
      class Base {
        async teardown() {}
      }
      const Env = wrapEnvironment(Base);
      const start = performance.now();
      const env = new Env(
        {
          globalConfig: {},
          projectConfig: {
            rootDir: dir,
            testEnvironmentOptions: { consoleAudit: { configFile: file } },
          },
        },
        { console: c, testPath: path.join(dir, "bench.test.js") }
      );
      process.stdout.write = () => true;
      for (let i = 0; i < 1000; i++) {
        if (mode === "repeated") c.log("message");
        else if (mode === "high-cardinality") c.log("unique " + i);
      }
      await env.teardown();
      results.push({
        mode,
        iterations: 1000,
        milliseconds: +(performance.now() - start).toFixed(2),
      });
      fs.rmSync(run.dir, { recursive: true, force: true });
    }
  } finally {
    process.stdout.write = write;
    if (old === undefined) delete process.env[channel];
    else process.env[channel] = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        scope: "adapter-only; output sink; no Jest runner",
        results,
      },
      null,
      2
    )
  );
})();
