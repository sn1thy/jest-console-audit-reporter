// Run from a normal terminal: node scripts/try-card-validator.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const consumer = path.resolve(root, '../card-validator-console-audit');
const artifacts = path.join(root, 'artifacts/card-validator');
fs.mkdirSync(artifacts, { recursive: true });
function run(command, args, cwd, label, expected = 0) {
  console.log(`${label}: ${command} ${args.join(' ')}`);
  const file = path.join(artifacts, `${label}.log`);
  const fd = fs.openSync(file, 'w');
  let result;
  try { result = spawnSync(command, args, { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, CI: 'true', FORCE_COLOR: '0' } }); }
  finally { fs.closeSync(fd); }
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `${label} exit status; inspect ${file}`);
  return fs.readFileSync(file, 'utf8');
}
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
function main() {
  if (!fs.existsSync(consumer)) run('git', ['clone', 'https://github.com/braintree/card-validator.git', consumer], root, 'clone');
  else {
    assert.ok(fs.existsSync(path.join(consumer, '.git')), 'Existing destination is not a checkout');
    const origin = run('git', ['remote', 'get-url', 'origin'], consumer, 'origin').trim();
    assert.match(origin, /github\.com[/:]braintree\/card-validator(?:\.git)?$/);
    // Do not overwrite a previous trial or somebody's local modifications.
    assert.equal(run('git', ['status', '--porcelain'], consumer, 'initial-status').trim(), '', 'Destination must be clean; move the prior trial before rerunning');
  }
  const commit = run('git', ['rev-parse', 'HEAD'], consumer, 'commit').trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(consumer, 'package.json'), 'utf8'));
  assert.match(pkg.devDependencies.jest, /30\./, 'Candidate no longer uses Jest 30');
  const jestVersion = require(path.join(root, 'package.json')).devDependencies.jest;
  run('npm', ['install', '--save-dev', '--save-exact', ...['jest', 'jest-environment-node', 'jest-environment-jsdom'].map(name => `${name}@${jestVersion}`)], consumer, 'install');
  const jest = path.join(consumer, 'node_modules/jest/bin/jest.js');
  const results = label => path.join(artifacts, `${label}.results.json`);
  const suite = (label, flags, config) => run(process.execPath, [jest, ...(config ? ['--config', config] : []), '--silent=false', '--json', '--outputFile', results(label), ...flags], consumer, label);
  suite('baseline', ['--runInBand']);
  run('npm', ['run', 'build'], root, 'build-reporter');
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts'], root, 'pack'))[0];
  run('npm', ['install', '--save-dev', path.join(root, packed.filename)], consumer, 'install-reporter');
  const configFile = path.join(consumer, 'console-audit.trial.json');
  const config = path.join(consumer, 'jest.console-audit.trial.cjs');
  const report = path.join(artifacts, 'console-audit.json');
  const base = { schemaVersion: 1, rules: [], display: { detail: 'detailed', githubActions: 'off' }, jsonReport: report };
  write(configFile, base);
  fs.writeFileSync(config, `const base = require('./package.json').jest;\nconst configFile = ${JSON.stringify(configFile)};\nmodule.exports = { ...base, silent: false, testEnvironment: 'jest-console-audit-reporter/environment/jsdom', testEnvironmentOptions: { ...base.testEnvironmentOptions, consoleAudit: {configFile} }, reporters: [...(base.reporters || ['default']), ['jest-console-audit-reporter/reporter', {configFile}]] };\n`);
  const baseline = JSON.parse(fs.readFileSync(results('baseline')));
  function compare(label) {
    const actual = JSON.parse(fs.readFileSync(results(label)));
    for (const field of ['numPassedTests', 'numFailedTests', 'numPendingTests', 'numTotalTests', 'numTotalTestSuites']) assert.equal(actual[field], baseline[field], `${label}: ${field}`);
    const audit = JSON.parse(fs.readFileSync(report));
    assert.equal(audit.status, 'complete');
    assert.deepEqual(audit.health, []);
    fs.copyFileSync(report, path.join(artifacts, `${label}.audit.json`));
  }
  for (const [label, flags] of [['audit-serial', ['--runInBand']], ['audit-workers', ['--maxWorkers=2']]]) { suite(label, flags, config); compare(label); }
  const smoke = path.join(consumer, 'src/__tests__/console-audit.trial.test.ts');
  fs.writeFileSync(smoke, `describe('external console audit trial', () => {\n  test('console capture', async () => {\n    console.warn('AUDIT_TRIAL_EXPECTED');\n    console.warn('AUDIT_TRIAL_EXPECTED');\n    console.error('AUDIT_TRIAL_UNEXPECTED');\n    await new Promise(resolve => setTimeout(resolve, 100));\n    process.stderr.write('AUDIT_TRIAL_FINISHED\\n');\n    expect(true).toBe(true);\n  });\n});\n`);
  base.rules = [{ id: 'trial-warning', label: 'Intentional trial warnings', reason: 'Controlled consumer integration fixture', levels: ['warn'], match: { exact: 'AUDIT_TRIAL_EXPECTED' }, testFiles: ['**/console-audit.trial.test.ts'] }];
  write(configFile, base);
  for (const workers of [false, true]) for (const verbose of [false, true]) {
    const label = `smoke-${workers ? 'workers' : 'serial'}-${verbose ? 'verbose' : 'compact'}`;
    const output = suite(label, [workers ? '--maxWorkers=2' : '--runInBand', `--verbose=${verbose}`, '--coverage=false', '--runTestsByPath', smoke], config);
    const audit = JSON.parse(fs.readFileSync(report));
    assert.equal(audit.status, 'complete');
    assert.equal(audit.totals.expected, 2);
    assert.equal(audit.totals.unexpected, 1);
    const end = output.indexOf('AUDIT_TRIAL_FINISHED');
    assert.ok(end >= 0);
    assert.ok(output.indexOf('AUDIT_TRIAL_UNEXPECTED') >= 0 && output.indexOf('AUDIT_TRIAL_UNEXPECTED') < end, 'Unexpected message must precede completion');
    assert.ok(!output.slice(0, end).includes('AUDIT_TRIAL_EXPECTED'), 'Expected messages must be suppressed live');
    assert.ok(output.slice(end).includes('AUDIT_TRIAL_EXPECTED'), 'Expected message must appear in summary');
    assert.ok(output.includes('Possible flaws'));
    fs.copyFileSync(report, path.join(artifacts, `${label}.audit.json`));
  }
  base.failOnUnexpected = true;
  write(configFile, base);
  run(process.execPath, [jest, '--config', config, '--runInBand', '--coverage=false', '--runTestsByPath', smoke], consumer, 'strict-unexpected', 1);
  base.failOnUnexpected = false;
  write(configFile, base);
  fs.appendFileSync(smoke, `\ntest('intentional failing assertion', () => { expect(1).toBe(2); });\n`);
  const failure = run(process.execPath, [jest, '--config', config, '--runInBand', '--coverage=false', '--runTestsByPath', smoke], consumer, 'assertion-failure', 1);
  assert.ok(failure.includes('intentional failing assertion') && failure.includes('Expected: 2'), 'Native failure diagnostics preserved');
  fs.unlinkSync(smoke);
  write(path.join(artifacts, 'summary.json'), { status: 'passed', repository: 'https://github.com/braintree/card-validator', commit, node: process.version, jest: require(path.join(consumer, 'node_modules/jest/package.json')).version, baselineTests: baseline.numTotalTests, baselineSuites: baseline.numTotalTestSuites, checks: ['baseline', 'full suite serial/workers', 'four console smoke modes', 'strict unexpected exit', 'assertion failure diagnostics'], note: 'Single-file smoke runs may not spawn workers; full-suite worker run exercises parallel execution.' });
  console.log(`All checks passed. Evidence: ${artifacts}\nLocal trial checkout: ${consumer}`);
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
