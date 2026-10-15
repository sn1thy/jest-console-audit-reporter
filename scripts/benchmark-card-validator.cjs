// End-to-end wall time, including Jest startup, coverage, output and audit JSON.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
const consumer = path.resolve(root, '../card-validator-console-audit');
const argv = process.argv.slice(2);
const pairsArg = argv.find(a => a.startsWith('--pairs='));
const pairs = pairsArg ? Number(pairsArg.split('=')[1]) : 5;
assert.ok(Number.isInteger(pairs) && pairs >= 3 && pairs <= 50, '--pairs must be 3..50');
assert.ok(argv.every(a => a === '--workers' || a.startsWith('--pairs=')), 'Options: --pairs=5 --workers');
const artifacts = path.join(root, 'artifacts', `benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(artifacts, { recursive: true });
const base = require(path.join(consumer, 'package.json')).jest;
const jestVersion = require(path.join(consumer, 'node_modules/jest/package.json')).version;
const reporterManifest = require(path.join(consumer, 'node_modules/jest-console-audit-reporter/package.json'));
assert.equal(jestVersion, reporterManifest.peerDependencies.jest);
const scenarioConfig = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/card-validator-scenarios/full-suite-workers.config.json')));
const median = values => { const s = [...values].sort((a,b) => a-b); const m = Math.floor(s.length/2); return s.length % 2 ? s[m] : (s[m-1] + s[m])/2; };
const stats = values => ({ median: median(values), min: Math.min(...values), max: Math.max(...values) });
async function run(workload, mode, audit, iteration) {
  const label = `${workload}-${mode}-${audit ? 'audit' : 'baseline'}-${iteration}`;
  const resultFile = path.join(artifacts, `${label}.results.json`);
  const reportFile = path.join(artifacts, `${label}.audit.json`);
  const auditFile = path.join(artifacts, `${label}.audit-config.json`);
  const configFile = path.join(artifacts, `${label}.jest.cjs`);
  const logFile = path.join(artifacts, `${label}.log`);
  const noisy = workload === 'console-scenarios';
  const config = { ...base, rootDir: consumer, verbose: false, silent: false, reporters: ['default'],
    // Isolate and warm each environment's transform cache equally.
    cacheDirectory: path.join(artifacts, `cache-${workload}-${audit ? 'audit' : 'baseline'}`),
    ...(noisy ? { setupFiles: [...(base.setupFiles || []), path.join(consumer, 'console-audit-scenarios.setup.cjs')] } : { testPathIgnorePatterns: [...(base.testPathIgnorePatterns || []), '/console-audit-scenarios/'] }),
  };
  if (audit) {
    fs.writeFileSync(auditFile, JSON.stringify({ ...scenarioConfig, rules: noisy ? scenarioConfig.rules : [], failOnUnexpected: false, display: { detail: 'compact', githubActions: 'off' }, jsonReport: reportFile }));
    config.testEnvironment = require.resolve('jest-console-audit-reporter/environment/jsdom', { paths: [consumer] });
    config.testEnvironmentOptions = { ...base.testEnvironmentOptions, consoleAudit: { configFile: auditFile } };
    config.reporters.push([require.resolve('jest-console-audit-reporter/reporter', { paths: [consumer] }), { configFile: auditFile }]);
  }
  fs.writeFileSync(configFile, 'module.exports=' + JSON.stringify(config));
  const fd = fs.openSync(logFile, 'w');
  const start = performance.now();
  const child = spawn(process.execPath, [path.join(consumer, 'node_modules/jest/bin/jest.js'), '--config', configFile, mode === 'serial' ? '--runInBand' : '--maxWorkers=2', '--json', '--outputFile', resultFile], { cwd: consumer, stdio: ['ignore', fd, fd], env: { ...process.env, CI: 'true', FORCE_COLOR: '0' } });
  fs.closeSync(fd);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timeout); }
  const milliseconds = performance.now() - start;
  assert.equal(code, 0, `Failed benchmark run: ${logFile}`);
  const results = JSON.parse(fs.readFileSync(resultFile));
  assert.equal(results.numPassedTests, noisy ? 595 : 580);
  assert.equal(results.numTotalTestSuites, noisy ? 15 : 11);
  assert.equal(results.numFailedTests, 0);
  if (noisy) {
    const output = fs.readFileSync(logFile, 'utf8');
    assert.ok(output.includes(audit ? 'AUDIT_ERROR_OBJECT' : 'AUDIT_REPEAT'), `Console output missing; benchmark is invalid in this environment: ${logFile}`);
  }
  if (audit) {
    const report = JSON.parse(fs.readFileSync(reportFile));
    assert.equal(report.status, 'complete');
    assert.deepEqual(report.health, []);
    assert.equal(report.totals.expected, noisy ? 139 : 0);
    assert.equal(report.totals.unexpected, noisy ? 6 : 0);
  }
  // Compare individual test outcomes, not just aggregate totals.
  const outcomes = results.testResults.flatMap(file => file.assertionResults.map(t => [file.name, t.fullName, t.status])).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { label, milliseconds, logBytes: fs.statSync(logFile).size, outcomes };
}
(async () => {
  const comparisons = [];
  for (const workload of ['quiet', 'console-scenarios']) for (const mode of (argv.includes('--workers') ? ['serial', 'workers'] : ['serial'])) {
    console.log(`Warming ${workload}/${mode} (excluded from results)...`);
    const warmBaseline = await run(workload, mode, false, 'warmup');
    const warmAudit = await run(workload, mode, true, 'warmup');
    assert.deepEqual(warmAudit.outcomes, warmBaseline.outcomes);
    const samples = [];
    for (let i=0; i<pairs; i++) {
      const order = i % 2 ? [true, false] : [false, true];
      const measured = {};
      for (const audit of order) measured[audit ? 'audit' : 'baseline'] = await run(workload, mode, audit, i+1);
      assert.deepEqual(measured.audit.outcomes, measured.baseline.outcomes);
      const { baseline, audit } = measured;
      samples.push({ pair: i+1, order: order.map(v => v ? 'audit' : 'baseline'), baselineMs: baseline.milliseconds, auditMs: audit.milliseconds, deltaMs: audit.milliseconds-baseline.milliseconds, deltaPercent: 100*(audit.milliseconds/baseline.milliseconds-1), baselineLogBytes: baseline.logBytes, auditLogBytes: audit.logBytes });
      console.log(`${workload}/${mode} pair ${i+1}/${pairs}: baseline ${(baseline.milliseconds/1000).toFixed(3)}s; audit ${(audit.milliseconds/1000).toFixed(3)}s`);
    }
    comparisons.push({ workload, mode, baselineMs: stats(samples.map(s => s.baselineMs)), auditMs: stats(samples.map(s => s.auditMs)), pairedDeltaMs: stats(samples.map(s => s.deltaMs)), pairedDeltaPercent: stats(samples.map(s => s.deltaPercent)), baselineLogBytes: median(samples.map(s => s.baselineLogBytes)), auditLogBytes: median(samples.map(s => s.auditLogBytes)), samples });
  }
  const summary = { status: 'passed', node: process.version, jest: jestVersion, reporter: reporterManifest.version, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, platform: `${os.platform()} ${os.release()}`, pairs, methodology: 'Fresh Jest process per run, one excluded warmup per variant, alternating paired order, warm transform caches, coverage enabled, silent=false, default reporter retained, compact audit summary and JSON enabled; wall time includes startup and file-backed output. Test outcomes and audit counts validated. No terminal rendering, cold-cache comparison, or statistical confidence claim.', comparisons };
  fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2));
  let markdown = `# Braintree runtime benchmark\n\nNode ${process.version}; Jest ${jestVersion}; ${pairs} measured pairs per workload.\n\n${summary.methodology}\n\n| Workload | Mode | Baseline median | Audit median | Paired median delta | Paired median change |\n|---|---|---:|---:|---:|---:|\n`;
  for (const c of comparisons) markdown += `| ${c.workload} | ${c.mode} | ${(c.baselineMs.median/1000).toFixed(3)} s | ${(c.auditMs.median/1000).toFixed(3)} s | ${c.pairedDeltaMs.median.toFixed(1)} ms | ${c.pairedDeltaPercent.median.toFixed(1)}% |\n`;
  fs.writeFileSync(path.join(artifacts, 'report.md'), markdown);
  console.log(markdown + `\nEvidence: ${artifacts}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
