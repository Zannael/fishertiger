import { normalizeRules } from "./league-rules.js";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const object = (value) => (isObject(value) ? value : {});

export class ProfileClientError extends Error {
  constructor(code, message, { status, details, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProfileClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const fail = (code, message, options) => {
  throw new ProfileClientError(code, message, options);
};

export const apiUrl = (path, apiBase = "") => {
  if (typeof path !== "string" || !path.startsWith("/")) fail("invalid_api_path", "API paths must start with '/'.");
  return `${String(apiBase).replace(/\/$/, "")}${path}`;
};

export const auctionDatasetPath = (profile) => {
  const value = object(profile);
  const id = profileId(value.profile_id);
  const season = String(value.season?.season || "").replace("/", "-");
  if (!season) fail("invalid_profile", "A profile season is required.");
  return `${id}/${season}/auction_data.json`;
};

export const seasonSimulationPath = (profile) =>
  auctionDatasetPath(profile).replace("auction_data.json", "season_simulation.json");

const profileId = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    fail("invalid_profile_id", "Profile IDs may contain only letters, numbers, underscores, and hyphens.");
  return value;
};

async function requestJson(url, { fetchImpl = globalThis.fetch, ...options } = {}) {
  if (typeof fetchImpl !== "function") fail("fetch_unavailable", "Fetch is unavailable.");
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (cause) {
    fail("network_error", "The request could not be completed.", { cause });
  }
  let body = null;
  try {
    body = await response.json();
  } catch (cause) {
    if (!response.ok) fail("http_error", `Request failed with status ${response.status}.`, { status: response.status, cause });
    fail("invalid_response", "The server returned invalid JSON.", { status: response.status, cause });
  }
  if (!response.ok) {
    const error = object(object(body).error);
    fail(error.code || "http_error", error.message || `Request failed with status ${response.status}.`, {
      status: response.status,
      details: error.details,
    });
  }
  return body;
}

export const listProfiles = async (options = {}) => {
  const body = await requestJson(apiUrl("/api/profiles", options.apiBase), options);
  if (!Array.isArray(body?.profiles)) fail("invalid_response", "The profile list is invalid.");
  return body.profiles;
};

export const loadProfile = async (id, options = {}) =>
  requestJson(apiUrl(`/api/profiles/${encodeURIComponent(profileId(id))}`, options.apiBase), options);

export const saveProfile = async (profile, options = {}) => {
  const value = object(profile);
  const id = profileId(value.profile_id);
  return requestJson(apiUrl(`/api/profiles/${encodeURIComponent(id)}`, options.apiBase), {
    ...options,
    method: "PUT",
    headers: { "Content-Type": "application/json", ...options.headers },
    body: JSON.stringify(value),
  });
};

/** Parse a profile file chosen by the user. Rejects anything the API would refuse
 *  anyway, so the failure is reported before a request is made. */
export const parseProfileJson = (text) => {
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    fail("invalid_profile_file", "Il file non contiene JSON valido.", { cause });
  }
  if (!isObject(value)) fail("invalid_profile_file", "Il file deve contenere un oggetto JSON.");
  if (typeof value.profile_id !== "string" || !value.profile_id.trim())
    fail("invalid_profile_file", "Il file non sembra un profilo: manca profile_id.");
  profileId(value.profile_id);
  return value;
};

export const deleteProfile = async (id, options = {}) =>
  requestJson(apiUrl(`/api/profiles/${encodeURIComponent(profileId(id))}`, options.apiBase), {
    ...options,
    method: "DELETE",
  });

export const generateProfile = async (profileOrId, options = {}) => {
  const request = typeof profileOrId === "string"
    ? { profile_id: profileId(profileOrId) }
    : { profile: object(profileOrId) };
  if (!request.profile_id && !request.profile.profile_id)
    fail("invalid_profile", "A profile or profile ID is required for generation.");
  return requestJson(apiUrl("/api/generate", options.apiBase), {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...options.headers },
    body: JSON.stringify(request),
  });
};

const datasetProfileId = (meta) => object(meta.profile).profile_id || meta.profile_id;

/** Validate generated schema 1.0 data, while accepting pre-schema public exports. */
export const validateDataset = (payload, profile) => {
  const errors = [];
  if (!isObject(payload)) errors.push({ code: "invalid_dataset", message: "Dataset must be a JSON object." });
  else {
    if (payload.schema_version !== undefined && payload.schema_version !== "1.0")
      errors.push({ code: "unsupported_dataset_schema", message: "Only dataset schema 1.0 is supported." });
    if (payload.schema_version === "1.0" && !isObject(payload.meta))
      errors.push({ code: "invalid_dataset_metadata", message: "Schema 1.0 datasets require metadata." });
    if (!Array.isArray(payload.players))
      errors.push({ code: "invalid_dataset_players", message: "Dataset players must be an array." });
    const expected = object(profile).profile_id;
    const actual = isObject(payload.meta) ? datasetProfileId(payload.meta) : undefined;
    if (expected && actual && expected !== actual)
      errors.push({ code: "profile_mismatch", message: "Dataset metadata belongs to a different profile.", details: { expected, actual } });
  }
  return { valid: errors.length === 0, errors };
};

export const normalizeDataset = (payload, profile) => {
  const validation = validateDataset(payload, profile);
  if (!validation.valid) {
    const [error] = validation.errors;
    fail(error.code, error.message, { details: error.details || validation.errors });
  }
  const legacy = payload.schema_version === undefined;
  return {
    ...payload,
    schema_version: payload.schema_version || "legacy",
    meta: isObject(payload.meta) ? payload.meta : { legacy: true, profile: null },
    league_rules: object(payload.league_rules || payload.rules),
    calendario_lega: payload.calendario_lega || payload.calendar,
    legacy,
  };
};

export const loadDatasetUrl = async (url, { profile, ...options } = {}) => {
  if (typeof url !== "string" || !url.trim()) fail("invalid_dataset_url", "A dataset URL is required.");
  return normalizeDataset(await requestJson(url, options), profile);
};

const formations = (value) => (Array.isArray(value) ? value.map((formation) => {
  if (Array.isArray(formation)) return formation;
  const parts = String(formation).split("-").map(Number);
  return parts.length === 3 && parts.every(Number.isInteger) ? parts : formation;
}) : undefined);

/** Resolve profile fields to the public camelCase shape consumed by normalizeRules. */
export const rulesFor = (profile, data = {}) => {
  const source = object(profile);
  const dataset = object(data);
  const fallback = object(dataset.league_rules || dataset.rules);
  const pick = (value, fallbackValue) => value === undefined ? fallbackValue : value;
  const participants = object(source.participants);
  const bench = object(source.bench_switch);
  const scoring = object(source.scoring);
  const virtualGoals = object(source.virtual_goals);
  const defense = object(source.defense_modifier);
  const standings = object(source.standings);
  const auction = object(source.auction);
  const incomplete = object(source.incomplete_lineup);
  const profileRules = {
    participants: pick(participants.team_names?.length, fallback.participants),
    teamNames: pick(participants.team_names, fallback.teamNames || fallback.team_names),
    userTeam: pick(participants.user_team, fallback.userTeam || fallback.user_team),
    rosterSlots: pick(source.roster_slots, fallback.rosterSlots || fallback.roster_slots),
    formations: pick(formations(source.formations?.allowed), fallback.formations),
    startingCredits: pick(source.credits?.starting, fallback.startingCredits || fallback.starting_credits),
    bench: {
      roles: pick(bench.bench_roles, object(fallback.bench).roles || object(fallback.bench).bench_roles),
      maxSubstitutions: pick(bench.max_substitutions, object(fallback.bench).maxSubstitutions),
      mode: pick(bench.mode, object(fallback.bench).mode),
    },
    scoring: { ...object(fallback.scoring), goalkeeperConceded: pick(scoring.goalkeeper_conceded_goal, object(fallback.scoring).goalkeeperConceded) },
    virtualGoals: { ...object(fallback.virtualGoals), threshold: pick(virtualGoals.threshold, object(fallback.virtualGoals).threshold), increment: pick(virtualGoals.step, object(fallback.virtualGoals).increment) },
    defenseModifier: { ...object(fallback.defenseModifier), enabled: pick(defense.enabled, object(fallback.defenseModifier).enabled), requiredDefenders: pick(defense.required_defenders, object(fallback.defenseModifier).requiredDefenders), tiers: pick(defense.tiers?.map((tier) => ({ ...tier, threshold: tier.minimum_average ?? tier.threshold })), object(fallback.defenseModifier).tiers) },
    standings: { ...object(fallback.standings), win: pick(standings.win_points, object(fallback.standings).win), draw: pick(standings.draw_points, object(fallback.standings).draw), loss: pick(standings.loss_points, object(fallback.standings).loss), tieBreakers: pick(standings.tie_breakers, object(fallback.standings).tieBreakers), exactTie: pick(standings.exact_tie_policy, object(fallback.standings).exactTie) },
    incompleteLineup: pick(incomplete.policy, fallback.incompleteLineup || fallback.incomplete_lineup),
    auction: {
      ...object(fallback.auction),
      minPrice: pick(auction.minimum_bid, object(fallback.auction).minPrice),
      increment: pick(auction.bid_increment, object(fallback.auction).increment),
      reserve: pick(auction.reserve_credits_per_open_slot, object(fallback.auction).reserve),
      nomination: pick(auction.nomination_policy, object(fallback.auction).nomination),
      roleBudgetPercentages: pick(
        auction.role_budget_percentages,
        object(fallback.auction).roleBudgetPercentages ||
          object(fallback.auction).role_budget_percentages,
      ),
      roleBudgetFlexibilityPercent: pick(
        auction.role_budget_flexibility_percent,
        object(fallback.auction).roleBudgetFlexibilityPercent ??
          object(fallback.auction).role_budget_flexibility_percent,
      ),
    },
    calendar: dataset.calendario_lega || dataset.calendar || fallback.calendario_lega || fallback.calendar,
  };
  return normalizeRules(profileRules);
};
