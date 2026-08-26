const list = (value) => (Array.isArray(value) ? value : []);

const missesRequiredSource = (profile, fingerprints) => {
  const declared = [
    ...list(profile?.current_sources),
    ...list(profile?.history_sources),
  ];
  return list(fingerprints).some((source) => {
    if (source?.exists !== false) return false;
    const match = declared.find((item) => item.name === source.name);
    return match ? match.required !== false : true;
  });
};

export const datasetFreshness = (profile, data) => {
  const meta = data?.meta?.profile;
  if (!meta?.profile_hash) return "dataset da rigenerare";
  if (meta.profile_hash !== profile?.configuration_hash)
    return "dataset da rigenerare";
  if (missesRequiredSource(profile, meta.source_fingerprints))
    return "fonti cambiate";
  return "dataset corrente";
};

export const simulationFreshness = (data, season) => {
  const datasetHash = data?.meta?.profile?.dataset_input_hash;
  return datasetHash && season?.meta?.dataset_input_hash === datasetHash
    ? "simulazione corrente"
    : "simulazione da aggiornare";
};
