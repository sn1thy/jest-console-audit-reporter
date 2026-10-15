# Changelog

## 0.1.0-alpha.1 (unreleased)

- Color terminal summary headings, levels and capture status; dim metadata and honor NO_COLOR/FORCE_COLOR.
- Show message text without call stacks in console summaries; deduplicate repeated samples while preserving JSON diagnostics.
- Target Jest and Node/jsdom environments 30.5.2; mirror the runner's project-level silent precedence. Installation, reporter checks and all external scenarios passed, including the corrected combined worker run.
- Ordered console expectation rules, bounded aggregation and JSON reports.
- Node/jsdom environment wrappers, custom environment factory and summary reporter.
- Strict/incomplete audit failures, compact/detailed views and GitHub Actions folding.
- Current unit/type and serial/worker Jest integration suites pass in the normal terminal (user-reported). Additional release gates remain; see docs/compatibility.md.
- Packed-package jsdom trial passed in Braintree card-validator: 580 tests across 11 suites, serial/worker compatibility, console filtering and summaries, strict exit status, and preserved failure diagnostics (saved evidence inspected).
