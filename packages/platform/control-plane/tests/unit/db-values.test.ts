import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, inClause } from "../../src/db.ts";

test("canonical JSON preserves nested arrays/null and sorts object keys for content hashes", () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 4, c: [3, null, 2] } }), '{"a":{"c":[3,null,2],"d":4},"z":1}');
  assert.equal(canonicalJson({ omitted: undefined, at: new Date(0) }), '{"at":"1970-01-01T00:00:00.000Z"}');
});

test("bounded IN placeholders preserve numbering without interpolating values", () => {
  assert.equal(inClause(["a", "b"], 2), "$2, $3");
  assert.equal(inClause([], 1), "");
});
