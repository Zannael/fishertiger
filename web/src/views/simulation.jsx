import { useState } from "react";
import RandomAuctionView from "../random-auction.jsx";
import { Empty, PlayerRow, Segmented } from "../ui.jsx";

const MODES = [
  { value: "report", label: "Report rose" },
  { value: "auction", label: "Asta casuale" },
];

/** Monte Carlo section: the pre-auction report and the replayable mock auction. */
export default function SimulationView({
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
    <div className="stack">
      <Segmented
        options={MODES}
        value={mode}
        onChange={setMode}
        label="Modalità simulazione"
      />
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
    </div>
  );
}

function RunButton({ onRerun, isSimulating, status }) {
  return (
    <div className="btn-row" style={{ alignItems: "center" }}>
      <button
        type="button"
        className="btn btn--primary"
        onClick={onRerun}
        disabled={isSimulating}
      >
        {isSimulating ? "Simulazione in corso…" : "Riesegui Monte Carlo"}
      </button>
      {status ? (
        <span className="micro" role="status">
          {status}
        </span>
      ) : null}
    </div>
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
      <div className="page-head">
        <span className="kicker">Monte Carlo offline</span>
        <h1>Serve il calendario della lega</h1>
        <p>
          Dashboard, proiezioni e asta funzionano già. Carica il calendario in
          Impostazioni per simulare la stagione.
        </p>
      </div>
    );

  if (!season)
    return (
      <div className="stack">
        <div className="page-head">
          <span className="kicker">Monte Carlo offline</span>
          <h1>Simulazione non generata</h1>
          <p>
            Avvia una simulazione per costruire il report pre-asta sulle rose di
            esempio.
          </p>
        </div>
        <RunButton
          onRerun={onRerun}
          isSimulating={isSimulating}
          status={simulationStatus}
        />
      </div>
    );

  const rows = Object.entries(season.teams).sort(
    ([, a], [, b]) => b.expected_utility - a.expected_utility,
  );
  const activeTeam = selected || rows[0][0];
  const roster = (season.rosters[activeTeam] || [])
    .map((id) => data.players.find((player) => player.id === id))
    .filter(Boolean)
    .sort(
      (a, b) => a.ruolo.localeCompare(b.ruolo) || b.fvm_scaled - a.fvm_scaled,
    );
  const scenario = season.scenarios?.[activeTeam];

  return (
    <div className="stack stack--lg">
      <div className="page-head">
        <span className="kicker">Monte Carlo offline</span>
        <h1>Esiti delle rose esempio</h1>
        <p>
          {season.iterations.toLocaleString("it-IT")} stagioni simulate · seed{" "}
          {season.diagnostics.seed} ·{" "}
          {data.calendario_lega?.matchdays?.length || "n/d"} giornate di lega
        </p>
      </div>

      <RunButton
        onRerun={onRerun}
        isSimulating={isSimulating}
        status={simulationStatus}
      />

      <section className="card card--flush">
        <div className="rows">
          {rows.map(([team, result], index) => (
            <button
              type="button"
              key={team}
              className={`row sim-row${activeTeam === team ? " is-selected" : ""}`}
              onClick={() => setSelected(team)}
            >
              <span className={`sim-medal${index < 3 ? " is-podium" : ""}`}>
                {index + 1}
              </span>
              <span className="row-main">
                <span className="row-title">{team}</span>
                <span className="row-sub">
                  top 3 {(result.top3_probability * 100).toFixed(1)}% ·{" "}
                  {result.expected_points.toFixed(1)} punti attesi
                </span>
              </span>
              <span className="player-metric">
                <b
                  className={
                    result.expected_utility >= 0 ? "trend-up" : "trend-down"
                  }
                >
                  {result.expected_utility >= 0 ? "+" : ""}
                  {result.expected_utility.toFixed(0)}
                </b>
                <small>eur attesi</small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="kicker">Rosa selezionata</span>
            <h2>{activeTeam}</h2>
          </div>
          <span className="count">{roster.length} giocatori</span>
        </div>

        <div className="extremes">
          <div className="extreme extreme--best">
            <span className="stat-label">Migliore stagione estratta</span>
            <strong>{scenario?.best_score}</strong>
            <span className="micro">
              {scenario?.best_points} punti · {scenario?.best_rank}º posto
            </span>
          </div>
          <div className="extreme extreme--worst">
            <span className="stat-label">Peggiore stagione estratta</span>
            <strong>{scenario?.worst_score}</strong>
            <span className="micro">
              {scenario?.worst_points} punti · {scenario?.worst_rank}º posto
            </span>
          </div>
        </div>

        {roster.length ? (
          <div className="card card--flush">
            <div className="roster-grid" style={{ padding: "var(--s-2)" }}>
              {roster.map((player) => (
                <PlayerRow
                  key={player.id}
                  player={player}
                  className="player-row"
                  value={player.fvm_scaled}
                  valueLabel="valore"
                  onClick={() => openPlayer(player)}
                />
              ))}
            </div>
          </div>
        ) : (
          <Empty title="Rosa non disponibile" />
        )}
      </section>

      <p className="micro">
        Le rose sono generate con uno snake draft bilanciato sui valori FVM: gli
        estremi mostrano la variabilità della stessa rosa nelle{" "}
        {season.iterations.toLocaleString("it-IT")} simulazioni, non una
        previsione puntuale, e non sono ancora le rose della tua lega.
      </p>
    </div>
  );
}

