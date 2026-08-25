import test from "node:test";
import assert from "node:assert/strict";
import { parseProfileJson } from "../src/profile-client.js";

const valid = { profile_id: "my-league", name: "Lega", season: { season: "2026/27" } };

test("accepts a profile file and returns it unchanged", () => {
  assert.deepEqual(parseProfileJson(JSON.stringify(valid)), valid);
});

test("rejects a file that is not JSON", () => {
  assert.throws(() => parseProfileJson("non sono json"), { code: "invalid_profile_file" });
});

test("rejects JSON that is not an object", () => {
  assert.throws(() => parseProfileJson("[1,2,3]"), { code: "invalid_profile_file" });
  assert.throws(() => parseProfileJson("42"), { code: "invalid_profile_file" });
  assert.throws(() => parseProfileJson("null"), { code: "invalid_profile_file" });
});

test("rejects a profile without a usable id", () => {
  assert.throws(() => parseProfileJson(JSON.stringify({ name: "senza id" })), { code: "invalid_profile_file" });
  assert.throws(() => parseProfileJson(JSON.stringify({ profile_id: "   " })), { code: "invalid_profile_file" });
});

test("rejects an id the API would refuse", () => {
  assert.throws(() => parseProfileJson(JSON.stringify({ profile_id: "../escape" })), { code: "invalid_profile_id" });
  assert.throws(() => parseProfileJson(JSON.stringify({ profile_id: "con spazi" })), { code: "invalid_profile_id" });
});
