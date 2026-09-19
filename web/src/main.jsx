import { Component, StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Download, Trash2, Upload } from "lucide-react";
import "./index.css";
import { LeagueSettings } from "./league-settings.jsx";
import { createRequestGate } from "./latest-request.js";
import { adoptLatestPlayerListUpdate } from "./player-list-adoption.js";
import { datasetFreshness, simulationFreshness } from "./dataset-freshness.js";
import { emptyDraft } from "./auction-state.js";
import { Updates } from "./updates.jsx";
import { clearProfileBrowserData } from "./profile-storage.js";
import { useAuctionBoard } from "./use-auction-store.js";
import { backupAuction } from "./auction-store.js";
import { auctionSimulationInput } from "./auction-simulation.js";
import { useInjuryState } from "./injury-state.js";
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
import { Icon, Segmented, Sheet } from "./ui.jsx";
import OverviewView from "./views/overview.jsx";
import PlayersView from "./views/players.jsx";
import TeamsView, { SetPiecesView } from "./views/teams.jsx";
import SimulationView from "./views/simulation.jsx";
import AuctionView from "./views/auction.jsx";

const TABS = [
  {
    id: "sintesi",
    label: "Sintesi",
    icon: "home",
    views: [["overview", "Sintesi"]],
  },
  {
    id: "listone",
    label: "Listone",
    icon: "list",
    views: [["players", "Listone"]],
  },
  {
    id: "asta",
    label: "Asta",
    icon: "gavel",
    hero: true,
    views: [["auction", "Asta"]],
  },
  {
    id: "squadre",
    label: "Squadre",
    icon: "shield",
    views: [
      ["teams", "Squadre"],
      ["setpieces", "Piazzati"],
    ],
  },
  {
    id: "simulation",
    label: "Simulazione",
    icon: "chart",
    views: [["simulation", "Simulazione"]],
  },
  { id: "updates", label: "Aggiornamenti", icon: "refresh", views: [["updates", "Aggiornamenti"]] },
  { id: "settings", label: "Impostazioni", icon: "sliders", views: [["settings", "Impostazioni"]] },
];

const MOBILE_PRIMARY_IDS = new Set([
  "sintesi",
  "listone",
  "asta",
  "squadre",
]);

const tabOf = (view) =>
  TABS.find((tab) => tab.views.some(([id]) => id === view)) || TABS[0];

const fetchDefaultProfile = (apiBase) =>
  fetch(apiUrl("/api/default-profile", apiBase))
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);

const PROFILE_STORAGE_KEY = "fanta-profile-id";

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
    /* The picker still works for this session when storage is unavailable. */
  }
};

function App() {
  const [dataset, setDataset] = useState(null);
  const [season, setSeason] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState("");
  const [profiles, setProfiles] = useState([]);
  const [auctionDraft, setAuctionDraft] = useState(emptyDraft());
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState("");
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationStatus, setSimulationStatus] = useState("");
  const [currentSourceFingerprints, setCurrentSourceFingerprints] = useState(null);
  const [view, setView] = useState("overview");
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [listRole, setListRole] = useState(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [viewHistory, setViewHistory] = useState([
    { view: "overview", player: null, team: null },
  ]);
  const [historyIndex, setHistoryIndex] = useState(0);
  // An empty override deliberately enables same-origin requests behind Docker.
  const apiBase =
    import.meta.env.VITE_LOCAL_API_BASE ?? "http://127.0.0.1:8000";
  const loadedProfileId = useRef(null);
  const profileRequests = useRef(null);
  const generationRequests = useRef(null);
  const simulationRequests = useRef(null);
  const generatedProfileCommit = useRef(null);

  if (!profileRequests.current) profileRequests.current = createRequestGate();
  if (!generationRequests.current)
    generationRequests.current = createRequestGate();
  if (!simulationRequests.current)
    simulationRequests.current = createRequestGate();

  const claimProfileRequest = () => profileRequests.current.claim();
  const isCurrentProfileRequest = (request) =>
    profileRequests.current.isCurrent(request);
  const latestProfileRequest = () => profileRequests.current.latest();
  const invalidateGeneration = () => {
    generationRequests.current.claim();
    setIsGenerating(false);
    setGenerationStatus("");
  };
  const invalidateSimulation = () => {
    simulationRequests.current.claim();
    setIsSimulating(false);
    setSimulationStatus("");
  };
  const invalidateOperations = () => {
    invalidateGeneration();
    invalidateSimulation();
  };

  const applyDataset = (nextData, nextProfile) => {
    const id =
      nextProfile?.profile_id ||
      nextData?.meta?.profile?.profile_id ||
      "default";
    const switched = loadedProfileId.current !== id;
    loadedProfileId.current = id;
    setDataset({ data: nextData, profile: nextProfile, profileId: id });
    const fallbackTeam = nextData?.teams?.[0]?.squadra || null;
    if (switched) {
      setSelectedPlayer(null);
      setSelectedTeam(fallbackTeam);
      setAuctionDraft(emptyDraft());
      setListRole(null);
    } else {
      setSelectedTeam((team) => team || fallbackTeam);
    }
  };

  const clearDataset = () => {
    loadedProfileId.current = null;
    setDataset(null);
    setSelectedPlayer(null);
    setSelectedTeam(null);
    setAuctionDraft(emptyDraft());
  };

  const applyProfileForLoading = (nextProfile) => {
    const nextId = nextProfile?.profile_id || "default";
    if (loadedProfileId.current && loadedProfileId.current !== nextId)
      clearDataset();
    setProfile(nextProfile);
  };

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
      if (storedId && names.includes(storedId))
        next = await loadProfile(storedId, { apiBase }).catch(() => null);
      if (!next) next = await fetchDefaultProfile(apiBase);
      if (!cancelled && isCurrentProfileRequest(request))
        applyProfileForLoading(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  useEffect(() => {
    if (!profile) return;
    if (generatedProfileCommit.current === profile) {
      generatedProfileCommit.current = null;
      return;
    }
    const pathError = datasetPathError(profile);
    if (pathError) {
      setProfileError(pathError);
      clearDataset();
      setSeason(null);
      return;
    }
    let cancelled = false;
    const datasetPath = auctionDatasetPath(profile);
    loadDatasetUrl(apiUrl(`/api/datasets/${datasetPath}`, apiBase), { profile })
      .then((nextData) => {
        if (!cancelled) applyDataset(nextData, profile);
      })
      .catch(() => {
        if (!cancelled) clearDataset();
      });
    fetch(apiUrl(`/api/datasets/${seasonSimulationPath(profile)}`, apiBase))
      .then((response) => (response.ok ? response.json() : null))
      .then((nextSeason) => {
        if (!cancelled) setSeason(nextSeason);
      })
      .catch(() => {
        if (!cancelled) setSeason(null);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, profile]);

  useEffect(() => {
    if (!profile) {
      setCurrentSourceFingerprints(null);
      return;
    }
    let active = true;
    const refresh = () => {
      fetch(apiUrl("/api/sources/status", apiBase), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (active && Array.isArray(payload?.sources))
            setCurrentSourceFingerprints(payload.sources);
        })
        .catch(() => {});
    };
    setCurrentSourceFingerprints(null);
    refresh();
    window.addEventListener("focus", refresh);
    const interval = statusOpen ? window.setInterval(refresh, 30000) : null;
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      if (interval) window.clearInterval(interval);
    };
  }, [apiBase, profile, statusOpen]);

  const applyRoute = (route) => {
    setView(route.view);
    setSelectedPlayer(route.player);
    setSelectedTeam(route.team);
  };

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

  const navigate = (
    nextView,
    { player = selectedPlayer, team = selectedTeam } = {},
  ) => {
    if (nextView !== "players") setListRole(null);
    const route = { view: nextView, player, team };
    setViewHistory((routes) => [...routes.slice(0, historyIndex + 1), route]);
    setHistoryIndex((index) => index + 1);
    window.history.pushState(
      { fantaRoute: route, fantaIndex: historyIndex + 1 },
      "",
    );
    applyRoute(route);
    window.scrollTo({ top: 0 });
  };

  const moveThroughHistory = (direction) => {
    if (!viewHistory[historyIndex + direction]) return;
    window.history.go(direction);
  };

  const openPlayer = (player) => navigate("players", { player });
  const openRole = (role) => {
    setListRole(role);
    navigate("players", { player: null });
  };
  const rawData = dataset?.data || null;
  const activeProfileId = dataset?.profileId || "default";
  const injuryState = useInjuryState({ profile, apiBase, players: rawData?.players || [] });
  const data = useMemo(
    () => rawData ? { ...rawData, players: injuryState.players } : null,
    [rawData, injuryState.players],
  );
  useEffect(() => {
    if (!selectedPlayer) return;
    setSelectedPlayer(data?.players.find((player) => String(player.id) === String(selectedPlayer.id)) || null);
  }, [data?.players]);
  const activeRules = rulesFor(dataset?.profile ?? profile, data || {});
  const auctionBoard = useAuctionBoard(activeProfileId, data?.players || [], activeRules, Boolean(data));
  const auctionInput = auctionSimulationInput(auctionBoard, data?.calendario_lega, activeRules);

  const updateProfile = async (nextProfile, generate = false) => {
    setProfileError("");
    const pathError = datasetPathError(nextProfile);
    if (pathError) {
      setProfileError(pathError);
      throw new Error(pathError);
    }
    let generationRequest = null;
    if (generate) {
      generationRequest = generationRequests.current.claim();
      setIsGenerating(true);
      setGenerationStatus("Rigenerazione in corso...");
      invalidateSimulation();
    } else {
      invalidateOperations();
    }
    const request = claimProfileRequest();
    let saveWarning = "";
    let savedProfile = null;
    try {
      const stored = await saveProfile(nextProfile, { apiBase });
      savedProfile = stored?.profile_id ? stored : nextProfile;
    } catch (error) {
      saveWarning = `Profilo non salvato su disco: ${
        error instanceof Error ? error.message : "errore sconosciuto"
      }.`;
    }
    const activeProfile = savedProfile || nextProfile;
    if (!isCurrentProfileRequest(request)) return false;
    if (savedProfile) {
      setProfiles((current) =>
        current.includes(savedProfile.profile_id)
          ? current
          : [...current, savedProfile.profile_id].sort(),
      );
      writeStoredProfileId(activeProfile.profile_id);
    }
    if (!generate) {
      applyProfileForLoading(activeProfile);
      if (saveWarning) {
        setProfileError(saveWarning);
        throw new Error(saveWarning);
      }
      return true;
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
      if (
        !isCurrentProfileRequest(request) ||
        !generationRequests.current.isCurrent(generationRequest)
      )
        return false;
      const generatedProfile = { ...activeProfile };
      generatedProfileCommit.current = generatedProfile;
      setProfile(generatedProfile);
      applyDataset(nextData, generatedProfile);
      setSeason(null);
      navigate("overview");
      if (saveWarning) setProfileError(saveWarning);
      setGenerationStatus("Dati rigenerati.");
      return true;
    } catch (error) {
      const current =
        isCurrentProfileRequest(request) &&
        generationRequests.current.isCurrent(generationRequest);
      if (current) {
        applyProfileForLoading(activeProfile);
        setProfileError(
          error instanceof Error
            ? error.message
            : "Impossibile generare il dataset del profilo.",
        );
        setGenerationStatus("Rigenerazione non riuscita.");
      }
      if (!current) return false;
      throw error;
    } finally {
      if (generationRequests.current.isCurrent(generationRequest))
        setIsGenerating(false);
    }
  };

  const selectProfile = async (id) => {
    invalidateOperations();
    setProfileError("");
    const request = claimProfileRequest();
    if (!id) {
      const fallback = await fetchDefaultProfile(apiBase);
      if (!isCurrentProfileRequest(request)) return;
      writeStoredProfileId("");
      applyProfileForLoading(fallback);
      return;
    }
    try {
      const next = await loadProfile(id, { apiBase });
      if (!isCurrentProfileRequest(request)) return;
      writeStoredProfileId(id);
      applyProfileForLoading(next);
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
        `Rimuovere il profilo "${id}"? I dati gia generati restano su disco, note, filtri e asta salvati in questo browser vengono cancellati.`,
      )
    )
      return;
    invalidateOperations();
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
    clearProfileBrowserData(id);
    setProfiles((current) => current.filter((name) => name !== id));
    if (readStoredProfileId() === id) writeStoredProfileId("");
    if (profile?.profile_id === id) {
      const request = claimProfileRequest();
      const fallback = await fetchDefaultProfile(apiBase);
      if (isCurrentProfileRequest(request)) applyProfileForLoading(fallback);
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
    invalidateOperations();
    const request = claimProfileRequest();
    try {
      const stored = await saveProfile(incoming, { apiBase });
      const id = stored?.profile_id || incoming.profile_id;
      if (!isCurrentProfileRequest(request)) return;
      setProfiles((current) =>
        current.includes(id) ? current : [...current, id].sort(),
      );
      writeStoredProfileId(id);
      applyProfileForLoading(stored || incoming);
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
      <label className="field" htmlFor="profile-select">
        <span className="field-label">Profilo</span>
        <select
          className="select"
          id="profile-select"
          value={
            profiles.includes(profile?.profile_id) ? profile.profile_id : ""
          }
          onChange={(event) => selectProfile(event.target.value)}
        >
          <option value="">Profilo predefinito</option>
          {profiles.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      <div className="profile-actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={exportProfile}
          disabled={!profile}
        >
          <Download size={16} aria-hidden="true" /> Esporta
        </button>
        <label className="btn btn--sm profile-import">
          <input
            type="file"
            accept=".json,application/json"
            aria-label="Importa profilo"
            onChange={(event) => {
              importProfile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <Upload size={16} aria-hidden="true" /> Importa
        </label>
        <button
          type="button"
          className="btn btn--danger btn--sm"
          onClick={() => removeProfile(profile?.profile_id)}
          disabled={!profiles.includes(profile?.profile_id)}
        >
          <Trash2 size={16} aria-hidden="true" /> Elimina
        </button>
      </div>
    </div>
  );

  const regenerateData = async () => {
    if (!profile || isGenerating) return;
    try {
      await updateProfile(profile, true);
    } catch {
      /* updateProfile already exposes the failure in the status sheet. */
    }
  };

  const beginPlayerListUpdate = () => {
    invalidateOperations();
    const backup = backupAuction(
      activeProfileId,
      data?.players || [],
      activeRules,
      "player_list_update",
    );
    if (!backup.ok) throw new Error(backup.message);
    return claimProfileRequest();
  };

  const adoptPlayerListUpdate = (result, request) =>
    adoptLatestPlayerListUpdate({
      request,
      isCurrent: isCurrentProfileRequest,
      loadProfile: () => loadProfile(result.profile_id, { apiBase }),
      loadDataset: (nextProfile) =>
        loadDatasetUrl(
          apiUrl(`/api/datasets/${result.dataset_path}`, apiBase),
          { profile: nextProfile },
        ),
      commit: (nextProfile, nextData) => {
        generatedProfileCommit.current = nextProfile;
        setProfile(nextProfile);
        applyDataset(nextData, nextProfile);
        setSeason(null);
      },
    });

  const rerunSimulation = async ({ rosterMode = "sample", rosters = null } = {}) => {
    if (isSimulating) return;
    const request = latestProfileRequest();
    const operation = simulationRequests.current.claim();
    setIsSimulating(true);
    setSimulationStatus("Simulazione in corso...");
    try {
      const response = await fetch(apiUrl("/api/simulate", apiBase), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, iterations: 1000, seed: 202627, roster_mode: rosterMode, ...(rosterMode === "auction" ? { rosters } : {}) }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message || "Simulazione non completata.");
      if (
        !isCurrentProfileRequest(request) ||
        !simulationRequests.current.isCurrent(operation)
      )
        return;
      setSeason(result);
      setSimulationStatus("Simulazione aggiornata.");
    } catch (error) {
      if (
        isCurrentProfileRequest(request) &&
        simulationRequests.current.isCurrent(operation)
      )
        setSimulationStatus(error.message || "Simulazione non riuscita.");
    } finally {
      if (simulationRequests.current.isCurrent(operation))
        setIsSimulating(false);
    }
  };
  if (!profile)
    return (
      <main className="boot">
        <div className="boot-spinner" />
        <p className="muted">Carico il profilo locale...</p>
      </main>
    );

  if (!data)
    return (
      <main className="app">
        <div className="page">
          <div className="page-head">
            <span className="kicker">Configurazione iniziale</span>
            <h1>Genera il tuo dataset</h1>
            <p>
              Puoi generare subito dati, proiezioni e strumenti d'asta con le
              fonti incluse. Carica il calendario della tua lega e rigenera i
              dati solo quando vuoi simulare la stagione.
            </p>
          </div>
          {profilePicker}
          <LeagueSettings
            initialProfile={profile}
            leagueCalendar={null}
            apiBase={apiBase}
            onSave={(nextProfile) => updateProfile(nextProfile)}
            onGenerate={(nextProfile) => updateProfile(nextProfile, true)}
          />
          {profileError ? (
            <p className="notice notice--stop" role="alert">
              {profileError}
            </p>
          ) : null}
        </div>
      </main>
    );

  const datasetState = datasetFreshness(profile, data, currentSourceFingerprints);
  const simulationState = simulationFreshness(profile, data, season, auctionInput);
  const datasetStale = datasetState !== "dataset corrente";
  const tab = tabOf(view);
  const moreActive = !MOBILE_PRIMARY_IDS.has(tab.id);

  return (
    <>
      <header className="topbar">
        <button className="brand" onClick={() => navigate("overview")}>
          <span className="brand-mark" aria-hidden="true">
            FT
          </span>
          <span className="brand-text">
            <strong>Fishertiger</strong>
            <span>{profile?.season?.season || "FANTACALCIO"}</span>
          </span>
        </button>
        <button
          className="icon-btn"
          onClick={() => moveThroughHistory(-1)}
          disabled={historyIndex === 0}
          aria-label="Vista precedente"
          title="Indietro"
        >
          <Icon name="back" />
        </button>
        <button
          className="icon-btn"
          onClick={() => moveThroughHistory(1)}
          disabled={historyIndex === viewHistory.length - 1}
          aria-label="Vista successiva"
          title="Avanti"
        >
          <Icon name="forward" />
        </button>
        <button
          className={`data-chip${isGenerating ? " is-busy" : datasetStale ? " is-stale" : ""}`}
          onClick={() => setStatusOpen(true)}
          aria-label={`Stato dei dati: ${datasetState}`}
        >
          <i className="dot" />
          <span className="data-chip-label">{datasetState}</span>
        </button>
      </header>

      <main className="app">
        <div className="page">
          {tab.views.length > 1 ? (
            <div style={{ marginBottom: "var(--s-4)" }}>
              <Segmented
                options={tab.views.map(([id, label]) => ({ value: id, label }))}
                value={view}
                onChange={(next) => navigate(next)}
                label={`Sezioni di ${tab.label}`}
              />
            </div>
          ) : null}
          {view === "overview" ? (
            <OverviewView
              data={data}
              profileId={activeProfileId}
              openPlayer={openPlayer}
              openTeam={(team) => navigate("teams", { team })}
              openRole={openRole}
              injuryState={injuryState}
            />
          ) : null}
          {view === "players" ? (
            <PlayersView
              data={data}
              rules={activeRules}
              profileId={activeProfileId}
              selected={selectedPlayer}
              setSelected={setSelectedPlayer}
              initialRole={listRole}
              profile={profile}
              apiBase={apiBase}
            />
          ) : null}
          {view === "teams" ? (
            <TeamsView
              data={data}
              selectedTeam={selectedTeam}
              setSelectedTeam={setSelectedTeam}
              openPlayer={openPlayer}
            />
          ) : null}
          {view === "setpieces" ? (
            <SetPiecesView data={data} openPlayer={openPlayer} />
          ) : null}
          {view === "simulation" ? (
            <SimulationView
              season={season}
              data={data}
              openPlayer={openPlayer}
              rules={activeRules}
              profileId={activeProfileId}
              onRerun={rerunSimulation}
              isSimulating={isSimulating}
              simulationStatus={simulationStatus}
              auctionInput={auctionInput}
            />
          ) : null}
          {view === "auction" ? (
            <AuctionView
              data={data}
              openPlayer={openPlayer}
              rules={activeRules}
              profileId={activeProfileId}
              draft={auctionDraft}
              setDraft={setAuctionDraft}
            />
          ) : null}
          {view === "updates" ? (
            <Updates
              profile={profile}
              apiBase={apiBase}
              onPlayerListApplyStart={beginPlayerListUpdate}
              onPlayerListApplied={adoptPlayerListUpdate}
              injuryState={injuryState}
            />
          ) : null}
          {view === "settings" ? (
            <>
              <LeagueSettings
                initialProfile={profile}
                leagueCalendar={data.calendario_lega || data.calendar}
                apiBase={apiBase}
                onSave={(nextProfile) => updateProfile(nextProfile)}
                onGenerate={(nextProfile) => updateProfile(nextProfile, true)}
              />
              {profileError ? (
                <p className="notice notice--stop" role="alert">
                  {profileError}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </main>

      <nav className="tabbar" aria-label="Sezioni principali">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={`tab${item.hero ? " tab--hero" : ""}${!MOBILE_PRIMARY_IDS.has(item.id) ? " tab--secondary" : ""}${item.id === tab.id ? " is-active" : ""}`}
            onClick={() => navigate(item.views[0][0])}
            aria-current={item.id === tab.id ? "page" : undefined}
          >
            <span className="tab-icon">
              <Icon name={item.icon} />
            </span>
            {item.label}
          </button>
        ))}
        <button
          type="button"
          className={`tab tab--more${moreActive ? " is-active" : ""}`}
          onClick={() => setMoreOpen(true)}
          aria-current={moreActive ? "page" : undefined}
          aria-expanded={moreOpen}
        >
          <span className="tab-icon"><Icon name="more" /></span>
          Altro
        </button>
      </nav>

      <Sheet
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
        title="Dati e profilo"
      >
        <div className="stack">
          {profilePicker}
          <div className={`notice notice--${datasetStale ? "warn" : "go"}`}>
            {datasetState}
          </div>
          <div className="notice">{simulationState}</div>
          <p className="micro">
            Generato il {data.meta?.generato_il?.slice(0, 10) || "n/d"} ·
            profilo {activeProfileId}
          </p>
          {generationStatus ? (
            <p className="micro" role="status">
              {generationStatus}
            </p>
          ) : null}
          {profileError ? (
            <p className="notice notice--stop" role="alert">
              {profileError}
            </p>
          ) : null}
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={regenerateData}
            disabled={isGenerating}
          >
            {isGenerating ? "Rigenerazione..." : "Rigenera dati"}
          </button>
        </div>
      </Sheet>

      <Sheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        title="Altro"
      >
        <div className="more-nav-list">
          {TABS.filter((item) => !MOBILE_PRIMARY_IDS.has(item.id)).map((item) => (
            <button
              type="button"
              className={`more-nav-item${item.id === tab.id ? " is-active" : ""}`}
              key={item.id}
              onClick={() => {
                setMoreOpen(false);
                navigate(item.views[0][0]);
              }}
              aria-current={item.id === tab.id ? "page" : undefined}
            >
              <Icon name={item.icon} />
              {item.label}
            </button>
          ))}
        </div>
      </Sheet>
    </>
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
        <button className="btn" onClick={() => window.location.reload()}>
          Ricarica l'app
        </button>
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
