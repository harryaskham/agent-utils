// Five-field cron schedules in a time zone (extensions/lib/cron.js), as AHP 1.0's automations
// have them: the next occurrence, worked out once per firing; daylight-saving gaps and repeats.
import test from "node:test";
import assert from "node:assert/strict";

import { nextCronAt, parseCron, parseCronArgs } from "../extensions/lib/cron.js";

const at = (iso) => Date.parse(iso);
const next = (expression, zone, after) => {
  const value = nextCronAt(expression, zone, at(after));
  return value === undefined ? undefined : new Date(value).toISOString();
};

test("next occurrences: steps, ranges, names, lists, macros, and day-of-month OR day-of-week", () => {
  assert.equal(next("*/5 * * * *", "UTC", "2026-10-30T10:02:30Z"), "2026-10-30T10:05:00.000Z");
  assert.equal(next("0 9 * * 1-5", "Europe/London", "2026-10-30T10:00:00Z"), "2026-11-02T09:00:00.000Z", "Friday after 9 → Monday, in GMT");
  assert.equal(next("0 9 * * mon-fri", "Europe/London", "2026-10-23T07:00:00Z"), "2026-10-23T08:00:00.000Z", "in BST");
  assert.equal(next("@hourly", "America/New_York", "2026-10-30T10:59:00Z"), "2026-10-30T11:00:00.000Z");
  assert.equal(next("0 12 13 * fri", "UTC", "2026-10-01T00:00:00Z"), "2026-10-02T12:00:00.000Z", "the 13th or a Friday");
  assert.equal(next("0 0 * jan-mar/2 sun", "UTC", "2026-10-30T00:00:00Z"), "2027-01-03T00:00:00.000Z");
  assert.equal(next("15,45 8 1 * 7", "UTC", "2026-10-30T00:00:00Z"), "2026-11-01T08:15:00.000Z", "7 is Sunday");
  assert.equal(next("0 0 30 2 *", "UTC", "2026-01-01T00:00:00Z"), undefined, "never");
});

test("daylight saving: a skipped time does not occur; a repeated one occurs once, the first time", () => {
  // London: 29 Mar 2026 01:00 GMT → 02:00 BST; 25 Oct 2026 02:00 BST → 01:00 GMT.
  assert.equal(next("30 1 * * *", "Europe/London", "2026-03-28T12:00:00Z"), "2026-03-30T00:30:00.000Z");
  assert.equal(next("30 1 * * *", "Europe/London", "2026-10-24T12:00:00Z"), "2026-10-25T00:30:00.000Z");
  assert.equal(next("30 1 * * *", "Europe/London", "2026-10-25T00:30:00Z"), "2026-10-26T01:30:00.000Z", "not again an hour later");
});

test("bad schedules and /cron arguments say what is wrong", () => {
  for (const [bad, message] of [
    ["* * *", /five fields/],
    ["61 * * * *", /minute: 61 is outside 0-59/],
    ["5-1 * * * *", /runs backwards/],
    ["0 0 * * mon/0", /step "0"/],
    ["0 0 * smarch *", /month: "smarch"/],
  ]) assert.throws(() => parseCron(bad), message);
  assert.deepEqual(parseCronArgs(`"0 9 * * 1-5" tz=Europe/London /compact`), { expression: "0 9 * * 1-5", timeZone: "Europe/London", prompt: "/compact" });
  assert.deepEqual(parseCronArgs("*/30 * * * * --tz UTC !make test"), { expression: "*/30 * * * *", timeZone: "UTC", prompt: "!make test" });
  assert.deepEqual(parseCronArgs("@daily check the inbox"), { expression: "@daily", prompt: "check the inbox" });
  assert.throws(() => parseCronArgs("@daily tz=Mars/Olympus x"), /unknown time zone/);
  assert.throws(() => parseCronArgs("@daily"), /needs a prompt/);
});
