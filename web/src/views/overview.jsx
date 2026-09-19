import { useEffect, useState } from "react";
import {
  Empty,
  Meter,
  PlayerRow,
  RoleChip,
  ROLE_LABELS,
  Sheet,
  formatTier,
} from "../ui.jsx";
import {
  FORCE_AVAILABLE,
  FORCE_OUT,
} from "../player-injuries.js";

const TOP_TIERS = ["SUPER TOP", "TOP", "SEMITOP"];

/**
 * Landing screen. It answers "what is in this dataset and where do I start",
 * then hands over to the three working screens. Nothing here is a decision aid;
 * the auction screen owns that job.
 */
export default function OverviewView({ data, profileId, openPlayer, openTeam, openRole, injuryState }) {
  const [injuryManagerOpen, setInjuryManagerOpen] = useState(false);
  const [injuryQuery, setInjuryQuery] = useState("");

  useEffect(() => {
    setInjuryManagerOpen(false);
    setInjuryQuery("");
  }, [profileId]);

  const roleCounts = Object.keys(ROLE_LABELS).map((role) => ({
    role,
    count: data.players.filter((player) => player.ruolo === role).length,
  }));
  const top = data.players
    .filter((player) => TOP_TIERS.includes(formatTier(player.guida_asta_fascia)))
    .sort((a, b) => b.fvm_scaled - a.fvm_scaled)
    .slice(0, 8);
  const unavailable = data.players.filter((player) => player.availability_overlay?.effective === "OUT");
  const questionable = data.players.filter((player) => player.availability_overlay?.effective === "QUESTIONABLE");
  const monitored = data.players.filter((player) => player.availability_overlay?.effective);
  const managed = data.players.filter((player) =>
    player.availability_overlay?.automatic || player.availability_overlay?.override,
  );
  const matchdays = data.calendario_serie_a?.length
    ? Math.round(data.calendario_serie_a.length / 10)
    : null;
  const ageMinutes = injuryState.status.cacheAgeSeconds == null
    ? null
    : Math.round(injuryState.status.cacheAgeSeconds / 60);

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
              <h2>Indisponibili</h2>
              <p className="micro">
                {unavailable.length} fuori · {questionable.length} in dubbio
                {ageMinutes == null ? "" : ` · aggiornato ${ageMinutes} min fa`}
              </p>
            </div>
            <div className="overview-card-actions">
              <span className="count">{unavailable.length}</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setInjuryManagerOpen(true)}
              >
                Gestisci
              </button>
            </div>
          </div>
          {monitored.length ? (
            <div className="rows">
              {monitored.slice(0, 8).map((player) => (
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
            <Empty title="Nessuna indisponibilità segnalata">
              Gli aggiornamenti automatici e gli override manuali non modificano
              valori o consigli d&apos;asta.
            </Empty>
          )}
        </section>
      </div>

      <InjuryManager
        open={injuryManagerOpen}
        onClose={() => setInjuryManagerOpen(false)}
        players={data.players}
        monitored={managed}
        overrides={injuryState.overrides}
        query={injuryQuery}
        setQuery={setInjuryQuery}
        setOverride={injuryState.setOverride}
        warning={injuryState.storageWarning || injuryState.status.warning}
      />

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

function InjuryManager({
  open,
  onClose,
  players,
  monitored,
  overrides,
  query,
  setQuery,
  setOverride,
  warning,
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase("it");
  const matches = normalizedQuery
    ? players
      .filter((player) =>
        `${player.nome} ${player.squadra}`.toLocaleLowerCase("it").includes(normalizedQuery),
      )
      .sort((a, b) => a.nome.localeCompare(b.nome, "it"))
      .slice(0, 30)
    : [];

  return (
    <Sheet open={open} onClose={onClose} title="Gestisci disponibilità" wide>
      <div className="injury-manager stack">
        <div className="injury-manager-note">
          <strong>Overlay informativo</strong>
          <p>
            I dati automatici arrivano da Fantacalcio Online. Gli override manuali
            restano in questo browser e non modificano valori o consigli d&apos;asta.
          </p>
        </div>

        <label className="injury-search">
          <span>Cerca giocatore</span>
          <input
            className="input"
            type="search"
            value={query}
            placeholder="Nome o squadra"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        {warning ? <p className="injury-manager-warning" role="alert">{warning}</p> : null}

        {normalizedQuery ? (
          <InjuryPlayerList
            title="Risultati"
            players={matches}
            overrides={overrides}
            setOverride={setOverride}
            empty="Nessun giocatore trovato."
          />
        ) : null}

        <InjuryPlayerList
          title={`Segnalati (${monitored.length})`}
          players={monitored}
          overrides={overrides}
          setOverride={setOverride}
          empty="Nessun giocatore segnalato. Cerca un giocatore per iniziare."
        />
      </div>
    </Sheet>
  );
}

function InjuryPlayerList({ title, players, overrides, setOverride, empty }) {
  return (
    <section className="injury-list">
      <div className="injury-list-title">
        <h3>{title}</h3>
      </div>
      {players.length ? (
        <div className="injury-list-rows">
          {players.map((player) => {
            const overlay = player.availability_overlay;
            const automatic = overlay?.automatic?.availability;
            const override = overrides?.[String(player.id)] || "";
            return (
              <div className="injury-manager-row" key={player.id}>
                <RoleChip role={player.ruolo} />
                <span>
                  <strong>{player.nome}</strong>
                  <small>
                    {player.squadra}
                    {automatic ? ` · automatico ${automatic === "OUT" ? "OUT" : "DUBBIO"}` : ""}
                  </small>
                </span>
                <select
                  className="select"
                  value={override}
                  aria-label={`Override disponibilità di ${player.nome}`}
                  onChange={(event) => setOverride(player.id, event.target.value || null)}
                >
                  <option value="">Segui fonte</option>
                  <option value={FORCE_OUT}>Forza indisponibile</option>
                  <option value={FORCE_AVAILABLE}>Forza disponibile</option>
                </select>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="injury-list-empty">{empty}</p>
      )}
    </section>
  );
}
