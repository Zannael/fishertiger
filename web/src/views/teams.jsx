import { useState } from "react";
import {
  Empty,
  Meter,
  PlayerRow,
  Segmented,
} from "../ui.jsx";

const TABS = [
  { value: "rosa", label: "Rosa" },
  { value: "calendario", label: "Calendario" },
  { value: "piazzati", label: "Piazzati" },
];

/**
 * One club at a time. The club picker is a horizontal rail rather than a wrapped
 * block of twenty buttons, and rosa / calendario / piazzati are three tabs on
 * one club instead of two separate destinations in the main navigation.
 */
export default function TeamsView({
  data,
  selectedTeam,
  setSelectedTeam,
  openPlayer,
}) {
  const [tab, setTab] = useState("rosa");
  const team =
    data.teams.find((item) => item.squadra === selectedTeam) || data.teams[0];
  const players = team.player_ids
    .map((id) => data.players.find((player) => player.id === id))
    .filter(Boolean)
    .sort(
      (a, b) => a.ruolo.localeCompare(b.ruolo) || b.fvm_scaled - a.fvm_scaled,
    );
  const pieces = data.set_pieces.filter(
    (piece) => piece.squadra === team.squadra,
  );

  return (
    <div className="stack">
      <div className="page-head">
        <span className="kicker">Serie A</span>
        <h1>Rose, calendario e piazzati</h1>
      </div>

      <div className="chip-rail">
        {data.teams.map((item) => (
          <button
            type="button"
            key={item.squadra}
            className={`chip${item.squadra === team.squadra ? " is-active" : ""}`}
            onClick={() => setSelectedTeam(item.squadra)}
          >
            {item.squadra}
          </button>
        ))}
      </div>

      <section className="club-hero">
        <div>
          <span className="kicker">
            {team.coppa_europea || (team.promossa ? "Neopromossa" : "Serie A")}
          </span>
          <h2>{team.squadra}</h2>
        </div>
        <div className="club-figures">
          <div className="stat">
            <span className="stat-label">Punti prec.</span>
            <span className="stat-value">{team.punti_prec}</span>
          </div>
          <div className="stat">
            <span className="stat-label">GF / GS</span>
            <span className="stat-value">
              {team.gf_prec} / {team.gs_prec}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">xG / xGA</span>
            <span className="stat-value">
              {team.xg_prec ?? "—"} / {team.xga_prec ?? "—"}
            </span>
          </div>
        </div>
        <div className="stack" style={{ gap: "var(--s-2)" }}>
          <Meter label="ATT" value={team.rating_att} color="var(--c-role-a)" />
          <Meter label="DIF" value={team.rating_dif} color="var(--c-role-d)" />
        </div>
      </section>

      <Segmented
        options={TABS}
        value={tab}
        onChange={setTab}
        label="Sezione della squadra"
      />

      {tab === "rosa" ? (
        <section className="card card--flush">
          <div className="section-head" style={{ padding: "var(--s-4)", marginBottom: 0 }}>
            <h2>Rosa nel listone</h2>
            <span className="count">{players.length} giocatori</span>
          </div>
          <div className="roster-grid roster-grid--wide" style={{ padding: "0 var(--s-2) var(--s-2)" }}>
            {players.map((player) => (
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
        </section>
      ) : null}

      {tab === "calendario" ? (
        <section className="card">
          <div className="section-head">
            <h2>Le 38 giornate</h2>
            <span className="legend">
              <span>
                <i className="k-home" />
                Casa
              </span>
              <span>
                <i className="k-away" />
                Trasferta
              </span>
            </span>
          </div>
          <div className="fixtures">
            {team.fixtures.map((fixture) => (
              <div
                key={fixture.matchday}
                className={`fixture${fixture.venue === "CASA" ? " is-home" : ""}`}
              >
                <i>G{fixture.matchday}</i>
                <b>{fixture.opponent}</b>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {tab === "piazzati" ? (
        <section className="card">
          <div className="section-head">
            <h2>Gerarchie sui piazzati</h2>
          </div>
          {pieces.length ? (
            <div className="stack">
              {pieces.map((piece) => (
                <div key={piece.tipo}>
                  <span className="kicker">{piece.tipo}</span>
                  <div style={{ marginTop: 6 }}>
                    {piece.takers.length ? (
                      piece.takers.map((taker) => (
                        <button
                          type="button"
                          className="taker-line"
                          key={taker.player_id}
                          onClick={() =>
                            openPlayer(
                              data.players.find(
                                (player) => player.id === taker.player_id,
                              ),
                            )
                          }
                        >
                          <span
                            className={`taker-rank${taker.priorita === 1 ? " is-first" : ""}`}
                          >
                            {taker.priorita}
                          </span>
                          <span className="taker-name">{taker.nome}</span>
                        </button>
                      ))
                    ) : (
                      <p className="micro">Gerarchia aperta.</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="Nessuna gerarchia registrata" />
          )}
        </section>
      ) : null}
    </div>
  );
}

const TYPES = ["RIGORI", "PUNIZIONI", "CORNER"];

const TYPE_OPTIONS = [
  { value: "TUTTI", label: "Tutti" },
  ...TYPES.map((type) => ({ value: type, label: type[0] + type.slice(1).toLowerCase() })),
];

/** Set-piece board across the whole league, filterable by type. */
export function SetPiecesView({ data, openPlayer }) {
  const [type, setType] = useState("TUTTI");
  const visible = type === "TUTTI" ? TYPES : [type];

  return (
    <div className="stack">
      <div className="page-head">
        <span className="kicker">Specialisti</span>
        <h1>Rigori, punizioni e corner</h1>
        <p>
          Una gerarchia aperta non ha un primo designato: il modello evita di
          assegnargli un bonus che non è dimostrato.
        </p>
      </div>

      <Segmented
        options={TYPE_OPTIONS}
        value={type}
        onChange={setType}
        label="Tipo di piazzato"
      />

      <div className="setpiece-groups">
        {data.teams.map((team) => (
          <article className="card" key={team.squadra}>
            <div className="section-head">
              <h2 style={{ fontSize: "var(--fs-md)" }}>{team.squadra}</h2>
            </div>
            <div className="stack" style={{ gap: "var(--s-3)" }}>
              {visible.map((kind) => {
                const piece = data.set_pieces.find(
                  (item) => item.squadra === team.squadra && item.tipo === kind,
                );
                return (
                  <div key={kind}>
                    <span className="kicker">{kind}</span>
                    <div style={{ marginTop: 4 }}>
                      {piece?.takers.length ? (
                        piece.takers.map((taker) => (
                          <button
                            type="button"
                            className="taker-line"
                            key={taker.player_id}
                            onClick={() =>
                              openPlayer(
                                data.players.find(
                                  (player) => player.id === taker.player_id,
                                ),
                              )
                            }
                          >
                            <span
                              className={`taker-rank${taker.priorita === 1 ? " is-first" : ""}`}
                            >
                              {taker.priorita}
                            </span>
                            <span className="taker-name">{taker.nome}</span>
                          </button>
                        ))
                      ) : (
                        <p className="micro">Da definire</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

