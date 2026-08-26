import test from "node:test";
import assert from "node:assert/strict";
import { datasetFreshness, simulationFreshness } from "../src/dataset-freshness.js";

const profile = {
  configuration_hash: "abc",
  current_sources: [
    { name: "player_list", required: true },
    { name: "league_calendar", required: false },
  ],
  history_sources: [{ name: "stats_2024_25", required: true }],
};
const dataset = (meta) => ({ meta: { profile: { profile_hash: "abc", ...meta } } });

test("a dataset generated from the active profile is current", () => {
  assert.equal(datasetFreshness(profile, dataset({})), "dataset corrente");
});

test("an optional source that was never provided is not a change", () => {
  const data = dataset({
    source_fingerprints: [
      { name: "player_list", exists: true },
      { name: "league_calendar", exists: false },
    ],
  });
  assert.equal(datasetFreshness(profile, data), "dataset corrente");
});

test("a missing required source is reported", () => {
  const data = dataset({
    source_fingerprints: [{ name: "player_list", exists: false }],
  });
  assert.equal(datasetFreshness(profile, data), "fonti cambiate");
});

test("a source the profile no longer declares counts as required", () => {
  const data = dataset({
    source_fingerprints: [{ name: "dropped_source", exists: false }],
  });
  assert.equal(datasetFreshness(profile, data), "fonti cambiate");
});

test("a profile edited after generation needs a regeneration", () => {
  assert.equal(
    datasetFreshness({ ...profile, configuration_hash: "changed" }, dataset({})),
    "dataset da rigenerare",
  );
});

test("a dataset without freshness metadata is not claimed to be current", () => {
  assert.equal(datasetFreshness(profile, { meta: {} }), "dataset da rigenerare");
  assert.equal(datasetFreshness(profile, undefined), "dataset da rigenerare");
});

test("the simulation is current only for the dataset it was run on", () => {
  const data = dataset({ dataset_input_hash: "d1" });
  assert.equal(
    simulationFreshness(data, { meta: { dataset_input_hash: "d1" } }),
    "simulazione corrente",
  );
  assert.equal(
    simulationFreshness(data, { meta: { dataset_input_hash: "d0" } }),
    "simulazione da aggiornare",
  );
  assert.equal(simulationFreshness(data, null), "simulazione da aggiornare");
  assert.equal(
    simulationFreshness(dataset({}), { meta: { dataset_input_hash: "d1" } }),
    "simulazione da aggiornare",
  );
});
