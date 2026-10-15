# jest-console-audit-reporter

An alpha console audit for Jest: expected messages are summarized; unexpected messages print immediately and appear under **Possible flaws**. Unexpected output does not fail tests unless strict mode is enabled. Capture failures fail the audit.

This checkout contains the implementation. The dependency target is Jest 30.5.2. Reporter checks and packed-consumer scenarios passed, including the 595-test combined Braintree suite in serial and worker runs. See [compatibility](docs/compatibility.md). The package has not been published.

## Setup

Build with `npm install && npm run build`, then install an `npm pack` tarball in your project. Requires Node 20+ and exactly Jest / jest-environment-node 30.5.2. Install jest-environment-jsdom 30.5.2 for the optional jsdom environment. Remove `--silent` and `silent: true`.

```js
const path = require('node:path');
const configFile = path.resolve(__dirname, 'console-audit.config.json');
module.exports = {
  testEnvironment: 'jest-console-audit-reporter/environment/node',
  testEnvironmentOptions: { consoleAudit: { configFile } },
  reporters: ['default', ['jest-console-audit-reporter/reporter', { configFile }]],
};
```

```json
{
  "schemaVersion": 1,
  "rules": [{
    "id": "negative-auth", "label": "Rejected credentials",
    "reason": "The negative authentication case intentionally warns",
    "levels": ["warn"], "match": { "exact": "Invalid token" },
    "testFiles": ["tests/auth/**/*.test.js"]
  }],
  "display": { "detail": "compact", "githubActions": "auto" },
  "jsonReport": "artifacts/console-audit.json",
  "failOnUnexpected": false
}
```

Rules are ordered; first match wins. Matchers are `exact`, `substring`, or `regex: {source, flags}`. Stateful regex flags `g` and `y` are rejected. Matching removes ANSI styles and preserves whitespace/case. `testFiles` uses root-relative slash-normalized paths; globs support `*`, `**`, and `?` (no braces or negation). Optional `origins` globs match the entire available stack string and never match an absent origin. `live: true` also prints a matched rule.

Use one shared configuration file across projects in a run. JSON report paths resolve relative to this file. Counts include retries. There are no fabricated test names; attribution is by file and optional stack.

`limits` defaults: `groups: 1000`, `samples: 3`, `messageLength: 4000`, `files: 100`. Limits bound retained detail, preserve exact occurrence totals, and disclose omissions. Omitted file counts represent occurrences, not distinct files. Summary files and sample stacks can contain application data.

`display.detail` accepts `compact` or `detailed`; GitHub Actions folding accepts `auto`, `on`, `off`. Auto checks `GITHUB_ACTIONS === "true"`. Expected summary details fold; possible flaws and capture health remain visible. Summaries show message text without call stacks, including stacks embedded in Error arguments, and deduplicate repeated samples. Detailed mode also lists affected files. Terminal summary text neutralizes workflow commands; JSON preserves message text and origins within configured limits.

Terminal summaries color headings, console levels and capture status, with dimmed metadata. Color is automatic on interactive stderr; `NO_COLOR` disables it, and `FORCE_COLOR=1` enables it for redirected output. JSON reports and GitHub Actions folding commands remain unstyled.

For jsdom replace `/environment/node` with `/environment/jsdom`. For another environment:

```js
const { wrapEnvironment } = require('jest-console-audit-reporter/environment/factory');
module.exports = wrapEnvironment(require('your-environment').TestEnvironment);
```

The package exports `AuditConfig`, `AuditRule`, `DisplayOptions`, and `AuditReport` types. Editor schemas: `jest-console-audit-reporter/schema` and `jest-console-audit-reporter/report-schema`. Runtime validation is authoritative, including unique rule IDs and valid regex syntax.

Capture covers log/info/debug/warn/error in imports, setup and hooks after environment construction. Console spies that call through work; replacing methods suppresses capture until restored. Other console methods remain unclassified. Direct stream writes, subprocesses, browser consoles, and logs before construction are outside capture. Jest's native late-log diagnostic remains active. No telemetry.

Run `npm test` for core/adapter checks and `npm run test:integration` for subprocess fixtures. See [alpha plan](docs/alpha-plan.md) for planned hardening and release gates.

Dependency maintenance ideas are recorded in [upstream contribution follow-ups](docs/upstream-contribution-followups.md).

See [testing strategy and current results](docs/testing.md) for local checks, packed consumers, and trials in existing codebases.
