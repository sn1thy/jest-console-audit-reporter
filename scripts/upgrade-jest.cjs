// Install and validate the exact Jest target in both local checkouts.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const consumer = path.resolve(root, '../card-validator-console-audit');
const version = require(path.join(root, 'package.json')).devDependencies.jest;
const artifacts = path.join(root, `artifacts/jest-${version}-upgrade`);
fs.mkdirSync(artifacts, { recursive: true });
// Never leave a stale success marker after a failed rerun.
fs.rmSync(path.join(artifacts, 'summary.json'), { force: true });
function run(command, args, cwd, label) {
  console.log(`${label}: ${command} ${args.join(' ')}`);
  const log = path.join(artifacts, `${label}.log`);
  const fd = fs.openSync(log, 'w');
  let result;
  try { result = spawnSync(command, args, { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, CI: 'true', FORCE_COLOR: '0' } }); }
  finally { fs.closeSync(fd); }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${label} failed; inspect ${log}`);
  return fs.readFileSync(log, 'utf8');
}
function verify(dir) {
  for (const name of ['jest', 'jest-environment-node', 'jest-environment-jsdom']) assert.equal(require(path.join(dir, 'node_modules', name, 'package.json')).version, version, `${dir}: ${name}`);
}
try {
  assert.match(version, /^30\.\d+\.\d+$/);
  assert.ok(fs.existsSync(path.join(consumer, 'src/__tests__/console-audit-scenarios')), 'Braintree scenarios checkout is required');
  run('npm', ['install'], root, 'install-reporter-dependencies');
  verify(root);
  run('npm', ['test'], root, 'reporter-unit-types');
  run('npm', ['run', 'test:integration'], root, 'reporter-integration');
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts'], root, 'pack'))[0];
  run('npm', ['install', '--save-dev', '--save-exact', ...['jest', 'jest-environment-node', 'jest-environment-jsdom'].map(name => `${name}@${version}`), path.join(root, packed.filename)], consumer, 'install-consumer');
  verify(consumer);
  const jest = path.join(consumer, 'node_modules/jest/bin/jest.js');
  const baselineFile = path.join(artifacts, 'baseline.results.json');
  run(process.execPath, [jest, '--runInBand', '--testPathIgnorePatterns=console-audit-scenarios', '--json', '--outputFile', baselineFile], consumer, 'original-suite-baseline');
  const baseline = JSON.parse(fs.readFileSync(baselineFile));
  assert.equal(baseline.numPassedTests, 580);
  assert.equal(baseline.numTotalTestSuites, 11);
  run(process.execPath, [path.join(root, 'scripts/check-card-validator-scenarios.cjs')], root, 'external-scenarios');
  fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify({ status: 'passed', jest: version, node: process.version, baselineTests: baseline.numPassedTests, checks: ['unit/types', 'Jest integration', 'packed consumer install', 'original Braintree suite', 'expanded console scenarios and full combined suite'] }, null, 2));
  console.log(`Jest ${version} upgrade passed. Evidence: ${artifacts}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
