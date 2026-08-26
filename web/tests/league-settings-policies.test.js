import test from "node:test";
import assert from "node:assert/strict";
import { exactTiePolicies, nominationPolicies, sourceFormats, supportedValues, tieBreakers } from "../src/league-settings-policies.js";
import { profileChangePolicy } from "../src/profile-change-policy.js";

test("the settings policy catalog only exposes supported persisted values", () => {
  assert.deepEqual(sourceFormats.map(({ value }) => value), ["csv", "xlsx", "json"]);
  assert(supportedValues(exactTiePolicies).has("shared_rank"));
  assert.deepEqual(nominationPolicies.map(({ value }) => value), ["call", "call_by_role", "random", "random_by_role", "alphabetical", "alphabetical_by_role"]);
  assert.deepEqual(tieBreakers.map(({ value }) => value), ["goal_difference", "head_to_head", "season_fantasy_score"]);
  assert(!tieBreakers.some(({ label }) => label === "Punti in classifica"));
});

test("profile change policy returns the strongest required operation", () => {
  const baseline = {
    name: "League", season: { fantasy_matchdays: 36 }, scoring: { goal: 3 },
    defense_modifier: { enabled: false }, credits: { starting: 500 },
  };
  assert.deepEqual(profileChangePolicy(baseline, baseline), { action: "none", fields: [], datasetFields: [], simulationFields: [], saveFields: [], dirty: false });
  assert.equal(profileChangePolicy(baseline, { ...baseline, credits: { starting: 600 } }).action, "save");
  assert.equal(profileChangePolicy(baseline, { ...baseline, defense_modifier: { enabled: true } }).action, "rerun_simulation");
  assert.equal(profileChangePolicy(baseline, { ...baseline, scoring: { goal: 4 }, defense_modifier: { enabled: true } }).action, "regenerate_dataset");
});
