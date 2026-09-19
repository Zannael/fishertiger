import { apiUrl } from "./profile-client.js";

export class UpdateClientError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "UpdateClientError";
    this.code = code;
    this.status = status;
  }
}

export const sosFantaGuideUrl = (season) => {
  const match = String(season || "").trim().match(/^(\d{4})\/(\d{2}|\d{4})$/);
  if (!match) return "";
  const end = match[2].length === 2 ? `${match[1].slice(0, 2)}${match[2]}` : match[2];
  return `https://www.sosfanta.com/guida-asta-fantacalcio/guida-asta-fantacalcio-${match[1]}-${end}-tutti-consigli-fasce-chi-prendere/`;
};

export const sosFantaFormationsUrl = (season) => {
  const match = String(season || "").trim().match(/^(\d{4})\/(\d{2}|\d{4})$/);
  if (!match) return "";
  const start = Number(match[1]);
  const end = Number(match[2].length === 2 ? `${match[1].slice(0, 2)}${match[2]}` : match[2]);
  if (end !== start + 1) return "";
  return `https://www.sosfanta.com/asta-fantacalcio/seriea-tutte-formazioni-tipo-fantacalcio-${start}-${end}-asta-consigli-chi-prendere/`;
};

export const sosFantaSetPieceUrl = (season) => {
  const match = String(season || "").trim().match(/^(\d{4})\/(\d{2}|\d{4})$/);
  if (!match) return "";
  const start = Number(match[1]);
  const end = Number(match[2].length === 2 ? `${match[1].slice(0, 2)}${match[2]}` : match[2]);
  if (end !== start + 1) return "";
  return `https://www.sosfanta.com/asta-fantacalcio/serie-a-${start}-${end}-tiratori-punizioni-corner-specialisti-fantacalcio-asta/`;
};

export const sosFantaPenaltyUrl = () =>
  "https://www.sosfanta.com/asta-fantacalcio/fantacalcio-asta-tutti-rigoristi-seriea-venti-squadre-campionato/";

export const sosFantaGoalkeepersUrl = () =>
  "https://www.sosfanta.com/consigli-fantacalcio/portieri/fantacalcio-asta-tutti-portieri-gerarchie-seriea-venti-squadre-campionato/";

const updateRequest = async (provider, action, profile, {
  apiBase = "", fetchImpl = globalThis.fetch, contentHash = "", candidateHash = "",
  profileHash = "", activeHash = "", startersHash = "", auditHash = "", force = false,
} = {}) => {
  if (typeof fetchImpl !== "function")
    throw new UpdateClientError("fetch_unavailable", "Fetch non disponibile.");
  let response;
  try {
    response = await fetchImpl(apiUrl(`/api/updates/${provider}/${action}`, apiBase), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(force ? { "X-Force-Refresh": "true" } : {}) },
      body: JSON.stringify({
        profile,
        content_hash: contentHash,
        candidate_hash: candidateHash,
        profile_hash: profileHash,
        active_hash: activeHash,
        starters_hash: startersHash,
        audit_hash: auditHash,
      }),
    });
  } catch (cause) {
    throw new UpdateClientError("network_error", "Impossibile contattare il backend.", undefined, { cause });
  }
  if (action === "bundle" && response.ok) return response;
  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new UpdateClientError("invalid_response", "Il backend ha restituito una risposta non valida.", response.status, { cause });
  }
  if (!response.ok) {
    const code = payload.error?.code || "request_failed";
    const staleBackend = response.status === 404 && code === "not_found";
    throw new UpdateClientError(
      staleBackend ? "backend_restart_required" : code,
      staleBackend
        ? "Il backend in esecuzione non include ancora la funzione Aggiornamenti. Riavvialo e riprova."
        : payload.error?.message || `Errore ${response.status}`,
      response.status,
    );
  }
  return payload;
};

export const checkSosFanta = (profile, options) => updateRequest("sosfanta", "check", profile, options);
export const getSosFantaStatus = (profile, options) => updateRequest("sosfanta", "status", profile, options);
export const acceptSosFanta = (profile, options) => updateRequest("sosfanta", "accept", profile, options);
export const fetchSosFantaBundle = (profile, options) => updateRequest("sosfanta", "bundle", profile, options);
export const checkSosFantaFormations = (profile, options) => updateRequest("sosfanta-formations", "check", profile, options);
export const getSosFantaFormationStatus = (profile, options) => updateRequest("sosfanta-formations", "status", profile, options);
export const acceptSosFantaFormations = (profile, options) => updateRequest("sosfanta-formations", "accept", profile, options);
export const applySosFantaFormations = (profile, options) => updateRequest("sosfanta-formations", "apply", profile, options);
export const repairSosFantaFormationIdentities = (profile, options) => updateRequest("sosfanta-formations", "repair-identities", profile, options);
export const fetchSosFantaFormationBundle = (profile, options) => updateRequest("sosfanta-formations", "bundle", profile, options);
export const checkSosFantaSetPieces = (profile, options) => updateRequest("sosfanta-set-pieces", "check", profile, options);
export const getSosFantaSetPieceStatus = (profile, options) => updateRequest("sosfanta-set-pieces", "status", profile, options);
export const acceptSosFantaSetPieces = (profile, options) => updateRequest("sosfanta-set-pieces", "accept", profile, options);
export const fetchSosFantaSetPieceBundle = (profile, options) => updateRequest("sosfanta-set-pieces", "bundle", profile, options);
export const checkSosFantaGoalkeepers = (profile, options) => updateRequest("sosfanta-goalkeepers", "check", profile, options);
export const getSosFantaGoalkeeperStatus = (profile, options) => updateRequest("sosfanta-goalkeepers", "status", profile, options);
export const acceptSosFantaGoalkeepers = (profile, options) => updateRequest("sosfanta-goalkeepers", "accept", profile, options);
export const applySosFantaGoalkeepers = (profile, options) => updateRequest("sosfanta-goalkeepers", "apply", profile, options);

const seasonParts = (season) => {
  const match = String(season || "").trim().match(/^(\d{4})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2].length === 2 ? `${match[1].slice(0, 2)}${match[2]}` : match[2]);
  return end === start + 1 ? { start, end } : null;
};

export const fantacalcioDownloadUrl = (season) => {
  const years = seasonParts(season);
  return years ? `https://www.fantacalcio.it/api/v1/Excel/prices/${years.start - 2005}/1` : "";
};

export const checkPlayerList = (profile, options) => updateRequest("player-list", "check", profile, options);
export const getPlayerListStatus = (profile, options) => updateRequest("player-list", "status", profile, options);
export const applyPlayerList = (profile, candidateHash, profileHash, activeHash, startersHash, options = {}) =>
  updateRequest("player-list", "apply", profile, { ...options, candidateHash, profileHash, activeHash, startersHash });
export const getInjuryStatus = (profile, options) => updateRequest("injuries", "status", profile, options);
export const checkInjuries = (profile, options) => updateRequest("injuries", "check", profile, options);
export const getFcoStatus = (profile, options) => updateRequest("fco", "status", profile, options);
export const checkFco = (profile, options) => updateRequest("fco", "check", profile, options);

export const checkAllUpdateSources = async (profile, options = {}) => {
  const sources = [
    ["SOS Guida", checkSosFanta], ["SOS Formazioni", checkSosFantaFormations],
    ["SOS Piazzati", checkSosFantaSetPieces], ["Listone", checkPlayerList],
    ["SOS Portieri", checkSosFantaGoalkeepers], ["Disponibilità FCO", checkInjuries],
  ];
  const settled = await Promise.allSettled(sources.map(([, check]) => check(profile, options)));
  const rows = sources.map(([label], index) => ({ label, ...(settled[index].status === "fulfilled" ? { result: settled[index].value } : { error: settled[index].reason?.message || "Controllo non riuscito" }) }));
  try {
    const result = await checkFco(profile, options);
    rows.push(
      { label: "FCO Prestazioni", result: result.performance, error: result.errors?.performance },
      { label: "FCO Mercato", result: result.market, error: result.errors?.market },
      { label: "FCO Probabili", result: result.lineups, error: result.errors?.lineups },
      { label: "FCO Indici", result: result.forecast, error: result.errors?.forecast },
      { label: "FCO Contesto calendario", result: result.fixture_context, error: result.errors?.fixture_context },
    );
  } catch (error) {
    for (const label of ["FCO Prestazioni", "FCO Mercato", "FCO Probabili", "FCO Indici", "FCO Contesto calendario"])
      rows.push({ label, error: error?.message || "Controllo non riuscito" });
  }
  return rows;
};

export const uploadPlayerListCandidate = async (file, profile, { apiBase = "", fetchImpl = globalThis.fetch } = {}) => {
  const years = seasonParts(profile?.season?.season);
  if (!years) throw new UpdateClientError("invalid_season", "La stagione del profilo non è valida.");
  if (!file) throw new UpdateClientError("invalid_candidate", "Seleziona un file XLSX.");
  const slug = `${years.start}-${String(years.end).slice(-2)}`;
  let response;
  try {
    response = await fetchImpl(apiUrl(`/api/updates/player-list/candidate/${encodeURIComponent(profile.profile_id)}/${slug}`, apiBase), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "X-Filename": file.name },
      body: file,
    });
  } catch {
    throw new UpdateClientError("network_error", "Impossibile contattare il backend.");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new UpdateClientError("invalid_response", "Il backend ha restituito una risposta non valida.", response.status);
  }
  if (!response.ok)
    throw new UpdateClientError(payload.error?.code || "request_failed", payload.error?.message || `Errore ${response.status}`, response.status);
  return payload;
};

export const updateStateLabel = (state) => ({
  never_checked: "Non ancora verificato",
  baseline_missing: "Riferimento iniziale da salvare",
  unchanged: "Nessun aggiornamento",
  changed: "Aggiornamenti disponibili",
}[state] || "Non ancora verificato");

export const playerListStateLabel = (state) => ({
  never_uploaded: "Nessun file caricato",
  unchanged: "Listone già aggiornato",
  candidate_ready: "Pronto da applicare",
  changed: "Aggiornamento rilevato",
}[state] || "Non ancora verificato");
