import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { LeagueSettings } from "./league-settings.jsx";
import {
  apiUrl,
  auctionDatasetPath,
  loadDatasetUrl,
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

/**
 * Navigation model.
 *
 * Seven equal destinations do not fit on a phone, so the seven screens are
 * grouped into five thumb targets. Every original view keeps its route id, and
 * the two grouped tabs expose their siblings with the same segmented control
 * used everywhere else in the app.
 */
const TABS = [
  { id: "sintesi", label: "Sintesi", icon: "home", views: [["overview", "Sintesi"]] },
  { id: "listone", label: "Listone", icon: "list", views: [["players", "Listone"]] },
  { id: "asta", label: "Asta", icon: "gavel", hero: true, views: [["auction", "Asta"]] },
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
    id: "lega",
    label: "Lega",
    icon: "sliders",
    views: [
      ["simulation", "Simulazione"],
      ["settings", "Impostazioni"],
    ],
  },
];

const tabOf = (view) =>
  TABS.find((tab) => tab.views.some(([id]) => id === view)) || TABS[0];

function App() {
  const [data, setData] = useState(null);
  const [season, setSeason] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState("");
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationStatus, setSimulationStatus] = useState("");
  const [view, setView] = useState("overview");
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [listRole, setListRole] = useState(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [viewHistory, setViewHistory] = useState([
    { view: "overview", player: null, team: null },
  ]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const apiBase =
    import.meta.env.VITE_LOCAL_API_BASE || "http://127.0.0.1:8000";

  useEffect(() => {
    fetch(apiUrl("/api/default-profile", apiBase))
      .then((response) => (response.ok ? response.json() : null))
      .then(setProfile)
      .catch(() => setProfile(null));
  }, [apiBase]);

  useEffect(() => {
    if (!profile) return;
    const datasetPath = auctionDatasetPath(profile);
    loadDatasetUrl(apiUrl(`/api/datasets/${datasetPath}`, apiBase), { profile })
      .then((nextData) => {
        setData(nextData);
        setSelectedTeam((team) => team || nextData.teams[0]?.squadra || null);
      })
      .catch(() => setData(null));
    fetch(apiUrl(`/api/datasets/${seasonSimulationPath(profile)}`, apiBase))
      .then((response) => (response.ok ? response.json() : null))
      .then(setSeason)
      .catch(() => setSeason(null));
  }, [apiBase, profile]);

  const applyRoute = (route) => {
    setView(route.view);
    setSelectedPlayer(route.player);
    setSelectedTeam(route.team);
  };

  useEffect(() => {
    const initialRoute = { view: "overview", player: null, team: null };
    window.history.replaceState({ fantaRoute: initialRoute, fantaIndex: 0 }, "");
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

  const activeRules = rulesFor(profile, data || {});
  const activeProfileId =
    profile?.profile_id || data?.meta?.profile?.profile_id || "default";

  const updateProfile = async (nextProfile, generate = false) => {
    setProfileError("");
    try {
      const savedProfile = await saveProfile(nextProfile, { apiBase });
      if (!generate) {
        setProfile(savedProfile);
        return;
      }
      const response = await fetch(`${apiBase}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: savedProfile }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.dataset_path)
        throw new Error(payload.error?.message || "Generazione non completata.");
      setData(
        await loadDatasetUrl(
          apiUrl(`/api/datasets/${payload.dataset_path}`, apiBase),
          { profile: savedProfile },
        ),
      );
      setProfile(savedProfile);
      setSeason(null);
      navigate("overview");
    } catch (error) {
      setProfileError(
        error instanceof Error
          ? error.message
          : "Impossibile generare il dataset del profilo.",
      );
      throw error;
    }
  };

  const regenerateData = async () => {
    if (!profile || isGenerating) return;
    setIsGenerating(true);
    setGenerationStatus("Rigenerazione in corso…");
    try {
      await updateProfile(profile, true);
      setGenerationStatus("Dati rigenerati.");
    } catch {
      setGenerationStatus("Rigenerazione non riuscita.");
    } finally {
      setIsGenerating(false);
    }
  };

  const rerunSimulation = async () => {
    if (isSimulating) return;
    setIsSimulating(true);
    setSimulationStatus("Simulazione in corso…");
    try {
      const response = await fetch(`${apiBase}/api/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, iterations: 1000, seed: 202627 }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message || "Simulazione non completata.");
      setSeason(result);
      setSimulationStatus("Simulazione aggiornata.");
    } catch {
      setSimulationStatus("Simulazione non riuscita.");
    } finally {
      setIsSimulating(false);
    }
  };

  if (!profile)
    return (
      <main className="boot">
        <div className="boot-spinner" />
        <p className="muted">Carico il profilo locale…</p>
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
              Carica il calendario della tua lega in Impostazioni e genera i dati
              per iniziare.
            </p>
          </div>
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

  const datasetProfileHash = data.meta?.profile?.profile_hash;
  const datasetStale =
    Boolean(datasetProfileHash && datasetProfileHash !== profile.configuration_hash) ||
    Boolean(
      data.meta?.profile?.source_fingerprints?.some(
        (source) => source.exists === false,
      ),
    );
  const datasetState = datasetProfileHash &&
    datasetProfileHash !== profile.configuration_hash
    ? "dataset da rigenerare"
    : data.meta?.profile?.source_fingerprints?.some(
          (source) => source.exists === false,
        )
      ? "fonti cambiate"
      : "dataset corrente";
  const simulationState =
    season?.meta?.dataset_input_hash &&
    season.meta.dataset_input_hash === data.meta?.profile?.dataset_input_hash
      ? "simulazione corrente"
      : "simulazione da aggiornare";

  const tab = tabOf(view);

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
              openPlayer={openPlayer}
              openTeam={(team) => navigate("teams", { team })}
              openRole={openRole}
            />
          ) : null}

          {view === "players" ? (
            <PlayersView
              data={data}
              rules={activeRules}
              selected={selectedPlayer}
              setSelected={setSelectedPlayer}
              initialRole={listRole}
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
            />
          ) : null}

          {view === "auction" ? (
            <AuctionView
              data={data}
              openPlayer={openPlayer}
              rules={activeRules}
              profileId={activeProfileId}
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
            className={`tab${item.hero ? " tab--hero" : ""}${item.id === tab.id ? " is-active" : ""}`}
            onClick={() => navigate(item.views[0][0])}
            aria-current={item.id === tab.id ? "page" : undefined}
          >
            <span className="tab-icon">
              <Icon name={item.icon} />
            </span>
            {item.label}
          </button>
        ))}
      </nav>

      <Sheet
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
        title="Stato dei dati"
      >
        <div className="stack">
          <div className={`notice notice--${datasetStale ? "warn" : "go"}`}>
            {datasetState}
          </div>
          <div className="notice">{simulationState}</div>
          <p className="micro">
            Generato il {data.meta?.generato_il?.slice(0, 10) || "—"} · profilo{" "}
            {activeProfileId}
          </p>
          {generationStatus ? (
            <p className="micro" role="status">
              {generationStatus}
            </p>
          ) : null}
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={regenerateData}
            disabled={isGenerating}
          >
            {isGenerating ? "Rigenerazione…" : "Rigenera dati"}
          </button>
        </div>
      </Sheet>
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
