import {
  Empty,
  Meter,
  PlayerRow,
  RoleChip,
  ROLE_LABELS,
  formatTier,
} from "../ui.jsx";

const TOP_TIERS = ["SUPER TOP", "TOP", "SEMITOP"];

/**
 * Landing screen. It answers "what is in this dataset and where do I start",
 * then hands over to the three working screens. Nothing here is a decision aid;
 * the auction screen owns that job.
 */
export default function OverviewView({ data, openPlayer, openTeam, openRole }) {
  const roleCounts = Object.keys(ROLE_LABELS).map((role) => ({
    role,
    count: data.players.filter((player) => player.ruolo === role).length,
  }));
  const top = data.players
    .filter((player) => TOP_TIERS.includes(formatTier(player.guida_asta_fascia)))
    .sort((a, b) => b.fvm_scaled - a.fvm_scaled)
    .slice(0, 8);
  const injured = data.players.filter(
    (player) => player.guida_asta_fascia === "INFORTUNATO",
  );
  const matchdays = data.calendario_serie_a?.length
    ? Math.round(data.calendario_serie_a.length / 10)
    : null;

  return (
    <div className="stack stack--lg">
      <section className="hero">
        <div className="stack">
          <span className="kicker">Database offline</span>
          <h1>Tutto il tuo fanta, in una vista sola.</h1>
          <p>
            Proiezioni, storico, guide, calendario e gerarchie sui piazzati.
            Durante l&apos;asta non serve rete.
          </p>
        </div>
        <div className="hero-figures">
          <div className="stat">
            <span className="stat-label">Giocatori</span>
            <span className="stat-value">{data.players.length}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Squadre</span>
            <span className="stat-value">{data.teams.length}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Giornate</span>
            <span className="stat-value">{matchdays ?? "n/d"}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Piazzati</span>
            <span className="stat-value">{data.set_pieces.length}</span>
          </div>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>Il listone per reparto</h2>
          <span className="count">tocca per filtrare</span>
        </div>
        <div className="role-strip">
          {roleCounts.map((item) => (
            <button
              type="button"
              className="role-tile"
              key={item.role}
              onClick={() => openRole(item.role)}
            >
              <RoleChip role={item.role} />
              <b>{item.count}</b>
              <small>{ROLE_LABELS[item.role]}</small>
            </button>
          ))}
        </div>
      </section>

      <div className="overview-split stack">
        <section className="card card--flush">
          <div className="section-head" style={{ padding: "var(--s-4)", marginBottom: 0 }}>
            <div>
              <span className="kicker">Prime scelte</span>
              <h2>Valore più alto</h2>
            </div>
          </div>
          <div className="rows">
            {top.map((player, index) => (
              <PlayerRow
                key={player.id}
                player={player}
                rank={String(index + 1).padStart(2, "0")}
                value={player.fvm_scaled}
                valueLabel="valore"
                className="player-row"
                onClick={() => openPlayer(player)}
              />
            ))}
          </div>
        </section>

        <section className="card card--flush">
          <div className="section-head" style={{ padding: "var(--s-4)", marginBottom: 0 }}>
            <div>
              <span className="kicker">Da monitorare</span>
              <h2>Infortunati</h2>
            </div>
            <span className="count">{injured.length}</span>
          </div>
          {injured.length ? (
            <div className="rows">
              {injured.slice(0, 8).map((player) => (
                <PlayerRow
                  key={player.id}
                  player={player}
                  value={player.fvm_scaled}
                  valueLabel="valore"
                  className="player-row"
                  onClick={() => openPlayer(player)}
                />
              ))}
            </div>
          ) : (
            <Empty title="Nessun infortunato classificato">
              Le fasce della guida non segnalano indisponibilità.
            </Empty>
          )}
        </section>
      </div>

      <section>
        <div className="section-head">
          <h2>Le venti di Serie A</h2>
          <span className="count">attacco / difesa</span>
        </div>
        <div className="club-grid">
          {data.teams.map((team) => (
            <button
              type="button"
              className="club-tile"
              key={team.squadra}
              onClick={() => openTeam(team.squadra)}
            >
              <strong>{team.squadra}</strong>
              <Meter
                label="ATT"
                value={team.rating_att}
                color="var(--c-role-a)"
              />
              <Meter
                label="DIF"
                value={team.rating_dif}
                color="var(--c-role-d)"
              />
              <small>
                {team.coppa_europea || (team.promossa ? "Neopromossa" : "—")}
              </small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
