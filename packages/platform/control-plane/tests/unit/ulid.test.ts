import { test } from "node:test";
import assert from "node:assert/strict";
import { ulid, isUlid } from "../../src/ulid.ts";

test("ulid: 26-char Crockford base32, validates", () => {
  const id = ulid();
  assert.equal(id.length, 26);
  assert.ok(isUlid(id));
  assert.ok(!isUlid("nope"));
  assert.ok(!isUlid(id + "X"));
  assert.ok(!isUlid("I".repeat(26))); // I is not in the alphabet
});

test("ulid: monotonic within a millisecond and across a burst", () => {
  const now = 1_700_000_000_000;
  const a = ulid(now), b = ulid(now), c = ulid(now);
  assert.ok(a < b && b < c, `expected strictly increasing: ${a} ${b} ${c}`);
});

test("ulid: time prefix sorts by time", () => {
  // Both are ahead of anything this process has minted, so each keeps its own
  // time prefix.
  const early = ulid(2_000_000_000_000);
  const late = ulid(2_000_000_001_000);
  assert.ok(early < late);
  assert.ok(late.slice(0, 10) > early.slice(0, 10), "the 10-char time prefix itself advances");
});

test("ulid: a backwards clock step still yields strictly increasing ids", () => {
  // Feed cursors are ULIDs, so an id below a cursor a consumer already passed is
  // an event that consumer never sees. An NTP correction or VM resume must not
  // be able to mint one.
  const base = 2_100_000_000_000;
  const ids: HostedDynamic = [ulid(base), ulid(base - 5_000), ulid(base - 60_000), ulid(base + 1)];
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i] > ids[i - 1], `expected strictly increasing across a clock step: ${ids[i - 1]} then ${ids[i]}`);
  }
});

test("ulid: 10k ids are unique", () => {
  const set = new Set();
  for (let i = 0; i < 10000; i++) set.add(ulid());
  assert.equal(set.size, 10000);
});
