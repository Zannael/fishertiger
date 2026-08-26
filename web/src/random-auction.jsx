import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeRules } from "./league-rules.js";
import { simulateMockLeague } from "./mock-league-engine.js";
import { generateRandomAuction } from "./random-auction-engine.js";

const RECOMMENDATIONS = {
  STRONG_BUY: "Compra con decisione",
  BID: "Fai un'offerta",
  VALUE_ONLY: "Solo al prezzo giusto",
  PASS: "Lascia andare",
  INELIGIBLE: "Non acquistabile",
};

const NOMINATION_LABELS = {
  call: "Chiamata libera",
  call_by_role: "Chiamata per ruolo",
  random: "Randomica",
  random_by_role: "Randomica per ruolo",
  alphabetical: "Alfabetico",
  alphabetical_by_role: "Alfabetico per ruolo",
};

const randomSeed = () => {
  if (globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 2 ** 32);
};

const playerKey = (id) => `${typeof id}:${String(id)}`;

const freezeSnapshot = (players, events, count, startingCredits, teamNames) => {
  const playersById = new Map(
    players.map((player) => [playerKey(player.id), player]),
  );
  const credits = Array(teamNames.length).fill(startingCredits);
  const rosters = teamNames.map(() => []);
  const assignments = {};
  const history = events.slice(0, count).map((event) => {
    const player = playersById.get(playerKey(event.playerId));
    const record = Object.freeze({ ...event, player });
    credits[event.owner] -= event.price;
    rosters[event.owner].push(player);
    assignments[String(event.playerId)] = Object.freeze({
      owner: event.owner,
      price: event.price,
    });
    return record;
  });
  const assignedKeys = new Set(
    events.slice(0, count).map((event) => playerKey(event.playerId)),
  );
  const teams = teamNames.map((name, owner) =>
    Object.freeze({
      name,
      credits: credits[owner],
      roster: Object.freeze(rosters[owner].slice()),
    }),
  );

  return Object.freeze({
    credits: Object.freeze(credits.slice()),
    rosters: Object.freeze(
      rosters.map((roster) => Object.freeze(roster.slice())),
    ),
    assignments: Object.freeze(assignments),
    history: Object.freeze(history),
    teams: Object.freeze(teams),
    remaining: Object.freeze(
      players.filter((player) => !assignedKeys.has(playerKey(player.id))),
    ),
  });
};

const initialCreditsFrom = (rules) => {
  const supplied = Number(rules.startingCredits);
  return Number.isInteger(supplied) && supplied >= 25 ? supplied : 750;
};

export function RandomAuctionView({ data, rules, profileId }) {
  const players = Array.isArray(data?.players) ? data.players : [];
  const normalizedRules = useMemo(() => {
    const dataRules = data?.league_rules ?? data?.rules ?? {};
    const suppliedRules = rules ?? {};
    const calendar =
      suppliedRules.calendario_lega ??
      suppliedRules.calendar ??
      data?.calendario_lega ??
      data?.calendar ??
      dataRules.calendario_lega ??
      dataRules.calendar;
    return normalizeRules({
      ...dataRules,
      ...suppliedRules,
      calendario_lega: calendar,
    });
  }, [data, rules]);
  const { teamNames, userTeamIndex } = useMemo(() => {
    const count = normalizedRules.participants;
    const suppliedNames = normalizedRules.teamNames || [];
    const userTeam = normalizedRules.userTeam;
    const namedIndex = suppliedNames.indexOf(String(userTeam));
    const requestedIndex = Number(userTeam);
    const index =
      Number.isInteger(requestedIndex) &&
      requestedIndex >= 0 &&
      requestedIndex < count
        ? requestedIndex
        : namedIndex >= 0
          ? namedIndex
          : 0;
    return {
      userTeamIndex: index,
      teamNames: Array.from({ length: count }, (_, team) =>
        String(
          suppliedNames[team] ||
            (team === index && typeof userTeam === "string"
              ? userTeam
              : `Squadra ${team + 1}`),
        ),
      ),
    };
  }, [normalizedRules]);
  const roleOrder = Object.keys(normalizedRules.rosterSlots);
  const totalSales =
    normalizedRules.participants *
    Object.values(normalizedRules.rosterSlots).reduce(
      (sum, slots) => sum + Number(slots),
      0,
    );
  const activeProfileId = String(
    profileId ??
      data?.profileId ??
      data?.profile_id ??
      data?.meta?.profile?.profile_id ??
      "default",
  );
  const initialCredits = initialCreditsFrom(normalizedRules);
  const [startingCredits, setStartingCredits] = useState(initialCredits);
  const [auction, setAuction] = useState(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [advice, setAdvice] = useState(null);
  const [adviceState, setAdviceState] = useState("idle");
  const [standings, setStandings] = useState(null);
  const [leagueState, setLeagueState] = useState("idle");
  const workerRef = useRef(null);
  const latestAdviceId = useRef(0);
  const adviceCache = useRef(new Map());
  const leagueRunId = useRef(0);
  const leagueTimer = useRef(null);

  useEffect(() => {
    setStartingCredits(initialCredits);
  }, [initialCredits, activeProfileId]);

  useEffect(() => {
    adviceCache.current.clear();
    latestAdviceId.current += 1;
    setAdvice(null);
    setAdviceState("idle");
  }, [activeProfileId]);

  const startAuction = () => {
    const credits = Number(startingCredits);
    if (!Number.isInteger(credits) || credits < 25) {
      setError("I crediti iniziali devono essere un intero di almeno 25.");
      return;
    }

    try {
      const seed = randomSeed();
      const events = generateRandomAuction(players, {
        seed,
        startingCredits: credits,
        rules: normalizedRules,
      });
      setAuction({ seed, events, startingCredits: credits });
      setCursor(events.length ? 1 : 0);
      setPlaying(false);
      setError("");
      setAdvice(null);
      setAdviceState("idle");
      setStandings(null);
      setLeagueState("idle");
      adviceCache.current.clear();
      latestAdviceId.current += 1;
      leagueRunId.current += 1;
      if (leagueTimer.current) clearTimeout(leagueTimer.current);
    } catch (generationError) {
      setAuction(null);
      setPlaying(false);
      setError(
        generationError instanceof Error
          ? generationError.message
          : "Impossibile generare l'asta.",
      );
    }
  };

  useEffect(() => {
    if (!playing || !auction) return undefined;
    const timer = window.setInterval(() => {
      setCursor((current) => {
        if (current >= auction.events.length) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 850);
    return () => window.clearInterval(timer);
  }, [playing, auction]);

  useEffect(
    () => () => {
      leagueRunId.current += 1;
      if (leagueTimer.current) clearTimeout(leagueTimer.current);
    },
    [],
  );

  const snapshot = useMemo(
    () =>
      auction
        ? freezeSnapshot(
            players,
            auction.events,
            cursor,
            auction.startingCredits,
            teamNames,
          )
        : null,
    [auction, cursor, players, teamNames],
  );
  const preSaleSnapshot = useMemo(
    () =>
      auction && cursor > 0
        ? freezeSnapshot(
            players,
            auction.events,
            cursor - 1,
            auction.startingCredits,
            teamNames,
          )
        : null,
    [auction, cursor, players, teamNames],
  );
  const currentEvent =
    auction && cursor > 0 ? auction.events[cursor - 1] : null;
  const currentPlayer = currentEvent
    ? players.find(
        (player) => playerKey(player.id) === playerKey(currentEvent.playerId),
      )
    : null;

  useEffect(() => {
    if (!auction || !currentEvent || !currentPlayer || !preSaleSnapshot) {
      setAdvice(null);
      setAdviceState("idle");
      return;
    }
    const cacheKey = `${activeProfileId}:${auction.seed}:${cursor}`;
    const cached = adviceCache.current.get(cacheKey);
    const id = latestAdviceId.current + 1;
    latestAdviceId.current = id;
    if (cached) {
      setAdvice(cached);
      setAdviceState("ready");
      return undefined;
    }
    setAdvice(null);
    setAdviceState("loading");
    const worker = new Worker(
      new URL("./simulation.worker.js", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;
    worker.onmessage = ({ data: result }) => {
      adviceCache.current.set(cacheKey, result);
      if (id !== latestAdviceId.current) return;
      setAdvice(result);
      setAdviceState("ready");
    };
    worker.onerror = () => {
      if (id !== latestAdviceId.current) return;
      setAdvice(null);
      setAdviceState("error");
    };
    worker.postMessage({
      requestId: id,
      player: currentPlayer,
      owner: userTeamIndex,
      mine: preSaleSnapshot.teams[userTeamIndex],
      teams: preSaleSnapshot.teams,
      remaining: preSaleSnapshot.remaining,
      assigned: preSaleSnapshot.assignments,
      history: preSaleSnapshot.history,
      rules: normalizedRules,
    });
    return () => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [
    activeProfileId,
    auction,
    cursor,
    currentEvent,
    currentPlayer,
    normalizedRules,
    preSaleSnapshot,
    userTeamIndex,
  ]);

  const moveCursor = (direction) => {
    setPlaying(false);
    setCursor((current) =>
      Math.max(0, Math.min(auction.events.length, current + direction)),
    );
  };

  const simulateLeague = () => {
    if (!auction || cursor !== auction.events.length) return;
    const runId = leagueRunId.current + 1;
    leagueRunId.current = runId;
    setLeagueState("loading");
    setStandings(null);
    setError("");
    leagueTimer.current = window.setTimeout(() => {
      try {
        const result = simulateMockLeague({
          players,
          events: auction.events,
          teamNames,
          seed: randomSeed(),
          rules: normalizedRules,
        });
        if (runId !== leagueRunId.current) return;
        setStandings(result);
        setLeagueState("ready");
      } catch (simulationError) {
        if (runId !== leagueRunId.current) return;
        setLeagueState("error");
        setError(
          simulationError instanceof Error
            ? simulationError.message
            : "Impossibile simulare la lega.",
        );
      }
    }, 0);
  };

  return (
    <section className="random-auction" aria-labelledby="random-auction-title">
      <header className="ra-header">
        <div>
          <span className="ra-kicker">
            ASTA CASUALE · {teamNames.length} SQUADRE · {NOMINATION_LABELS[normalizedRules.auction.nomination]}
          </span>
          <h1 id="random-auction-title">Replay dell'asta</h1>
          <p>
            Esplora ogni assegnazione, confronta il consiglio pre-asta e simula
            la classifica finale.
          </p>
        </div>
        <div className="ra-new-auction">
          <label htmlFor="random-auction-credits">Crediti iniziali lega</label>
          <input
            id="random-auction-credits"
            type="number"
            min="25"
            step="1"
            value={startingCredits}
            onChange={(event) => setStartingCredits(event.target.value)}
          />
          <button type="button" className="ra-primary" onClick={startAuction}>
            {auction ? "Nuova asta casuale" : "Avvia asta casuale"}
          </button>
        </div>
      </header>

      {error && (
        <p className="ra-error" role="alert">
          {error}
        </p>
      )}

      {!auction ? (
        <div className="ra-empty">
          <h2>Pronto per il sorteggio</h2>
          <p>
            Avvia una nuova asta per generare {totalSales} acquisti con seed
            casuale.
          </p>
        </div>
      ) : (
        <>
          <section className="ra-replay" aria-label="Controlli replay asta">
            <div className="ra-progress-copy">
              <span>ASSEGNAZIONE</span>
              <strong>
                {cursor} / {auction.events.length}
              </strong>
              <small>Seed asta {auction.seed}</small>
            </div>
            <progress value={cursor} max={auction.events.length}>
              {cursor} di {auction.events.length}
            </progress>
            <div className="ra-controls">
              <button
                type="button"
                onClick={() => moveCursor(-1)}
                disabled={cursor === 0}
              >
                Precedente
              </button>
              <button
                type="button"
                className="ra-primary"
                onClick={() => setPlaying((active) => !active)}
                disabled={cursor === auction.events.length && !playing}
                aria-pressed={playing}
              >
                {playing ? "Pausa" : "Play"}
              </button>
              <button
                type="button"
                onClick={() => moveCursor(1)}
                disabled={cursor === auction.events.length}
              >
                Successiva
              </button>
            </div>
          </section>

          {currentEvent && currentPlayer ? (
            <article
              className={`ra-current ${currentEvent.owner === userTeamIndex ? "is-mine" : ""}`}
            >
              <div
                className="ra-player-role"
                aria-label={`Ruolo ${currentPlayer.ruolo}`}
              >
                {currentPlayer.ruolo}
              </div>
              <div>
                <span className="ra-kicker">
                  {currentEvent.owner === userTeamIndex
                    ? `ACQUISTO DI ${teamNames[userTeamIndex]}`
                    : "VENDITA CORRENTE"}
                </span>
                <h2>{currentPlayer.nome}</h2>
                <p>{currentPlayer.squadra || "Squadra non indicata"}</p>
              </div>
              <dl>
                <div>
                  <dt>Chiamante</dt>
                  <dd>{teamNames[currentEvent.nominator]}</dd>
                </div>
                <div>
                  <dt>Acquirente</dt>
                  <dd>{teamNames[currentEvent.owner]}</dd>
                </div>
                <div>
                  <dt>Prezzo</dt>
                  <dd>{currentEvent.price} cr.</dd>
                </div>
              </dl>
            </article>
          ) : (
            <div className="ra-current ra-before">
              <h2>Prima della prima chiamata</h2>
              <p>Premi Successiva o Play per iniziare il replay.</p>
            </div>
          )}

          {currentEvent && (
            <section className="ra-advice" aria-labelledby="ra-advice-title">
              <div className="ra-section-heading">
                <div>
                  <span className="ra-kicker">
                    SNAPSHOT PRE-VENDITA · {teamNames[userTeamIndex]}
                  </span>
                  <h2 id="ra-advice-title">
                    Consiglio per {teamNames[userTeamIndex]}
                  </h2>
                </div>
                {adviceState === "loading" && (
                  <span className="ra-state" role="status">
                    Analisi in corso...
                  </span>
                )}
              </div>
              {adviceState === "error" && (
                <p className="ra-inline-error" role="alert">
                  Il motore dei consigli non è disponibile.
                </p>
              )}
              {adviceState === "ready" && advice && (
                <>
                  <div
                    className={`ra-outcome ${currentEvent.owner === userTeamIndex ? (currentEvent.price <= advice.maxBid ? "good" : "warning") : currentEvent.price > advice.maxBid ? "good" : "notice"}`}
                  >
                    <b>Esito simulato</b>
                    <span>
                      {currentEvent.owner === userTeamIndex
                        ? currentEvent.price <= advice.maxBid
                          ? `Acquisto coerente: ${currentEvent.price} crediti, entro il limite di ${advice.maxBid}.`
                          : `Acquisto aggressivo: ${currentEvent.price} crediti, oltre il limite di ${advice.maxBid}.`
                        : currentEvent.price > advice.maxBid
                          ? `Scelta prudente: il prezzo finale di ${currentEvent.price} supera il tuo limite di ${advice.maxBid}.`
                          : `Occasione mancata: il prezzo finale di ${currentEvent.price} era entro il tuo limite di ${advice.maxBid}.`}
                    </span>
                  </div>
                  <div className="ra-advice-content">
                    <div className="ra-verdict">
                      <span>Raccomandazione</span>
                      <strong>
                        {RECOMMENDATIONS[advice.recommendation] ||
                          advice.recommendation}
                      </strong>
                      <small>
                        Confidenza {Math.round((advice.confidence || 0) * 100)}%
                      </small>
                    </div>
                    <dl className="ra-price-grid">
                      <div>
                        <dt>Fascia ideale</dt>
                        <dd>
                          {advice.idealMin}-{advice.idealMax} cr.
                        </dd>
                      </div>
                      <div>
                        <dt>Offerta massima</dt>
                        <dd>{advice.maxBid} cr.</dd>
                      </div>
                    </dl>
                    <AdviceList title="Perché" items={advice.reasons} />
                    <AdviceList
                      title="Rischi"
                      items={advice.risks}
                      empty="Nessun rischio specifico rilevato."
                    />
                    <div className="ra-alternatives">
                      <h3>Alternative</h3>
                      {advice.alternatives?.length ? (
                        <ul>
                          {advice.alternatives.map((alternative) => (
                            <li key={alternative.id}>
                              <strong>{alternative.name}</strong>
                              <span>
                                {alternative.role} · stima{" "}
                                {alternative.estimatedCost} cr.
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>Nessuna alternativa comparabile.</p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </section>
          )}

          <section className="ra-teams" aria-labelledby="ra-teams-title">
            <div className="ra-section-heading">
              <div>
                <span className="ra-kicker">SITUAZIONE AL CURSORE</span>
                <h2 id="ra-teams-title">
                  Le rose delle {teamNames.length} squadre
                </h2>
              </div>
            </div>
            <div className="ra-team-grid">
              {snapshot.teams.map((team, owner) => (
                <article
                  className={owner === userTeamIndex ? "is-mine" : ""}
                  key={team.name}
                >
                  <header>
                    <div>
                      <span>
                        {owner === userTeamIndex
                          ? "La tua squadra"
                          : `Squadra ${owner + 1}`}
                      </span>
                      <h3>{team.name}</h3>
                    </div>
                    <strong>{team.credits} cr.</strong>
                  </header>
                  <p className="ra-role-summary">
                    {roleOrder
                      .map(
                        (role) =>
                          `${role} ${team.roster.filter((player) => player.ruolo === role).length}`,
                      )
                      .join(" · ")}
                  </p>
                  <div
                    className="ra-roster"
                    aria-label={`Acquisti di ${team.name}`}
                  >
                    {team.roster.length ? (
                      team.roster.map((player) => (
                        <div key={playerKey(player.id)}>
                          <span className={`ra-role role-${player.ruolo}`}>
                            {player.ruolo}
                          </span>
                          <strong>{player.nome}</strong>
                          <span>
                            {snapshot.assignments[String(player.id)].price} cr.
                          </span>
                        </div>
                      ))
                    ) : (
                      <p>Nessun acquisto al cursore corrente.</p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="ra-league" aria-labelledby="ra-league-title">
            <div>
              <span className="ra-kicker">DOPO L'ASTA</span>
              <h2 id="ra-league-title">Simulazione lega</h2>
              <p>
                Il pulsante si sblocca solo dopo tutte le{" "}
                {auction.events.length} assegnazioni.
              </p>
            </div>
            <button
              type="button"
              className="ra-primary"
              onClick={simulateLeague}
              disabled={
                cursor !== auction.events.length || leagueState === "loading"
              }
            >
              {leagueState === "loading" ? "Simulazione..." : "Simula lega"}
            </button>
          </section>

          {standings && (
            <div className="ra-standings" aria-live="polite">
              <table>
                <caption>Classifica finale simulata</caption>
                <thead>
                  <tr>
                    <th scope="col">Pos.</th>
                    <th scope="col">Squadra</th>
                    <th scope="col">Pt</th>
                    <th scope="col">V</th>
                    <th scope="col">N</th>
                    <th scope="col">P</th>
                    <th scope="col">GF</th>
                    <th scope="col">GS</th>
                    <th scope="col">Fanta pt</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map((row) => (
                    <tr
                      className={
                        row.team === teamNames[userTeamIndex] ? "is-mine" : ""
                      }
                      key={row.team}
                    >
                      <td>{row.rank}</td>
                      <th scope="row">{row.team}</th>
                      <td>{row.points}</td>
                      <td>{row.wins}</td>
                      <td>{row.draws}</td>
                      <td>{row.losses}</td>
                      <td>{row.goalsFor}</td>
                      <td>{row.goalsAgainst}</td>
                      <td>{row.fantasyPoints}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function AdviceList({ title, items = [], empty }) {
  return (
    <div className="ra-advice-list">
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </div>
  );
}

export default RandomAuctionView;
