const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const consumer = path.resolve(root, '../card-validator-console-audit');
const artifacts = path.join(root, 'artifacts/card-validator-scenarios');
fs.mkdirSync(artifacts, { recursive: true });
fs.rmSync(path.join(artifacts, 'summary.json'), { force: true });
const fixtureDir = path.join(consumer, 'src/__tests__/console-audit-scenarios');
const rule = (id, match, levels = ['warn'], extra = {}) => ({ id, label: id, reason: 'Intentional external consumer scenario', levels, match, ...extra });
const matchingFile = ['**/console-audit-scenarios/matching.test.ts'];
const rules = [
  rule('setup', { exact: 'AUDIT_SETUP' }),
  rule('levels', { exact: 'AUDIT_LEVEL' }, ['log', 'info', 'debug', 'warn', 'error'], { testFiles: matchingFile }),
  rule('repeat', { exact: 'AUDIT_REPEAT' }),
  rule('ansi', { exact: 'AUDIT_ANSI' }),
  rule('ordered-first', { exact: 'AUDIT_ORDER' }),
  rule('ordered-second', { substring: 'AUDIT_ORDER' }),
  rule('regex', { regex: { source: '^AUDIT_RETRY attempt=\\d+$' } }),
  rule('substring', { substring: 'AUDIT_SUBSTRING' }, ['info']),
  rule('live', { exact: 'AUDIT_KEEP_LIVE' }, ['warn'], { live: true }),
  rule('scope', { exact: 'AUDIT_SCOPED' }, ['warn'], { testFiles: matchingFile }),
  ...['HOOK', 'RETRIED', 'SPY', 'TIMER', 'ASYNC'].map(name => rule(name.toLowerCase(), { exact: `AUDIT_${name}` })),
];
async function run(label, { workers = false, verbose = false, bounded = false, fullSuite = false } = {}) {
  const log = path.join(artifacts, `${label}.log`);
  const reportFile = path.join(artifacts, `${label}.audit.json`);
  const resultFile = path.join(artifacts, `${label}.results.json`);
  const auditFile = path.join(artifacts, `${label}.config.json`);
  const configFile = path.join(artifacts, `${label}.jest.cjs`);
  fs.writeFileSync(auditFile, JSON.stringify({ schemaVersion: 1, rules, jsonReport: reportFile, display: { detail: 'detailed', githubActions: 'off' }, ...(bounded ? { limits: { groups: 2, samples: 1, messageLength: 100, files: 1 } } : {}) }, null, 2));
  const base = require(path.join(consumer, 'package.json')).jest;
  const config = { ...base, rootDir: consumer, silent: false, ...(fullSuite ? {} : { collectCoverage: false, testMatch: ['**/console-audit-scenarios/*.test.ts'] }), setupFiles: [...(base.setupFiles || []), path.join(consumer, 'console-audit-scenarios.setup.cjs')], testEnvironment: require.resolve('jest-console-audit-reporter/environment/jsdom', { paths: [consumer] }), testEnvironmentOptions: { ...base.testEnvironmentOptions, consoleAudit: { configFile: auditFile } }, reporters: ['default', [require.resolve('jest-console-audit-reporter/reporter', { paths: [consumer] }), { configFile: auditFile }]] };
  fs.writeFileSync(configFile, 'module.exports = ' + JSON.stringify(config, null, 2));
  const fd = fs.openSync(log, 'w');
  const child = spawn(process.execPath, [path.join(consumer, 'node_modules/jest/bin/jest.js'), '--config', configFile, workers ? '--maxWorkers=2' : '--runInBand', `--verbose=${verbose}`, '--json', '--outputFile', resultFile], { cwd: consumer, stdio: ['ignore', fd, fd], env: { ...process.env, CI: 'true', FORCE_COLOR: '0' } });
  fs.closeSync(fd);
  let liveObserved = false;
  const poll = setInterval(() => {
    const text = fs.readFileSync(log, 'utf8');
    if (text.includes('AUDIT_ERROR_OBJECT') && !text.includes('AUDIT_FORMATTING_FINISHED')) liveObserved = true;
  }, 10);
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearInterval(poll); clearTimeout(timer); }
  assert.equal(code, 0, `${label}: exit status; inspect ${log}`);
  const results = JSON.parse(fs.readFileSync(resultFile));
  const audit = JSON.parse(fs.readFileSync(reportFile));
  const output = fs.readFileSync(log, 'utf8');
  assert.equal(audit.status, 'complete');
  assert.deepEqual(audit.health, []);
  assert.equal(audit.totals.expected, fullSuite ? 139 : 128);
  assert.equal(audit.totals.unexpected, 6);
  assert.equal(audit.capture.capturedFiles, fullSuite ? 15 : 4);
  assert.equal(results.numPassedTests, fullSuite ? 595 : 15);
  assert.equal(results.numTotalTestSuites, fullSuite ? 15 : 4);
  assert.equal(results.numFailedTests, 0);
  assert.ok(audit.unusedRules.includes('ordered-second'));
  assert.ok(output.includes('AUDIT_KEEP_LIVE') && output.indexOf('AUDIT_KEEP_LIVE') < output.indexOf('Expected messages'));
  assert.ok(!output.slice(0, output.indexOf('Expected messages')).includes('AUDIT_REPEAT'), 'Repeated warning was printed live');
  assert.ok(!output.includes('AUDIT_MOCKED_NOT_CAPTURED'));
  assert.ok(output.includes('Circular') && output.includes('AUDIT_PRINTF 42 text') && output.includes('AUDIT_ERROR_OBJECT'));
  assert.ok(liveObserved, `${label}: unexpected error was not observed while test was running`);
  if (bounded) {
    assert.ok(audit.totals.omittedGroups > 0);
    assert.ok(audit.totals.groups.length <= 2);
    assert.ok(audit.totals.groups.every(g => g.samples.length <= 1));
  } else {
    const counts = new Map();
    for (const group of audit.totals.groups.filter(g => g.ruleId)) counts.set(group.ruleId, (counts.get(group.ruleId) || 0) + group.count);
    assert.equal(counts.get('repeat'), 100);
    assert.equal(counts.get('retried'), 2);
    assert.equal(counts.get('hook'), 6);
    assert.equal(counts.get('spy'), 2);
    assert.equal(counts.get('ansi'), 1);
    assert.equal(counts.get('scope'), 1);
    assert.equal(counts.get('levels'), 5);
  }
  console.log(`${label}: passed (${audit.totals.expected} expected, 6 unexpected; live timing verified)`);
  return { label, tests: results.numPassedTests, suites: results.numTotalTestSuites, expected: audit.totals.expected, unexpected: audit.totals.unexpected, liveObserved };
}
(async () => {
  const jestVersion = require(path.join(consumer, 'node_modules/jest/package.json')).version;
  assert.equal(jestVersion, require(path.join(root, 'package.json')).devDependencies.jest, 'Install the current Jest target with node scripts/upgrade-jest.cjs first');
  const installed = require(path.join(consumer, 'node_modules/jest-console-audit-reporter/package.json'));
  assert.equal(installed.peerDependencies.jest, jestVersion, 'Repack and reinstall the reporter for the current Jest target');
  const checks = [];
  for (const workers of [false, true]) for (const verbose of [false, true]) checks.push(await run(`${workers ? 'workers' : 'serial'}-${verbose ? 'verbose' : 'compact'}`, { workers, verbose }));
  checks.push(await run('bounded-workers', { workers: true, bounded: true }));
  checks.push(await run('full-suite-workers', { workers: true, fullSuite: true }));
  fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify({ status: 'passed', jest: jestVersion, node: process.version, checks }, null, 2));
  console.log(`Evidence: ${artifacts}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
