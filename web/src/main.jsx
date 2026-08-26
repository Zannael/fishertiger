import { Component, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Download, Trash2, Upload } from "lucide-react";
import "./index.css";
import RandomAuctionView from "./random-auction.jsx";
import { LeagueSettings } from "./league-settings.jsx";
import { normalizeRules } from "./league-rules.js";
import { createRequestGate } from "./latest-request.js";
import { datasetFreshness, simulationFreshness } from "./dataset-freshness.js";
import { activeNominationRole } from "./auction-nomination.js";
import {
  auctionStorageKey,
  draftPlayer,
  emptyAuction,
  emptyDraft,
  isValidBid,
  legalMaxBid,
  playerIdKey,
  rehydrateAuction,
  serializeAuction,
  slotsLeft,
} from "./auction-state.js";
import {
  apiUrl,
  auctionDatasetPath,
  datasetPathError,
  deleteProfile,
  listProfiles,
  parseProfileJson,
  loadDatasetUrl,
  loadProfile,
  rulesFor,
  saveProfile,
  seasonSimulationPath,
} from "./profile-client.js";
import { createRoleValuation, sourceFvm } from "./player-valuation.js";

const ROLE_LABELS = {
  P: "Portieri",
  D: "Difensori",
  C: "Centrocampisti",
  A: "Attaccanti",
};
const formatTier = (tier) =>
  tier ? tier.replaceAll("_", " ") : "NON CLASSIFICATO";
const statusClass = (status) =>
  ({ TITOLARE: "good", BALLOTTAGGIO: "caution", RISERVA: "muted" })[status] ||
  "muted";

const fetchDefaultProfile = (apiBase) =>
  fetch(apiUrl("/api/default-profile", apiBase))
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);

const PROFILE_STORAGE_KEY = "fanta-profile-id";
// localStorage is unavailable in private windows and when site data is blocked.
const readStoredProfileId = () => {
  try {
    return localStorage.getItem(PROFILE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
};
const writeStoredProfileId = (id) => {
  try {
    if (id) localStorage.setItem(PROFILE_STORAGE_KEY, id);
    else localStorage.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    /* ignore: the picker still works for this session */
  }
};

const RECOMMENDATION_LABELS = {
  STRONG_BUY: "Compra",
  BID: "Conviene",
  VALUE_ONLY: "Solo al prezzo giusto",
  PASS: "Lascia andare",
  INELIGIBLE: "Non acquistabile",
};

function App() {
  const [data, setData] = useState(null);
  const [season, setSeason] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState("");
  const [profiles, setProfiles] = useState([]);
  // Lives in App, not in Auction: leaving the view unmounts Auction and would
  // otherwise throw away the player being nominated.
  const [auctionDraft, setAuctionDraft] = useState(emptyDraft());
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState("");
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationStatus, setSimulationStatus] = useState("");
  // ?? not ||: an empty base is a valid choice (same-origin behind a proxy).
  const apiBase =
    import.meta.env.VITE_LOCAL_API_BASE ?? "http://127.0.0.1:8000";
  const [view, setView] = useState("overview");
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [viewHistory, setViewHistory] = useState([
    { view: "overview", player: null, team: null },
  ]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const profileRequests = useRef(null);
  if (!profileRequests.current) profileRequests.current = createRequestGate();
  const claimProfileRequest = () => profileRequests.current.claim();
  const isCurrentProfileRequest = (request) =>
    profileRequests.current.isCurrent(request);
  const latestProfileRequest = () => profileRequests.current.latest();
  useEffect(() => {
    let cancelled = false;
    const request = claimProfileRequest();
    (async () => {
      let names = [];
      try {
        names = await listProfiles({ apiBase });
      } catch {
        names = [];
      }
      if (cancelled) return;
      setProfiles(names);
      const storedId = readStoredProfileId();
      let next = null;
      if (storedId && names.includes(storedId)) {
        next = await loadProfile(storedId, { apiBase }).catch(() => null);
      }
      if (!next) next = await fetchDefaultProfile(apiBase);
      if (!cancelled && isCurrentProfileRequest(request)) setProfile(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);
  useEffect(() => {
    if (!profile) return;
    // Never let path building throw inside an effect: an uncaught throw here
    // unmounts the whole tree and leaves a blank page.
    const pathError = datasetPathError(profile);
    if (pathError) {
      setProfileError(pathError);
      setData(null);
      setSeason(null);
      return;
    }
    let cancelled = false;
    const datasetPath = auctionDatasetPath(profile);
    loadDatasetUrl(apiUrl(`/api/datasets/${datasetPath}`, apiBase), { profile })
      .then((nextData) => {
        if (cancelled) return;
        setData(nextData);
        setSelectedTeam((team) => team || nextData.teams[0]?.squadra || null);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    fetch(apiUrl(`/api/datasets/${seasonSimulationPath(profile)}`, apiBase))
      .then((response) => (response.ok ? response.json() : null))
      .then((nextSeason) => {
        if (!cancelled) setSeason(nextSeason);
      })
      .catch(() => {
        if (!cancelled) setSeason(null);
      });
    setAuctionDraft(emptyDraft());
    return () => {
      cancelled = true;
    };
  }, [apiBase, profile]);
  useEffect(() => {
    const initialRoute = { view: "overview", player: null, team: null };
    window.history.replaceState(
      { fantaRoute: initialRoute, fantaIndex: 0 },
      "",
    );
    const restoreRoute = (event) => {
      const route = event.state?.fantaRoute;
      if (!route) return;
      setHistoryIndex(event.state.fantaIndex ?? 0);
      applyRoute(route);
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, []);
  const applyRoute = (route) => {
    setView(route.view);
    setSelectedPlayer(route.player);
    setSelectedTeam(route.team);
  };
  const navigate = (
    nextView,
    { player = selectedPlayer, team = selectedTeam } = {},
  ) => {
    const route = { view: nextView, player, team };
    setViewHistory((routes) => [...routes.slice(0, historyIndex + 1), route]);
    setHistoryIndex((index) => index + 1);
    window.history.pushState(
      { fantaRoute: route, fantaIndex: historyIndex + 1 },
      "",
    );
    applyRoute(route);
  };
  const moveThroughHistory = (direction) => {
    const nextIndex = historyIndex + direction;
    if (!viewHistory[nextIndex]) return;
    window.history.go(direction);
  };
  const openPlayer = (player) => navigate("players", { player });
  const activeRules = rulesFor(profile, data || {});
  const activeProfileId =
    profile?.profile_id || data?.meta?.profile?.profile_id || "default";
  const updateProfile = async (nextProfile, generate = false) => {
    setProfileError("");
    const pathError = datasetPathError(nextProfile);
    if (pathError) {
      setProfileError(pathError);
      throw new Error(pathError);
    }
    const request = claimProfileRequest();
    let saveWarning = "";
    // The PUT response is the profile as the API validated it, so state and
    // generation both use the stored version rather than the local edit.
    let savedProfile = null;
    try {
      const stored = await saveProfile(nextProfile, { apiBase });
      savedProfile = stored?.profile_id ? stored : nextProfile;
      setProfiles((current) =>
        current.includes(savedProfile.profile_id)
          ? current
          : [...current, savedProfile.profile_id].sort(),
      );
    } catch (error) {
      saveWarning = `Profilo non salvato su disco: ${
        error instanceof Error ? error.message : "errore sconosciuto"
      }.`;
    }
    const activeProfile = savedProfile || nextProfile;
    if (!isCurrentProfileRequest(request)) return;
    if (savedProfile) writeStoredProfileId(activeProfile.profile_id);
    setProfile(activeProfile);
    if (!generate) {
      if (saveWarning) {
        setProfileError(saveWarning);
        throw new Error(saveWarning);
      }
      return;
    }
    try {
      const response = await fetch(apiUrl("/api/generate", apiBase), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: activeProfile }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.dataset_path)
        throw new Error(
          payload.error?.message || "Generazione non completata.",
        );
      const nextData = await loadDatasetUrl(
        apiUrl(`/api/datasets/${payload.dataset_path}`, apiBase),
        { profile: activeProfile },
      );
      if (!isCurrentProfileRequest(request)) return;
      setData(nextData);
      setSeason(null);
      navigate("overview");
      if (saveWarning) setProfileError(saveWarning);
    } catch (error) {
      if (isCurrentProfileRequest(request))
        setProfileError(
          error instanceof Error
            ? error.message
            : "Impossibile generare il dataset del profilo.",
        );
      throw error;
    }
  };
  const selectProfile = async (id) => {
    setProfileError("");
    const request = claimProfileRequest();
    if (!id) {
      const fallback = await fetchDefaultProfile(apiBase);
      if (!isCurrentProfileRequest(request)) return;
      writeStoredProfileId("");
      setProfile(fallback);
      return;
    }
    try {
      const next = await loadProfile(id, { apiBase });
      if (!isCurrentProfileRequest(request)) return;
      writeStoredProfileId(id);
      setProfile(next);
    } catch (error) {
      if (!isCurrentProfileRequest(request)) return;
      setProfileError(
        error instanceof Error
          ? error.message
          : "Impossibile caricare il profilo salvato.",
      );
    }
  };
  const removeProfile = async (id) => {
    if (!id) return;
    if (
      !window.confirm(
        `Rimuovere il profilo "${id}"? I dati gia generati restano su disco.`,
      )
    )
      return;
    setProfileError("");
    try {
      await deleteProfile(id, { apiBase });
    } catch (error) {
      setProfileError(
        error instanceof Error
          ? error.message
          : "Impossibile rimuovere il profilo.",
      );
      return;
    }
    setProfiles((current) => current.filter((name) => name !== id));
    if (readStoredProfileId() === id) writeStoredProfileId("");
    if (profile?.profile_id === id) {
      const request = claimProfileRequest();
      const fallback = await fetchDefaultProfile(apiBase);
      if (isCurrentProfileRequest(request)) setProfile(fallback);
    }
  };
  const exportProfile = () => {
    if (!profile) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(profile, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${profile.profile_id || "profilo"}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
  const importProfile = async (file) => {
    if (!file) return;
    setProfileError("");
    let incoming;
    try {
      incoming = parseProfileJson(await file.text());
    } catch (error) {
      setProfileError(
        error instanceof Error ? error.message : "File del profilo non valido.",
      );
      return;
    }
    if (
      profiles.includes(incoming.profile_id) &&
      !window.confirm(
        `Esiste gia un profilo "${incoming.profile_id}". Sovrascriverlo?`,
      )
    )
      return;
    const request = claimProfileRequest();
    try {
      const stored = await saveProfile(incoming, { apiBase });
      const id = stored?.profile_id || incoming.profile_id;
      setProfiles((current) =>
        current.includes(id) ? current : [...current, id].sort(),
      );
      if (!isCurrentProfileRequest(request)) return;
      writeStoredProfileId(id);
      setProfile(stored || incoming);
      setAuctionDraft(emptyDraft());
    } catch (error) {
      if (!isCurrentProfileRequest(request)) return;
      setProfileError(
        error instanceof Error
          ? error.message
          : "Impossibile importare il profilo.",
      );
    }
  };
  const profilePicker = (
    <div className="profile-picker">
      <label htmlFor="profile-select">Profilo</label>
      <select
        id="profile-select"
        value={profiles.includes(profile?.profile_id) ? profile.profile_id : ""}
        onChange={(event) => selectProfile(event.target.value)}
      >
        <option value="">Profilo predefinito</option>
        {profiles.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="profile-icon"
        onClick={exportProfile}
        disabled={!profile}
        title="Esporta"
        aria-label="Esporta"
      >
        <Download size={16} aria-hidden="true" />
      </button>
      <label className="profile-icon profile-import" title="Importa">
        <input
          type="file"
          accept=".json,application/json"
          aria-label="Importa"
          onChange={(event) => {
            importProfile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <Upload size={16} aria-hidden="true" />
      </label>
      <button
        type="button"
        className="profile-icon danger"
        onClick={() => removeProfile(profile?.profile_id)}
        disabled={!profiles.includes(profile?.profile_id)}
        title="Elimina"
        aria-label="Elimina"
      >
        <Trash2 size={16} aria-hidden="true" />
      </button>
    </div>
  );
  const regenerateData = async () => {
    if (!profile || isGenerating) return;
    setIsGenerating(true);
    setGenerationStatus("Rigenerazione in corso...");
    try {
      await updateProfile(profile, true);
      setGenerationStatus("Dati rigenerati.");
    } catch (error) {
      setGenerationStatus("Rigenerazione non riuscita.");
    } finally {
      setIsGenerating(false);
    }
  };
  const rerunSimulation = async () => {
    if (isSimulating) return;
    const request = latestProfileRequest();
    setIsSimulating(true);
    setSimulationStatus("Simulazione in corso...");
    try {
      const response = await fetch(apiUrl("/api/simulate", apiBase), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, iterations: 1000, seed: 202627 }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message || "Simulazione non completata.");
      if (!isCurrentProfileRequest(request)) {
        setSimulationStatus("");
        return;
      }
      setSeason(result);
      setSimulationStatus("Simulazione aggiornata.");
    } catch (error) {
      setSimulationStatus(
        isCurrentProfileRequest(request) ? "Simulazione non riuscita." : "",
      );
    } finally {
      setIsSimulating(false);
    }
  };
  const nav = [
    ["overview", "Sintesi"],
    ["players", "Giocatori"],
    ["teams", "Squadre"],
    ["setpieces", "Piazzati"],
    ["simulation", "Simulazione"],
    ["auction", "Asta live"],
    ["settings", "Impostazioni"],
  ];
  if (!profile)
    return <main className="loading">Caricamento profilo locale...</main>;
  if (!data)
    return (
      <main className="app-shell">
        <section className="data-view">
          <div className="view-heading">
            <span className="eyebrow">CONFIGURAZIONE INIZIALE</span>
            <h1>Genera il tuo dataset</h1>
            <p>
              Carica il calendario della tua lega nelle Impostazioni e genera i
              dati per iniziare.
            </p>
          </div>
          <div className="profile-picker-row">{profilePicker}</div>{" "}
          <LeagueSettings
            initialProfile={profile}
            leagueCalendar={null}
            apiBase={apiBase}
            onSave={(nextProfile) => updateProfile(nextProfile)}
            onGenerate={(nextProfile) => updateProfile(nextProfile, true)}
          />
          {profileError && (
            <p className="profile-error" role="alert">
              {profileError}
            </p>
          )}
        </section>
      </main>
    );
  const datasetState = datasetFreshness(profile, data);
  const simulationState = simulationFreshness(data, season);
  return (
    <main className="app-shell">
      <header className="app-header">
        <button className="brand" onClick={() => navigate("overview")}>
          <span>{profile?.season?.season || "FANTACALCIO"}</span>
          <strong>Control room</strong>
        </button>
        <div
          className="history-controls"
          aria-label="Cronologia di navigazione"
        >
          <button
            onClick={() => moveThroughHistory(-1)}
            disabled={historyIndex === 0}
            aria-label="Vista precedente"
            title="Indietro"
          >
            &larr;
          </button>
          <button
            onClick={() => moveThroughHistory(1)}
            disabled={historyIndex === viewHistory.length - 1}
            aria-label="Vista successiva"
            title="Avanti"
          >
            &rarr;
          </button>
        </div>
        <nav>
          {nav.map(([id, label]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => navigate(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        {profilePicker}
        <div
          className={`data-status ${
            datasetState === "dataset corrente" ? "current" : "stale"
          }`}
        >
          <i />
          {datasetState}
          <br />
          <small>
            {generationStatus ||
              `${simulationState} · ${
                data.meta?.generato_il?.slice(0, 10) || "profilo locale"
              }`}
          </small>
          <button
            className="regenerate-data"
            onClick={regenerateData}
            disabled={!profile || isGenerating}
          >
            {isGenerating ? "Rigenerazione..." : "Rigenera dati"}
          </button>
        </div>
      </header>
      {view === "overview" && (
        <Overview
          data={data}
          openPlayer={openPlayer}
          openTeam={(team) => navigate("teams", { team })}
        />
      )}
      {view === "players" && (
        <PlayersView
          data={data}
          rules={activeRules}
          selected={selectedPlayer}
          setSelected={setSelectedPlayer}
        />
      )}
      {view === "teams" && (
        <TeamsView
          data={data}
          selectedTeam={selectedTeam}
          setSelectedTeam={setSelectedTeam}
          openPlayer={openPlayer}
        />
      )}
      {view === "setpieces" && (
        <SetPiecesView data={data} openPlayer={openPlayer} />
      )}
      {view === "simulation" && (
        <SeasonView
          season={season}
          data={data}
          openPlayer={openPlayer}
          rules={activeRules}
          profileId={activeProfileId}
          onRerun={rerunSimulation}
          isSimulating={isSimulating}
          simulationStatus={simulationStatus}
        />
      )}
      {view === "auction" && (
        <Auction
          data={data}
          openPlayer={openPlayer}
          rules={activeRules}
          profileId={activeProfileId}
          draft={auctionDraft}
          setDraft={setAuctionDraft}
        />
      )}
      {view === "settings" && (
        <>
          <LeagueSettings
            initialProfile={profile}
            leagueCalendar={data.calendario_lega || data.calendar}
            apiBase={apiBase}
            onSave={(nextProfile) => updateProfile(nextProfile)}
            onGenerate={(nextProfile) => updateProfile(nextProfile, true)}
          />
          {profileError && (
            <p className="profile-error" role="alert">
              {profileError}
            </p>
          )}
        </>
      )}
    </main>
  );
}

function SeasonView({
  season,
  data,
  openPlayer,
  rules,
  profileId,
  onRerun,
  isSimulating,
  simulationStatus,
}) {
  const [mode, setMode] = useState("report");
  return (
    <>
      <div
        className="simulation-mode"
        role="group"
        aria-label="Modalita simulazione"
      >
        <button
          className={mode === "report" ? "active" : ""}
          onClick={() => setMode("report")}
          aria-pressed={mode === "report"}
        >
          Report rose
        </button>
        <button
          className={mode === "auction" ? "active" : ""}
          onClick={() => setMode("auction")}
          aria-pressed={mode === "auction"}
        >
          Asta casuale
        </button>
      </div>
      {mode === "auction" ? (
        <RandomAuctionView data={data} rules={rules} profileId={profileId} />
      ) : (
        <SeasonReport
          season={season}
          data={data}
          openPlayer={openPlayer}
          onRerun={onRerun}
          isSimulating={isSimulating}
          simulationStatus={simulationStatus}
        />
      )}
    </>
  );
}

function SeasonReport({
  season,
  data,
  openPlayer,
  onRerun,
  isSimulating,
  simulationStatus,
}) {
  const [selected, setSelected] = useState(null);
  if (!data.calendario_lega)
    return (
      <section className="data-view">
        <div className="view-heading">
          <span className="eyebrow">MONTE CARLO OFFLINE</span>
          <h1>Calendario della lega richiesto</h1>
          <p>
            Puoi usare dashboard, proiezioni e asta. Carica il calendario della
            lega nelle Impostazioni per simulare la stagione.
          </p>
        </div>
      </section>
    );
  if (!season)
    return (
      <section className="data-view">
        <div className="view-heading">
          <span className="eyebrow">MONTE CARLO OFFLINE</span>
          <h1>Simulazione non generata</h1>
          <p>
            Avvia una simulazione per costruire il report pre-asta sulle rose
            esempio.
          </p>
          <SimulationRunButton
            onRerun={onRerun}
            isSimulating={isSimulating}
            status={simulationStatus}
          />
        </div>
      </section>
    );
  const rows = Object.entries(season.teams).sort(
    ([, a], [, b]) => b.expected_utility - a.expected_utility,
  );
  const activeTeam = selected || rows[0][0];
  const roster = (season.rosters[activeTeam] || [])
    .map((id) => data.players.find((p) => p.id === id))
    .filter(Boolean)
    .sort(
      (a, b) => a.ruolo.localeCompare(b.ruolo) || b.fvm_scaled - a.fvm_scaled,
    );
  const scenario = season.scenarios?.[activeTeam];
  return (
    <section className="data-view">
      <div className="view-heading">
        <span className="eyebrow">MONTE CARLO OFFLINE</span>
        <h1>Esiti delle rose esempio</h1>
        <p>
          {season.iterations.toLocaleString("it-IT")} stagioni simulate · seed{" "}
          {season.diagnostics.seed} ·{" "}
          {data.calendario_lega?.matchdays?.length || "n/d"} giornate di lega
        </p>
        <SimulationRunButton
          onRerun={onRerun}
          isSimulating={isSimulating}
          status={simulationStatus}
        />
      </div>
      <section className="panel simulation-report">
        <div className="sim-header">
          <span>Rosa esempio</span>
          <span>Utilità attesa</span>
          <span>Top 3</span>
          <span>Punti attesi</span>
          <span>Punteggio stagionale</span>
        </div>
        {rows.map(([team, result], index) => (
          <button
            className={activeTeam === team ? "selected" : ""}
            onClick={() => setSelected(team)}
            key={team}
          >
            <b>{index + 1}</b>
            <strong>{team}</strong>
            <span className={result.expected_utility >= 0 ? "up" : "down"}>
              {result.expected_utility >= 0 ? "+" : ""}
              {result.expected_utility.toFixed(0)} EUR
            </span>
            <span>{(result.top3_probability * 100).toFixed(1)}%</span>
            <span>{result.expected_points.toFixed(1)}</span>
            <span>
              {result.expected_score.toFixed(0)}{" "}
              <small>
                P05 {result.score_p05.toFixed(0)} · P95{" "}
                {result.score_p95.toFixed(0)}
              </small>
            </span>
          </button>
        ))}
      </section>
      <section className="scenario-grid">
        <div className="panel simulated-roster">
          <div className="panel-title">
            <div>
              <span className="eyebrow">ROSA SELEZIONATA</span>
              <h2>{activeTeam}</h2>
            </div>
            <span className="count">{roster.length} giocatori</span>
          </div>
          <div>
            {roster.map((player) => (
              <button key={player.id} onClick={() => openPlayer(player)}>
                <i className={"role " + player.ruolo}>{player.ruolo}</i>
                <span>
                  <b>{player.nome}</b>
                  <small>
                    {player.squadra} · {formatTier(player.guida_asta_fascia)}
                  </small>
                </span>
                <em>{player.fvm_scaled}</em>
              </button>
            ))}
          </div>
        </div>
        <div className="panel extremes">
          <span className="eyebrow">ESTREMI OSSERVATI</span>
          <h2>Range della stessa rosa</h2>
          <div className="best">
            <span>Migliore stagione estratta</span>
            <strong>{scenario?.best_score}</strong>
            <p>
              {scenario?.best_points} punti · {scenario?.best_rank}° posto
            </p>
          </div>
          <div className="worst">
            <span>Peggiore stagione estratta</span>
            <strong>{scenario?.worst_score}</strong>
            <p>
              {scenario?.worst_points} punti · {scenario?.worst_rank}° posto
            </p>
          </div>
          <p className="micro">
            Sono gli estremi realizzati nelle{" "}
            {season.iterations.toLocaleString("it-IT")} simulazioni: mostrano la
            variabilità, non una previsione puntuale.
          </p>
        </div>
      </section>
      <section className="panel simulation-note">
        <b>Come leggere questo report</b>
        <p>
          Le rose sono generate automaticamente con snake draft bilanciato sui
          valori FVM. Ora puoi ispezionare ogni rosa e capire quali profili
          producono i risultati migliori e peggiori; non rappresentano ancora le
          rose della tua lega reale.
        </p>
      </section>
    </section>
  );
}

function SimulationRunButton({ onRerun, isSimulating, status }) {
  return (
    <div className="simulation-run">
      <button onClick={onRerun} disabled={isSimulating}>
        {isSimulating ? "Simulazione in corso..." : "Riesegui Monte Carlo"}
      </button>
      {status && <small role="status">{status}</small>}
    </div>
  );
}

function Overview({ data, openPlayer, openTeam }) {
  const roleCounts = Object.keys(ROLE_LABELS).map((role) => ({
    role,
    count: data.players.filter((p) => p.ruolo === role).length,
  }));
  const top = data.players
    .filter((p) =>
      ["SUPER TOP", "TOP", "SEMITOP"].includes(formatTier(p.guida_asta_fascia)),
    )
    .sort((a, b) => b.fvm_scaled - a.fvm_scaled)
    .slice(0, 8);
  const injury = data.players.filter(
    (p) => p.guida_asta_fascia === "INFORTUNATO",
  );
  return (
    <>
      <section className="hero">
        <div>
          <span className="eyebrow">DATABASE OFFLINE</span>
          <h1>
            Tutto il tuo fanta,
            <br />
            in una sola vista.
          </h1>
          <p>
            Proiezioni, storico, guide editoriali, calendario e gerarchie sui
            piazzati. Nessuna connessione richiesta durante l’asta.
          </p>
        </div>
        <div className="hero-card">
          <span>Copertura dati</span>
          <strong>
            {data.players.length}
            <small> giocatori</small>
          </strong>
          <p>
            {data.teams.length} squadre Serie A ·{" "}
            {data.calendario_serie_a?.length / 10 || "n/d"} giornate ·{" "}
            {data.set_pieces.length} gerarchie piazzati
          </p>
        </div>
      </section>
      <section className="metric-grid">
        {roleCounts.map((item) => (
          <button
            className="metric"
            key={item.role}
            onClick={() =>
              openPlayer(data.players.find((p) => p.ruolo === item.role))
            }
          >
            <span className={"role " + item.role}>{item.role}</span>
            <strong>{item.count}</strong>
            <small>{ROLE_LABELS[item.role]}</small>
          </button>
        ))}
        <div className="metric accent">
          <span>Fasce SOS</span>
          <strong>
            {data.players.filter((p) => p.guida_asta_fascia).length}
          </strong>
          <small>profili classificati</small>
        </div>
      </section>
      <section className="split-layout">
        <div className="panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">PRIME SCELTE</span>
              <h2>Valore e proiezione</h2>
            </div>
            <button onClick={() => openPlayer(top[0])}>
              Tutti i giocatori
            </button>
          </div>
          <div className="rank-list">
            {top.map((player, index) => (
              <button key={player.id} onClick={() => openPlayer(player)}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <span className={"role " + player.ruolo}>{player.ruolo}</span>
                <div>
                  <strong>{player.nome}</strong>
                  <small>
                    {player.squadra} · {formatTier(player.guida_asta_fascia)}
                  </small>
                </div>
                <em>{player.fvm_scaled}</em>
              </button>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">DA MONITORARE</span>
              <h2>Infortunati</h2>
            </div>
            <span className="count">{injury.length}</span>
          </div>
          <div className="watch-list">
            {injury.length ? (
              injury.map((player) => (
                <button key={player.id} onClick={() => openPlayer(player)}>
                  <span className={"role " + player.ruolo}>{player.ruolo}</span>
                  <div>
                    <strong>{player.nome}</strong>
                    <small>{player.squadra}</small>
                  </div>
                  <span className="status muted">RECUPERO</span>
                </button>
              ))
            ) : (
              <p>Nessun infortunato classificato.</p>
            )}
          </div>
        </div>
      </section>
      <section className="panel team-directory">
        <div className="panel-title">
          <div>
            <span className="eyebrow">SERIE A</span>
            <h2>Esplora le squadre</h2>
          </div>
          <button onClick={() => openTeam(data.teams[0]?.squadra)}>
            Calendari e rose
          </button>
        </div>
        <div>
          {data.teams.map((team) => (
            <button key={team.squadra} onClick={() => openTeam(team.squadra)}>
              <strong>{team.squadra}</strong>
              <small>
                ATT {team.rating_att}/10 · DIF {team.rating_dif}/10
              </small>
              {team.coppa_europea && <span>{team.coppa_europea}</span>}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

function PlayersView({ data, rules, selected, setSelected }) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("TUTTI");
  const [team, setTeam] = useState("TUTTE");
  const valuation = createRoleValuation(data.players, rules);
  const rows = data.players
    .filter(
      (p) =>
        (role === "TUTTI" || p.ruolo === role) &&
        (team === "TUTTE" || p.squadra === team) &&
        p.nome.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => valuation.normalizedFvm(b) - valuation.normalizedFvm(a));
  const player = selected || rows[0];
  return (
    <section className="data-view">
      <div className="view-heading">
        <span className="eyebrow">DATABASE GIOCATORI</span>
        <h1>Profili, storico e proiezioni</h1>
      </div>
      <div className="filters">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cerca un giocatore"
        />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option>TUTTI</option>
          {Object.keys(ROLE_LABELS).map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <select value={team} onChange={(e) => setTeam(e.target.value)}>
          <option>TUTTE</option>
          {data.teams.map((t) => (
            <option key={t.squadra}>{t.squadra}</option>
          ))}
        </select>
        <span>{rows.length} risultati</span>
      </div>
      <div className="player-layout">
        <div className="player-table">
          <div className="table-head">
            <span>Giocatore</span>
            <span>Disponibilita</span>
            <span>Valore ruolo</span>
            <span>Proiezione FV</span>
          </div>
          {rows.map((p) => (
            <button
              className={player?.id === p.id ? "selected" : ""}
              key={p.id}
              onClick={() => setSelected(p)}
            >
              <span>
                <i className={"role " + p.ruolo}>{p.ruolo}</i>
                <b>{p.nome}</b>
                <small>
                  {p.squadra} · {formatTier(p.guida_asta_fascia)}
                </small>
              </span>
              <span className={"status " + statusClass(p.disponibilita.status)}>
                {p.disponibilita.status.replace("_", " ")}
              </span>
              <strong>{valuation.normalizedFvm(p).toFixed(1)}</strong>
              <span>{p.proiezione.fantavoto.toFixed(2)}</span>
            </button>
          ))}
        </div>
        {player && <PlayerDetail player={player} valuation={valuation} />}
      </div>
    </section>
  );
}

function PlayerDetail({ player, valuation }) {
  const history = Object.entries(player.storico);
  const outliers = valuation.outliersFor(player);
  return (
    <aside className="player-detail">
      <div className="detail-top">
        <span className={"role " + player.ruolo}>{player.ruolo}</span>
        <span className="tier">{formatTier(player.guida_asta_fascia)}</span>
      </div>
      <h2>{player.nome}</h2>
      <p>
        {player.squadra} · Mantra {player.ruoli_mantra || "n/d"}
      </p>
      <div className="projection">
        <div>
          <span>FVM fonte</span>
          <b>{sourceFvm(player).toFixed(2)}</b>
        </div>
        <div>
          <span>Valore ruolo</span>
          <b>{valuation.normalizedFvm(player).toFixed(2)}</b>
        </div>
        <div>
          <span>Prob. voto</span>
          <b>{Math.round(player.proiezione.p_gioca * 100)}%</b>
        </div>
        <div>
          <span>Fanta voto</span>
          <b>{player.proiezione.fantavoto.toFixed(2)}</b>
        </div>
      </div>
      <p className="valuation-source-note">
        FVM fonte: colonna FVM del listone Fantacalcio su base 1000. Il valore
        ruolo lo normalizza sul budget configurato per il reparto.
      </p>
      {outliers.length > 0 && (
        <div className="valuation-warning" role="note">
          <b>Valore da verificare</b>
          {outliers.map((outlier) => (
            <span key={outlier.code}>{outlier.label}</span>
          ))}
        </div>
      )}
      <div className="quote-row">
        <span>
          Qt. attuale <b>{player.quotazioni.attuale}</b>
        </span>
        <span>
          Iniziale <b>{player.quotazioni.iniziale}</b>
        </span>
        <span className={player.quotazioni.differenza >= 0 ? "up" : "down"}>
          {player.quotazioni.differenza >= 0 ? "+" : ""}
          {player.quotazioni.differenza}
        </span>
      </div>
      <h3>Storico</h3>
      <div className="history">
        {history.length ? (
          history.map(([season, stat]) => (
            <div key={season}>
              <b>{season}</b>
              <span>
                PV {stat.Pv} · MV {stat.Mv ?? "—"} · FM {stat.Fm ?? "—"}
              </span>
              <small>
                G {stat.Gf} · A {stat.Ass} · Amm {stat.Amm}
              </small>
            </div>
          ))
        ) : (
          <p>Nessuno storico nel listone.</p>
        )}
      </div>
      <div className="note">
        <b>{player.disponibilita.status.replace("_", " ")}</b>
        <p>{player.disponibilita.nota || "Stima ricavata dallo storico."}</p>
      </div>
    </aside>
  );
}

function TeamsView({ data, selectedTeam, setSelectedTeam, openPlayer }) {
  const team =
    data.teams.find((t) => t.squadra === selectedTeam) || data.teams[0];
  const players = team.player_ids
    .map((id) => data.players.find((p) => p.id === id))
    .filter(Boolean)
    .sort(
      (a, b) => a.ruolo.localeCompare(b.ruolo) || b.fvm_scaled - a.fvm_scaled,
    );
  const pieces = data.set_pieces.filter((p) => p.squadra === team.squadra);
  return (
    <section className="data-view">
      <div className="view-heading">
        <span className="eyebrow">SQUADRE SERIE A</span>
        <h1>Calendario, rosa e piazzati</h1>
      </div>
      <div className="team-picker">
        {data.teams.map((t) => (
          <button
            className={t.squadra === team.squadra ? "active" : ""}
            key={t.squadra}
            onClick={() => setSelectedTeam(t.squadra)}
          >
            {t.squadra}
          </button>
        ))}
      </div>
      <section className="team-hero">
        <div>
          <span className="eyebrow">
            {team.coppa_europea || "NESSUNA COPPA"}
          </span>
          <h2>{team.squadra}</h2>
          <p>
            {team.promossa ? "Neopromossa" : "Serie A"} · Rating attacco{" "}
            {team.rating_att}/10 · difesa {team.rating_dif}/10
          </p>
        </div>
        <div className="team-stats">
          <span>
            Punti prec.<b>{team.punti_prec}</b>
          </span>
          <span>
            GF / GS
            <b>
              {team.gf_prec} / {team.gs_prec}
            </b>
          </span>
          <span>
            xG / xGA
            <b>
              {team.xg_prec ?? "—"} / {team.xga_prec ?? "—"}
            </b>
          </span>
        </div>
      </section>
      <div className="team-grid">
        <section className="panel fixtures">
          <div className="panel-title">
            <div>
              <span className="eyebrow">CALENDARIO</span>
              <h2>Alternanza casa / trasferta</h2>
            </div>
            <span className="legend">
              <i className="home" />
              Casa <i className="away" />
              Trasferta
            </span>
          </div>
          <div className="fixture-grid">
            {team.fixtures.map((f) => (
              <div
                className={f.venue === "CASA" ? "home" : "away"}
                key={f.matchday}
              >
                <small>G{f.matchday}</small>
                <b>
                  {f.venue === "CASA" ? "vs" : "@"} {f.opponent}
                </b>
              </div>
            ))}
          </div>
        </section>
        <section className="panel setpiece-mini">
          <div className="panel-title">
            <div>
              <span className="eyebrow">PIAZZATI</span>
              <h2>Gerarchie</h2>
            </div>
          </div>
          {pieces.map((piece) => (
            <div key={piece.tipo}>
              <b>{piece.tipo}</b>
              {piece.takers.map((taker) => (
                <button
                  onClick={() =>
                    openPlayer(
                      data.players.find((p) => p.id === taker.player_id),
                    )
                  }
                  key={taker.player_id}
                >
                  {taker.nome}
                  <span>P{taker.priorita}</span>
                </button>
              ))}
            </div>
          ))}
        </section>
      </div>
      <section className="panel roster">
        <div className="panel-title">
          <div>
            <span className="eyebrow">ROSA LISTONE</span>
            <h2>{players.length} giocatori</h2>
          </div>
        </div>
        <div>
          {players.map((player) => (
            <button key={player.id} onClick={() => openPlayer(player)}>
              <i className={"role " + player.ruolo}>{player.ruolo}</i>
              <b>{player.nome}</b>
              <span
                className={"status " + statusClass(player.disponibilita.status)}
              >
                {player.disponibilita.status.replace("_", " ")}
              </span>
              <em>{player.fvm_scaled}</em>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}

function SetPiecesView({ data, openPlayer }) {
  const types = ["RIGORI", "PUNIZIONI", "CORNER"];
  return (
    <section className="data-view">
      <div className="view-heading">
        <span className="eyebrow">SPECIALISTI</span>
        <h1>Rigoristi, punizioni e corner</h1>
        <p>
          Le gerarchie aperte non hanno un primo designato: il modello evita di
          assegnare loro un bonus artificiale.
        </p>
      </div>
      <div className="setpiece-board">
        {data.teams.map((team) => (
          <article key={team.squadra}>
            <h2>{team.squadra}</h2>
            {types.map((type) => {
              const item = data.set_pieces.find(
                (p) => p.squadra === team.squadra && p.tipo === type,
              );
              return (
                <div key={type}>
                  <span>{type}</span>
                  {item?.takers.length ? (
                    item.takers.map((taker) => (
                      <button
                        key={taker.player_id}
                        onClick={() =>
                          openPlayer(
                            data.players.find((p) => p.id === taker.player_id),
                          )
                        }
                      >
                        {taker.nome}
                        <b>P{taker.priorita}</b>
                      </button>
                    ))
                  ) : (
                    <em>Da definire</em>
                  )}
                </div>
              );
            })}
          </article>
        ))}
      </div>
    </section>
  );
}

function AuctionStrategy({ advice }) {
  const recommendation =
    RECOMMENDATION_LABELS[advice.recommendation] || "Valuta";
  return (
    <section
      className={`strategy-panel ${advice.recommendation.toLowerCase()}`}
      aria-label="Consiglio strategico per la mia squadra"
    >
      <div className="strategy-verdict">
        <span className="strategy-kicker">CONSIGLIO PER LA MIA SQUADRA</span>
        <strong>{recommendation}</strong>
        <small>Confidenza {Math.round(advice.confidence * 100)}%</small>
      </div>
      <div className="strategy-prices">
        <div>
          <span>Fascia ideale</span>
          <strong>
            {advice.idealMin}-{advice.idealMax}
          </strong>
          <small>crediti</small>
        </div>
        <div>
          <span>Non superare</span>
          <strong>{advice.maxBid}</strong>
          <small>limite di valore</small>
        </div>
        <div>
          <span>Mercato stimato</span>
          <strong>{advice.summary.estimatedMarketPrice ?? "-"}</strong>
          <small>
            FVM {advice.summary.sourceFvm ?? "-"} · normalizzato{" "}
            {advice.summary.normalizedFvm ?? "-"}
          </small>
        </div>
      </div>
      <div className="strategy-explanation">
        <div>
          <h3>Perche</h3>
          {advice.reasons.slice(0, 3).map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
        </div>
        <div>
          <h3>Attenzione</h3>
          {advice.risks.length ? (
            advice.risks.slice(0, 3).map((risk) => <p key={risk}>{risk}</p>)
          ) : (
            <p>Nessun rischio specifico rilevato.</p>
          )}
        </div>
      </div>
      <div className="strategy-bottom">
        <div className="role-plan">
          <h3>Piano rosa</h3>
          {Object.entries(advice.rolePlan).map(([role, plan]) => (
            <div key={role}>
              <span className={`role ${role}`}>{role}</span>
              <b>{plan.open ? `${plan.open} posti` : "Completo"}</b>
              <small>
                {plan.open
                  ? `Target ${plan.budgetTarget} · residuo ${plan.budgetRemaining}`
                  : `${plan.owned} acquistati`}
              </small>
            </div>
          ))}
        </div>
        <div className="strategy-alternatives">
          <h3>Alternative</h3>
          {advice.alternatives.length ? (
            advice.alternatives.map((alternative) => (
              <div key={alternative.id}>
                <b>{alternative.name}</b>
                <span>stima {alternative.estimatedCost} cr.</span>
              </div>
            ))
          ) : (
            <p>Nessuna alternativa comparabile disponibile.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function AuctionOverview({ overview }) {
  if (!overview) return null;
  return (
    <section
      className="strategy-overview"
      aria-label="Piano strategico della mia squadra"
    >
      <div className="overview-heading">
        <div>
          <span className="eyebrow">PIANO AGGIORNATO</span>
          <h2>Prossime mosse</h2>
        </div>
        <div className="spendable">
          <span>Budget spendibile</span>
          <strong>{overview.summary.spendableCredits}</strong>
          <small>
            + {overview.summary.reservedCredits} riservati agli slot
          </small>
        </div>
      </div>
      <div className="priority-grid">
        {overview.priorities.map((priority) => {
          const plan = overview.rolePlan[priority.role];
          return (
            <article
              className={`priority ${priority.urgency.toLowerCase()}`}
              key={priority.role}
            >
              <div>
                <span className={`role ${priority.role}`}>{priority.role}</span>
                <b>{ROLE_LABELS[priority.role]}</b>
                <em>{priority.urgency}</em>
              </div>
              <strong>
                {plan.budgetTarget}
                <small> crediti obiettivo</small>
              </strong>
              <p>{priority.reason}</p>
            </article>
          );
        })}
      </div>
      <p className="market-line">
        Mercato rilevato: <b>{overview.summary.marketInflation.toFixed(2)}x</b>{" "}
        rispetto ai valori base. Il piano si aggiorna dopo ogni assegnazione.
      </p>
    </section>
  );
}

function Auction({ data, openPlayer, rules, profileId, draft, setDraft }) {
  const activeRules = normalizeRules(
    rules ?? data.league_rules ?? { startingCredits: 750 },
  );
  const activeProfileId = String(
    profileId ?? data.profileId ?? data.profile_id ?? "default",
  );
  const storageKey = auctionStorageKey(activeProfileId);
  const rulesSignature = JSON.stringify(activeRules);
  const configuredUserIndex = Number(activeRules.userTeam);
  const defaultUserTeamIndex = Math.max(
    0,
    Number.isInteger(configuredUserIndex) &&
      configuredUserIndex >= 0 &&
      configuredUserIndex < activeRules.participants
      ? configuredUserIndex
      : (activeRules.teamNames?.indexOf(activeRules.userTeam) ?? -1),
  );
  const loadAuction = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      const legacy =
        !saved && activeProfileId === "default"
          ? JSON.parse(localStorage.getItem("fanta-auction-v1") || "null")
          : null;
      return (
        rehydrateAuction(saved || legacy, data.players, activeRules) ||
        emptyAuction(activeRules)
      );
    } catch {
      return emptyAuction(activeRules);
    }
  };
  const [state, setState] = useState(() => {
    return loadAuction();
  });
  const [userTeamIndex, setUserTeamIndex] = useState(defaultUserTeamIndex);
  const { query, price } = draft;
  const setQuery = (value) =>
    setDraft((current) => ({ ...current, query: value }));
  const setPrice = (value) =>
    setDraft((current) => ({ ...current, price: value }));
  // The draft stores an id, so a regenerated dataset can never leave a stale
  // player object selected.
  const player = draftPlayer(draft, data.players);
  const setPlayer = (candidate) =>
    setDraft((current) => ({
      ...current,
      playerId: candidate ? candidate.id : null,
    }));
  const [owner, setOwner] = useState(userTeamIndex);
  const [advice, setAdvice] = useState(null);
  const [overviewAdvice, setOverviewAdvice] = useState(null);
  const [message, setMessage] = useState(
    "Cerca un giocatore e assegna il suo prezzo.",
  );
  const [messageType, setMessageType] = useState("info");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const worker = useRef();
  const skipPersist = useRef(false);
  const workerHistory = state.history.flatMap((transaction) => {
    const transactionPlayer = data.players.find(
      (candidate) =>
        playerIdKey(candidate.id) === playerIdKey(transaction.playerId),
    );
    return transactionPlayer
      ? [{ ...transaction, player: transactionPlayer }]
      : [];
  });
  const resetSignature = `${storageKey}|${rulesSignature}|${defaultUserTeamIndex}`;
  const lastResetSignature = useRef(resetSignature);
  useEffect(() => {
    skipPersist.current = true;
    setState(loadAuction());
    setUserTeamIndex(defaultUserTeamIndex);
    setOwner(defaultUserTeamIndex);
    // This effect also runs on every remount, so clear the nomination only when
    // the profile or the rules actually changed - not when returning to the view.
    if (lastResetSignature.current !== resetSignature) {
      setPlayer(null);
      setQuery("");
      setPrice("");
    }
    lastResetSignature.current = resetSignature;
  }, [storageKey, rulesSignature, defaultUserTeamIndex]);
  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    localStorage.setItem(storageKey, JSON.stringify(serializeAuction(state)));
  }, [state, storageKey]);
  useEffect(() => {
    worker.current = new Worker(
      new URL("./simulation.worker.js", import.meta.url),
      { type: "module" },
    );
    worker.current.onmessage = (e) =>
      e.data.kind === "overview"
        ? setOverviewAdvice(e.data)
        : setAdvice(e.data);
    return () => worker.current.terminate();
  }, []);
  useEffect(() => {
    if (!player) return setAdvice(null);
    worker.current.postMessage({
      player,
      owner: userTeamIndex,
      mine: state.teams[userTeamIndex],
      teams: state.teams,
      remaining: data.players.filter((p) => !state.assigned[playerIdKey(p.id)]),
      assigned: state.assigned,
      history: workerHistory,
      rules: activeRules,
    });
  }, [player, state, data, rulesSignature, userTeamIndex]);
  useEffect(() => {
    worker.current.postMessage({
      mode: "overview",
      owner: userTeamIndex,
      mine: state.teams[userTeamIndex],
      teams: state.teams,
      remaining: data.players.filter((p) => !state.assigned[playerIdKey(p.id)]),
      assigned: state.assigned,
      history: workerHistory,
      rules: activeRules,
    });
  }, [state, data, rulesSignature, userTeamIndex]);
  const activeRole = activeNominationRole(state.teams, activeRules);
  const choices = data.players
    .filter(
      (p) =>
        !state.assigned[playerIdKey(p.id)] &&
        (!activeRole || p.ruolo === activeRole) &&
        query.length >= 2 &&
        p.nome.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, 7);
  const selectPlayer = (candidate) => {
    if (activeRole && candidate.ruolo !== activeRole) {
      setMessage(
        `In questa fase puoi chiamare solo ${ROLE_LABELS[activeRole].toLowerCase()}.`,
      );
      return setMessageType("error");
    }
    setPlayer(candidate);
    setQuery(candidate.nome);
    setPrice("");
    setSuggestionsOpen(false);
    setMessage(`Hai selezionato ${candidate.nome}. Scegli squadra e prezzo.`);
    setMessageType("info");
  };
  const assign = () => {
    const value = Number(price),
      team = state.teams[owner];
    if (!player) return;
    if (state.assigned[playerIdKey(player.id)]) {
      setMessage(`${player.nome} risulta gia assegnato.`);
      return setMessageType("error");
    }
    if (activeRole && player.ruolo !== activeRole) {
      setMessage(
        `In questa fase puoi assegnare solo ${ROLE_LABELS[activeRole].toLowerCase()}.`,
      );
      return setMessageType("error");
    }
    if (!Number.isInteger(value) || value < activeRules.auction.minPrice) {
      setMessage(
        `Inserisci un prezzo intero di almeno ${activeRules.auction.minPrice} crediti.`,
      );
      return setMessageType("error");
    }
    if (
      (value - activeRules.auction.minPrice) %
      activeRules.auction.increment
    ) {
      setMessage(
        `Il prezzo deve salire di ${activeRules.auction.increment} crediti a partire da ${activeRules.auction.minPrice}.`,
      );
      return setMessageType("error");
    }
    const legalMax = legalMaxBid(team, activeRules);
    if (value > legalMax) {
      setMessage(
        `${team.name} puo spendere al massimo ${legalMax} crediti: deve conservarne ${Math.max(0, Object.values(slotsLeft(team, activeRules)).reduce((sum, count) => sum + count, 0) - 1) * activeRules.auction.reserve} per completare la rosa.`,
      );
      return setMessageType("error");
    }
    if (slotsLeft(team, activeRules)[player.ruolo] < 1) {
      setMessage(
        `${team.name} non ha piu posti per ${(ROLE_LABELS[player.ruolo] || player.ruolo).toLowerCase()}.`,
      );
      return setMessageType("error");
    }
    setState((s) => ({
      ...s,
      teams: s.teams.map((t, i) =>
        i === owner
          ? { ...t, credits: t.credits - value, roster: [...t.roster, player] }
          : t,
      ),
      assigned: {
        ...s.assigned,
        [playerIdKey(player.id)]: { owner, price: value },
      },
      history: [...s.history, { playerId: player.id, owner, price: value }],
      undone: [],
    }));
    setMessage(`${player.nome} assegnato a ${team.name} per ${value} crediti.`);
    setMessageType("success");
    setPlayer(null);
    setQuery("");
    setPrice("");
  };
  const undo = () => {
    const last = state.history.at(-1);
    if (!last) return;
    setState((s) => {
      const assigned = { ...s.assigned };
      delete assigned[playerIdKey(last.playerId)];
      return {
        ...s,
        assigned,
        history: s.history.slice(0, -1),
        undone: [...(s.undone || []), last],
        teams: s.teams.map((t, i) =>
          i === last.owner
            ? {
                ...t,
                credits: t.credits + last.price,
                roster: t.roster.filter(
                  (p) => playerIdKey(p.id) !== playerIdKey(last.playerId),
                ),
              }
            : t,
        ),
      };
    });
    setMessage(
      `Annullata l'assegnazione di ${data.players.find((p) => playerIdKey(p.id) === playerIdKey(last.playerId))?.nome || "giocatore"}.`,
    );
    setMessageType("info");
  };
  const redo = () => {
    const last = state.undone?.at(-1);
    if (!last) return;
    const team = state.teams[last.owner];
    const restoredPlayer = data.players.find(
      (p) => playerIdKey(p.id) === playerIdKey(last.playerId),
    );
    if (
      !restoredPlayer ||
      state.assigned[playerIdKey(last.playerId)] ||
      slotsLeft(team, activeRules)[restoredPlayer.ruolo] < 1 ||
      !isValidBid(last.price, team, activeRules)
    ) {
      setMessage(
        "Non posso ripristinare l'operazione: budget o slot sono cambiati.",
      );
      return setMessageType("error");
    }
    setState((s) => ({
      ...s,
      teams: s.teams.map((t, i) =>
        i === last.owner
          ? {
              ...t,
              credits: t.credits - last.price,
              roster: [...t.roster, restoredPlayer],
            }
          : t,
      ),
      assigned: {
        ...s.assigned,
        [playerIdKey(last.playerId)]: { owner: last.owner, price: last.price },
      },
      history: [...s.history, last],
      undone: s.undone.slice(0, -1),
    }));
    setMessage(`Ripristinata l'assegnazione di ${restoredPlayer.nome}.`);
    setMessageType("success");
  };
  const flushAuction = () => {
    if (
      !window.confirm(
        "Vuoi cancellare tutta l'asta salvata? L'operazione non puo essere annullata.",
      )
    )
      return;
    setState(emptyAuction(activeRules));
    setPlayer(null);
    setQuery("");
    setPrice("");
    setSuggestionsOpen(false);
    setMessage("Asta azzerata. Puoi impostare di nuovo i crediti iniziali.");
    setMessageType("success");
  };
  const canSetStartingCredits =
    state.history.length === 0 && !state.undone?.length;
  const selectedLegalMax = legalMaxBid(state.teams[owner], activeRules);
  const updateStartingCredits = (teamIndex, value) => {
    const credits = Number(value);
    if (!Number.isInteger(credits) || credits < 25) return;
    setState((s) => ({
      ...s,
      teams: s.teams.map((team, index) =>
        index === teamIndex
          ? { ...team, startingCredits: credits, credits }
          : team,
      ),
    }));
  };
  return (
    <section className="data-view auction">
      <div className="view-heading">
        <span className="eyebrow">MODALITA OPERATIVA</span>
        <h1>Asta live</h1>
        <p>
          Un passaggio alla volta: scegli il giocatore, indica chi lo compra e
          conferma il prezzo.
        </p>
      </div>
      <div className="auction-owner">
        <label htmlFor="auction-user-team">La mia squadra</label>
        <select
          id="auction-user-team"
          value={userTeamIndex}
          onChange={(e) => {
            const nextIndex = Number(e.target.value);
            setUserTeamIndex(nextIndex);
            setOwner(nextIndex);
          }}
        >
          {state.teams.map((team, index) => (
            <option value={index} key={index}>
              {team.name}
            </option>
          ))}
        </select>
        <small>Usata per consigli, budget e riepilogo.</small>
      </div>
      <section className="auction-summary" aria-label="Stato della mia squadra">
        <div>
          <span>Crediti rimasti</span>
          <strong>{state.teams[userTeamIndex].credits}</strong>
          <small>per la tua squadra</small>
        </div>
        <div>
          <span>Giocatori presi</span>
          <strong>
            {state.teams[userTeamIndex].roster.length} /{" "}
            {Object.values(activeRules.rosterSlots).reduce(
              (sum, count) => sum + count,
              0,
            )}
          </strong>
          <small>
            {Object.entries(slotsLeft(state.teams[userTeamIndex], activeRules))
              .map(([role, count]) => `${role}${count}`)
              .join(" ")}{" "}
            posti
          </small>
        </div>
        <div>
          <span>Ultima azione</span>
          <strong>
            {state.history.length
              ? data.players.find(
                  (p) =>
                    playerIdKey(p.id) ===
                    playerIdKey(state.history.at(-1).playerId),
                )?.nome || "Giocatore"
              : "Nessuna"}
          </strong>
          <small>
            {state.history.length
              ? `${state.history.at(-1).price} crediti`
              : "Pronto per iniziare"}
          </small>
        </div>
      </section>
      <AuctionOverview overview={overviewAdvice} />
      <p
        className={`auction-status ${messageType}`}
        role="status"
        aria-live="polite"
      >
        {message}
      </p>
      {activeRole && (
        <p className="auction-status info" role="status">
          Fase attiva: {ROLE_LABELS[activeRole]}. Completa i posti di questo
          ruolo in tutte le rose per passare al successivo.
        </p>
      )}
      <div className="auction-bar">
        <div
          className="auction-search"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget))
              setSuggestionsOpen(false);
          }}
        >
          <label htmlFor="auction-player">Giocatore in asta</label>
          <input
            id="auction-player"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (player && activeRole && player.ruolo !== activeRole)
                setPlayer(null);
              setSuggestionsOpen(true);
            }}
            onFocus={() => setSuggestionsOpen(true)}
            onKeyDown={(e) => e.key === "Escape" && setSuggestionsOpen(false)}
            placeholder="Scrivi almeno 2 lettere"
            autoComplete="off"
            aria-describedby="auction-results"
          />
          {suggestionsOpen && query.length >= 2 && (
            <div className="auction-results" id="auction-results">
              <span>
                {choices.length
                  ? `${choices.length} giocatori trovati`
                  : "Nessun giocatore disponibile"}
              </span>
              {choices.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectPlayer(p)}
                  aria-label={`Seleziona ${p.nome}, ${p.ruolo}, ${p.squadra}`}
                >
                  <i className={"role " + p.ruolo}>{p.ruolo}</i>
                  <b>{p.nome}</b>
                  <small>
                    {p.squadra} · {p.fvm_scaled}
                  </small>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="auction-history">
          <button onClick={undo} disabled={!state.history.length}>
            Annulla ultima
          </button>
          <button onClick={redo} disabled={!state.undone?.length}>
            Ripristina
          </button>
          <button className="flush" onClick={flushAuction}>
            Flush asta
          </button>
        </div>
      </div>
      {player && (
        <section className="auction-advice">
          <div>
            <span className={"role " + player.ruolo}>{player.ruolo}</span>
            <h2>{player.nome}</h2>
            <p>
              {player.squadra} · {formatTier(player.guida_asta_fascia)}
            </p>
          </div>
          <div>
            <span>Prezzo max consigliato</span>
            <strong>{advice?.maxBid ?? "..."}</strong>
            <small>{advice?.utility || "Calcolo in corso"}</small>
          </div>
          <label className="auction-field auction-field--reserved-help">
            Squadra acquirente
            <select value={owner} onChange={(e) => setOwner(+e.target.value)}>
              {state.teams.map((t, i) => (
                <option value={i} key={i}>
                  {t.name} · {t.credits} cr.
                </option>
              ))}
            </select>
          </label>
          <label className="auction-field">
            Prezzo di acquisto (crediti)
            <input
              value={price}
              type="number"
              min={activeRules.auction.minPrice}
              max={selectedLegalMax}
              step={activeRules.auction.increment}
              onChange={(e) => setPrice(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && assign()}
              placeholder="Prezzo"
              inputMode="numeric"
            />
            <small className="field-help">
              Massimo consentito: {selectedLegalMax}
            </small>
          </label>
          <div className="auction-actions">
            <button onClick={assign}>Conferma assegnazione</button>
            <button className="secondary" onClick={() => openPlayer(player)}>
              Vedi scheda
            </button>
            <button
              className="secondary"
              onClick={() => {
                setPlayer(null);
                setQuery("");
                setPrice("");
                setSuggestionsOpen(false);
                setMessage("Selezione annullata.");
                setMessageType("info");
              }}
            >
              Annulla
            </button>
          </div>
        </section>
      )}
      {player && advice && <AuctionStrategy advice={advice} />}
      <div className="auction-teams">
        {state.teams.map((team, i) => {
          const left = slotsLeft(team, activeRules),
            max = legalMaxBid(team, activeRules);
          return (
            <article key={i}>
              <label>
                Nome squadra
                <input
                  aria-label={`Nome squadra ${i + 1}`}
                  value={team.name}
                  onChange={(e) =>
                    setState((s) => ({
                      ...s,
                      teams: s.teams.map((t, j) =>
                        j === i ? { ...t, name: e.target.value } : t,
                      ),
                    }))
                  }
                />
              </label>
              {canSetStartingCredits ? (
                <label className="starting-credits">
                  Crediti iniziali
                  <input
                    type="number"
                    min="25"
                    step="1"
                    value={team.credits}
                    onChange={(e) => updateStartingCredits(i, e.target.value)}
                  />
                </label>
              ) : (
                <strong>
                  {team.credits}
                  <small> crediti rimasti</small>
                </strong>
              )}
              <p>
                Max bid {max} · P{left.P} D{left.D} C{left.C} A{left.A}
              </p>
              {team.roster.length ? (
                team.roster.map((p) => (
                  <button key={p.id} onClick={() => openPlayer(p)}>
                    <i className={"role " + p.ruolo}>{p.ruolo}</i>
                    {p.nome}
                    <em>{state.assigned[playerIdKey(p.id)]?.price}</em>
                  </button>
                ))
              ) : (
                <span className="empty-roster">Nessun giocatore</span>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

class AppErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="app-crash">
        <h1>Qualcosa è andato storto</h1>
        <p>{this.state.error.message || "Errore inatteso."}</p>
        <button onClick={() => window.location.reload()}>Ricarica l'app</button>
      </section>
    );
  }
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
