const stable = (value) => JSON.stringify(value ?? null);
const valueAt = (profile, path) => path.reduce((value, key) => value?.[key], profile);

const DATASET_PATHS = [
  ["season"], ["current_sources"], ["history_sources"], ["participants"],
  ["scoring"],
];
const SIMULATION_PATHS = [
  ["defense_modifier"], ["formations"], ["bench_switch"], ["virtual_goals"],
  ["standings"], ["payouts"], ["credits", "entry_fee_eur"], ["incomplete_lineup"],
  ["roster_slots"],
];
const SAVE_PATHS = [["profile_id"], ["name"], ["credits"], ["auction"]];
const label = (path) => path.join(".");
const changed = (baseline, draft, paths) => paths.filter((path) => stable(valueAt(baseline, path)) !== stable(valueAt(draft, path))).map(label);

/** Classify profile changes by the strongest required follow-up operation. */
export const profileChangePolicy = (baseline = {}, draft = {}) => {
  const datasetFields = changed(baseline, draft, DATASET_PATHS);
  const simulationFields = changed(baseline, draft, SIMULATION_PATHS);
  const saveFields = changed(baseline, draft, SAVE_PATHS);
  const fields = [...datasetFields, ...simulationFields, ...saveFields];
  const action = datasetFields.length ? "regenerate_dataset" : simulationFields.length ? "rerun_simulation" : fields.length ? "save" : "none";
  return { action, fields, datasetFields, simulationFields, saveFields, dirty: fields.length > 0 };
};
