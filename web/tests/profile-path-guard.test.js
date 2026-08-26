import test from "node:test";
import assert from "node:assert/strict";
import {
  auctionDatasetPath,
  datasetPathError,
  isValidProfileId,
} from "../src/profile-client.js";

const valid = { profile_id: "my-league", season: { season: "2026/27" } };

test("accepts only path-safe profile IDs", () => {
  assert.equal(isValidProfileId("my-league_1"), true);
  assert.equal(isValidProfileId("mia lega"), false);
  assert.equal(isValidProfileId("lega/2026"), false);
  assert.equal(isValidProfileId(""), false);
  assert.equal(isValidProfileId(undefined), false);
});

test("reports why a profile cannot address a dataset instead of throwing", () => {
  assert.equal(datasetPathError(valid), "");
  assert.match(datasetPathError({ ...valid, profile_id: "mia lega" }), /ID profilo/);
  assert.match(datasetPathError({ profile_id: "my-league" }), /stagione/);
  assert.match(datasetPathError(null), /stagione|ID profilo/);
});

test("the guard covers every profile the path builder would reject", () => {
  for (const broken of [
    { ...valid, profile_id: "mia lega" },
    { ...valid, profile_id: "" },
    { profile_id: "my-league" },
    {},
  ]) {
    assert.notEqual(datasetPathError(broken), "");
    assert.throws(() => auctionDatasetPath(broken));
  }
});
