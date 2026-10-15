const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validate, Aggregate, glob, match } = require("../dist/core");
const rule = {
  id: "known",
  label: "Known warning",
  reason: "Negative test",
  levels: ["warn"],
  match: { exact: "known" },
  testFiles: ["tests/**/a.test.js"],
};
const config = { schemaVersion: 1, rules: [rule] };
test("ordered scoped rules and ANSI normalization, exact counts", () => {
  const a = new Aggregate(validate(config));
  for (let i = 0; i < 100; i++)
    a.add("warn", "\x1b[31mknown\x1b[0m", "tests/a.test.js");
  a.add("error", "known", "tests/a.test.js");
  a.add("warn", "known", "other.js");
  const s = a.snapshot();
  assert.equal(s.expected, 100);
  assert.equal(s.unexpected, 2);
  assert.equal(s.total, 102);
  assert.equal(s.groups.find((g) => g.ruleId).count, 100);
  assert.equal(s.groups.find((g) => g.ruleId).samples.length, 3);
});
test("validation rejects unknown fields and unsafe regex", () => {
  for (const bad of [
    { ...config, foo: true },
    {
      ...config,
      rules: [{ ...rule, match: { regex: { source: "x", flags: "g" } } }],
    },
    { ...config, rules: [rule, rule] },
    { ...config, limits: { groups: 0 } },
  ])
    assert.throws(() => validate(bad));
});
test("limits preserve exact totals and bounded groups and strings", () => {
  const a = new Aggregate({
    ...config,
    rules: [],
    limits: { groups: 1, samples: 1, messageLength: 2, files: 1 },
  });
  for (let i = 0; i < 20; i++) a.add("log", "long " + i, "test.js");
  const s = a.snapshot();
  assert.equal(s.total, 20);
  assert.equal(s.omittedGroups, 19);
  assert.equal(s.groups.length, 1);
  assert.equal(s.groups[0].samples[0].message, "lo");
});
test("globs, first rule and origin absence", () => {
  assert.ok(glob("tests/**/*.js", "tests/a.js"));
  assert.ok(!glob("tests/*.js", "tests/deep/a.js"));
  assert.equal(
    match(
      { ...config, rules: [{ ...rule, origins: ["*"] }] },
      "warn",
      "known",
      "tests/a.test.js"
    ),
    undefined
  );
  assert.equal(
    match(
      { ...config, rules: [rule, { ...rule, id: "later" }] },
      "warn",
      "known",
      "tests/a.test.js"
    ).id,
    "known"
  );
});
