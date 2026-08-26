import { useEffect, useMemo, useRef, useState } from "react";
import { activeNominationRole } from "../auction-nomination.js";
import {
  auctionStorageKey,
  emptyAuction,
  isValidBid,
  legalMaxBid,
  playerIdKey,
  rehydrateAuction,
  serializeAuction,
  slotsLeft,
} from "../auction-state.js";
import { normalizeRules } from "../league-rules.js";
import {
  Disclosure,
  Empty,
  Icon,
  PlayerRow,
  RoleChip,
  ROLE_LABELS,
  formatTier,
} from "../ui.jsx";

const RECOMMENDATION_LABELS = {
  STRONG_BUY: "Compra",
  BID: "Conviene",
  VALUE_ONLY: "Solo al prezzo giusto",
  PASS: "Lascia andare",
  INELIGIBLE: "Non acquistabile",
};

const RECOMMENDATION_TONE = {
  STRONG_BUY: "go",
  BID: "go",
  VALUE_ONLY: "warn",
  PASS: "stop",
  INELIGIBLE: "stop",
};

const STEPS = [-5, -1, 1, 5];

const clampPercent = (value) => Math.max(0, Math.min(100, value));

/**
 * Live auction.
 *
 * The screen is built around one moving number — the price currently on the
 * table — and shows, at a glance, where that number sits against the advisor's
 * ideal band, its value ceiling and the estimated market price. Everything the
 * advisor also computed (reasons, risks, alternatives, squad plan) is one tap
 * away rather than stacked on the page, because at an auction you read the
 * verdict now and the argument later.
 */
export default function AuctionView({ data, openPlayer, rules, profileId }) {
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

  const [state, setState] = useState(loadAuction);
  const [userTeamIndex, setUserTeamIndex] = useState(defaultUserTeamIndex);
  const [query, setQuery] = useState("");
  const [player, setPlayer] = useState(null);
  const [owner, setOwner] = useState(userTeamIndex);
  const [price, setPrice] = useState("");
  const [advice, setAdvice] = useState(null);
  const [overview, setOverview] = useState(null);
  const [message, setMessage] = useState(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const worker = useRef();
  const skipPersist = useRef(false);
  const priceTouched = useRef(false);

  const workerHistory = state.history.flatMap((transaction) => {
    const transactionPlayer = data.players.find(
      (candidate) =>
        playerIdKey(candidate.id) === playerIdKey(transaction.playerId),
    );
    return transactionPlayer
      ? [{ ...transaction, player: transactionPlayer }]
      : [];
  });

  useEffect(() => {
    skipPersist.current = true;
    setState(loadAuction());
    setUserTeamIndex(defaultUserTeamIndex);
    setOwner(defaultUserTeamIndex);
    setPlayer(null);
    setQuery("");
    setPrice("");
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
      new URL("../simulation.worker.js", import.meta.url),
      { type: "module" },
    );
    worker.current.onmessage = (event) =>
      event.data.kind === "overview"
        ? setOverview(event.data)
        : setAdvice(event.data);
    return () => worker.current.terminate();
  }, []);

  useEffect(() => {
    if (!player) return setAdvice(null);
    worker.current.postMessage({
      player,
      owner: userTeamIndex,
      mine: state.teams[userTeamIndex],
      teams: state.teams,
      remaining: data.players.filter(
        (candidate) => !state.assigned[playerIdKey(candidate.id)],
      ),
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
      remaining: data.players.filter(
        (candidate) => !state.assigned[playerIdKey(candidate.id)],
      ),
      assigned: state.assigned,
      history: workerHistory,
      rules: activeRules,
    });
  }, [state, data, rulesSignature, userTeamIndex]);

  const activeRole = activeNominationRole(state.teams, activeRules);
  const myTeam = state.teams[userTeamIndex];
  const mySlots = slotsLeft(myTeam, activeRules);
  const myMax = legalMaxBid(myTeam, activeRules);
  const ownerTeam = state.teams[owner];
  const selectedLegalMax = legalMaxBid(ownerTeam, activeRules);
  const totalSlots = Object.values(activeRules.rosterSlots).reduce(
    (sum, count) => sum + count,
    0,
  );
  const canSetStartingCredits =
    state.history.length === 0 && !state.undone?.length;

  const choices = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return data.players
      .filter(
        (candidate) =>
          !state.assigned[playerIdKey(candidate.id)] &&
          (!activeRole || candidate.ruolo === activeRole) &&
          candidate.nome.toLowerCase().includes(needle),
      )
      .slice(0, 8);
  }, [data.players, state.assigned, activeRole, query]);

  /* The price box opens on the estimated market price so the common case needs
     no typing; the moment the user edits it we stop overwriting their number. */
  useEffect(() => {
    if (!player || !advice || priceTouched.current) return;
    const estimate = Number(advice.summary?.estimatedMarketPrice);
    if (!Number.isFinite(estimate) || estimate < activeRules.auction.minPrice)
      return;
    setPrice(String(Math.min(estimate, selectedLegalMax || estimate)));
  }, [player, advice]);

  const say = (text, tone = "info") => setMessage({ text, tone });

  const resetSelection = () => {
    setPlayer(null);
    setQuery("");
    setPrice("");
    priceTouched.current = false;
    setSuggestionsOpen(false);
  };

  const selectPlayer = (candidate) => {
    if (activeRole && candidate.ruolo !== activeRole) {
      say(
        `In questa fase puoi chiamare solo ${ROLE_LABELS[activeRole].toLowerCase()}.`,
        "stop",
      );
      return;
    }
    priceTouched.current = false;
    setPlayer(candidate);
    setQuery(candidate.nome);
    setPrice("");
    setSuggestionsOpen(false);
    setMessage(null);
  };

  const bumpPrice = (delta) => {
    priceTouched.current = true;
    const current = Number(price) || activeRules.auction.minPrice;
    const next = Math.max(
      activeRules.auction.minPrice,
      Math.min(selectedLegalMax || current + delta, current + delta),
    );
    setPrice(String(next));
  };

  const assign = () => {
    const value = Number(price);
    const team = state.teams[owner];
    if (!player) return;
    if (state.assigned[playerIdKey(player.id)]) {
      say(`${player.nome} risulta già assegnato.`, "stop");
      return;
    }
    if (activeRole && player.ruolo !== activeRole) {
      say(
        `In questa fase puoi assegnare solo ${ROLE_LABELS[activeRole].toLowerCase()}.`,
        "stop",
      );
      return;
    }
    if (!Number.isInteger(value) || value < activeRules.auction.minPrice) {
      say(
        `Inserisci un prezzo intero di almeno ${activeRules.auction.minPrice} crediti.`,
        "stop",
      );
      return;
    }
    if ((value - activeRules.auction.minPrice) % activeRules.auction.increment) {
      say(
        `Il prezzo deve salire di ${activeRules.auction.increment} crediti a partire da ${activeRules.auction.minPrice}.`,
        "stop",
      );
      return;
    }
    const legalMax = legalMaxBid(team, activeRules);
    if (value > legalMax) {
      const reserve =
        Math.max(
          0,
          Object.values(slotsLeft(team, activeRules)).reduce(
            (sum, count) => sum + count,
            0,
          ) - 1,
        ) * activeRules.auction.reserve;
      say(
        `${team.name} può spendere al massimo ${legalMax} crediti: deve conservarne ${reserve} per completare la rosa.`,
        "stop",
      );
      return;
    }
    if (slotsLeft(team, activeRules)[player.ruolo] < 1) {
      say(
        `${team.name} non ha più posti per ${(ROLE_LABELS[player.ruolo] || player.ruolo).toLowerCase()}.`,
        "stop",
      );
      return;
    }
    setState((current) => ({
      ...current,
      teams: current.teams.map((team_, index) =>
        index === owner
          ? {
              ...team_,
              credits: team_.credits - value,
              roster: [...team_.roster, player],
            }
          : team_,
      ),
      assigned: {
        ...current.assigned,
        [playerIdKey(player.id)]: { owner, price: value },
      },
      history: [...current.history, { playerId: player.id, owner, price: value }],
      undone: [],
    }));
    say(`${player.nome} a ${team.name} per ${value} crediti.`, "go");
    resetSelection();
  };

  const undo = () => {
    const last = state.history.at(-1);
    if (!last) return;
    setState((current) => {
      const assigned = { ...current.assigned };
      delete assigned[playerIdKey(last.playerId)];
      return {
        ...current,
        assigned,
        history: current.history.slice(0, -1),
        undone: [...(current.undone || []), last],
        teams: current.teams.map((team, index) =>
          index === last.owner
            ? {
                ...team,
                credits: team.credits + last.price,
                roster: team.roster.filter(
                  (item) => playerIdKey(item.id) !== playerIdKey(last.playerId),
                ),
              }
            : team,
        ),
      };
    });
    say(
      `Annullata l'assegnazione di ${
        data.players.find(
          (item) => playerIdKey(item.id) === playerIdKey(last.playerId),
        )?.nome || "giocatore"
      }.`,
    );
  };

  const redo = () => {
    const last = state.undone?.at(-1);
    if (!last) return;
    const team = state.teams[last.owner];
    const restored = data.players.find(
      (item) => playerIdKey(item.id) === playerIdKey(last.playerId),
    );
    if (
      !restored ||
      state.assigned[playerIdKey(last.playerId)] ||
      slotsLeft(team, activeRules)[restored.ruolo] < 1 ||
      !isValidBid(last.price, team, activeRules)
    ) {
      say(
        "Non posso ripristinare l'operazione: budget o slot sono cambiati.",
        "stop",
      );
      return;
    }
    setState((current) => ({
      ...current,
      teams: current.teams.map((team_, index) =>
        index === last.owner
          ? {
              ...team_,
              credits: team_.credits - last.price,
              roster: [...team_.roster, restored],
            }
          : team_,
      ),
      assigned: {
        ...current.assigned,
        [playerIdKey(last.playerId)]: {
          owner: last.owner,
          price: last.price,
        },
      },
      history: [...current.history, last],
      undone: current.undone.slice(0, -1),
    }));
    say(`Ripristinata l'assegnazione di ${restored.nome}.`, "go");
  };

  const flushAuction = () => {
    if (
      !window.confirm(
        "Vuoi cancellare tutta l'asta salvata? L'operazione non può essere annullata.",
      )
    )
      return;
    setState(emptyAuction(activeRules));
    resetSelection();
    say("Asta azzerata. Puoi reimpostare i crediti iniziali.", "go");
  };

  const updateStartingCredits = (teamIndex, value) => {
    const credits = Number(value);
    if (!Number.isInteger(credits) || credits < 25) return;
    setState((current) => ({
      ...current,
      teams: current.teams.map((team, index) =>
        index === teamIndex ? { ...team, startingCredits: credits, credits } : team,
      ),
    }));
  };

  const lastTransaction = state.history.at(-1);
  const lastPlayer = lastTransaction
    ? data.players.find(
        (item) => playerIdKey(item.id) === playerIdKey(lastTransaction.playerId),
      )
    : null;

  return (
    <div className="auction">
      {activeRole ? (
        <p className="phase">
          <RoleChip role={activeRole} />
          Fase {ROLE_LABELS[activeRole].toLowerCase()}: si chiamano solo loro.
        </p>
      ) : null}

      <div className="auction-split">
        <div className="stack">
          <MyTeamBar
            team={myTeam}
            slots={mySlots}
            max={myMax}
            rosterSize={myTeam.roster.length}
            totalSlots={totalSlots}
            teams={state.teams}
            userTeamIndex={userTeamIndex}
            onChangeUserTeam={(index) => {
              setUserTeamIndex(index);
              setOwner(index);
            }}
          />

          <div className="nominate">
            <div
              className="nominate-field"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setSuggestionsOpen(false);
              }}
            >
              <Icon name="search" className="nominate-icon" />
              <input
                id="auction-player"
                className="input"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (player && activeRole && player.ruolo !== activeRole)
                    setPlayer(null);
                  setSuggestionsOpen(true);
                }}
                onFocus={() => setSuggestionsOpen(true)}
                onKeyDown={(event) =>
                  event.key === "Escape" && setSuggestionsOpen(false)
                }
                placeholder="Chi è in asta?"
                autoComplete="off"
                aria-label="Giocatore in asta"
                aria-describedby="auction-results"
              />
              {query ? (
                <button
                  type="button"
                  className="icon-btn nominate-clear"
                  onClick={resetSelection}
                  aria-label="Svuota la ricerca"
                >
                  <Icon name="close" />
                </button>
              ) : null}
              {suggestionsOpen && query.trim().length >= 2 ? (
                <div className="results" id="auction-results">
                  <span className="results-note">
                    {choices.length
                      ? `${choices.length} giocatori disponibili`
                      : "Nessun giocatore disponibile"}
                  </span>
                  <div className="rows">
                    {choices.map((candidate) => (
                      <PlayerRow
                        key={candidate.id}
                        player={candidate}
                        className="player-row"
                        value={candidate.fvm_scaled}
                        valueLabel="valore"
                        onClick={() => selectPlayer(candidate)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {message ? (
            <p
              className={`notice notice--${message.tone}`}
              role="status"
              aria-live="polite"
            >
              {message.text}
            </p>
          ) : null}

          {player ? (
            <VerdictCard
              player={player}
              advice={advice}
              price={price}
              rules={activeRules}
              legalMax={selectedLegalMax}
              teams={state.teams}
              owner={owner}
              userTeamIndex={userTeamIndex}
              onOwner={setOwner}
              onPrice={(value) => {
                priceTouched.current = true;
                setPrice(value);
              }}
              onStep={bumpPrice}
              onAssign={assign}
              onCancel={resetSelection}
              onOpenPlayer={() => openPlayer(player)}
            />
          ) : (
            <div className="card">
              <Empty title="Nessun giocatore in asta">
                Scrivi almeno due lettere del nome chiamato per vedere il
                consiglio e registrare il prezzo.
              </Empty>
            </div>
          )}

          <div className="log-strip">
            {lastPlayer ? (
              <span>
                Ultima: <b>{lastPlayer.nome}</b> a{" "}
                {state.teams[lastTransaction.owner]?.name} per{" "}
                {lastTransaction.price}
              </span>
            ) : (
              <span>Nessuna assegnazione registrata.</span>
            )}
            <button
              type="button"
              className="btn btn--sm"
              onClick={undo}
              disabled={!state.history.length}
            >
              Annulla
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={redo}
              disabled={!state.undone?.length}
            >
              Ripristina
            </button>
          </div>
        </div>

        <aside className="auction-aside stack">
          {overview ? <RosePlan overview={overview} /> : null}

          <section>
            <div className="section-head">
              <h2>Le rose della lega</h2>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setShowSetup((value) => !value)}
                aria-expanded={showSetup}
              >
                {showSetup ? "Fine" : "Modifica"}
              </button>
            </div>
            <div className="teams-board">
              {state.teams.map((team, index) => (
                <TeamCard
                  key={index}
                  team={team}
                  index={index}
                  rules={activeRules}
                  isMine={index === userTeamIndex}
                  assigned={state.assigned}
                  showSetup={showSetup}
                  canSetStartingCredits={canSetStartingCredits}
                  onRename={(name) =>
                    setState((current) => ({
                      ...current,
                      teams: current.teams.map((team_, teamIndex) =>
                        teamIndex === index ? { ...team_, name } : team_,
                      ),
                    }))
                  }
                  onCredits={(value) => updateStartingCredits(index, value)}
                  onOpenPlayer={openPlayer}
                />
              ))}
            </div>
          </section>

          <button type="button" className="btn btn--danger" onClick={flushAuction}>
            Azzera l&apos;asta salvata
          </button>
        </aside>
      </div>
    </div>
  );
}

/** Budget, remaining slots and legal ceiling: the frame around every decision. */
function MyTeamBar({
  team,
  slots,
  max,
  rosterSize,
  totalSlots,
  teams,
  userTeamIndex,
  onChangeUserTeam,
}) {
  return (
    <div className="myteam">
      <div className="myteam-top">
        <div>
          <label className="visually-hidden" htmlFor="auction-user-team">
            La mia squadra
          </label>
          <select
            id="auction-user-team"
            className="select"
            value={userTeamIndex}
            onChange={(event) => onChangeUserTeam(Number(event.target.value))}
            style={{ minHeight: 32, fontSize: "var(--fs-xs)", padding: "0 26px 0 8px", width: "auto", maxWidth: "12rem" }}
          >
            {teams.map((item, index) => (
              <option value={index} key={index}>
                {item.name}
              </option>
            ))}
          </select>
          <div className="myteam-credits">
            {team.credits}
            <span>crediti · {rosterSize}/{totalSlots}</span>
          </div>
        </div>
        <div className="myteam-max">
          <b>{max}</b>
          <span>max bid</span>
        </div>
      </div>
      <div className="slot-row">
        {Object.entries(slots).map(([role, count]) => (
          <span
            key={role}
            className={`slot role-${role}${count <= 0 ? " is-done" : ""}`}
          >
            {role}
            <b className="slot-open">{Math.max(0, count)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The verdict. One scale from zero to the highest legal bid carries the ideal
 * band, the value ceiling and the market estimate; the marker is the price on
 * the table. Crossing a boundary recolours the whole card, so the answer to
 * "can I still go up?" arrives before any number is read.
 */
function VerdictCard({
  player,
  advice,
  price,
  rules,
  legalMax,
  teams,
  owner,
  userTeamIndex,
  onOwner,
  onPrice,
  onStep,
  onAssign,
  onCancel,
  onOpenPlayer,
}) {
  const value = Number(price);
  const hasPrice = Number.isFinite(value) && value > 0;
  const market = Number(advice?.summary?.estimatedMarketPrice);
  const maxBid = Number(advice?.maxBid ?? 0);
  const idealMin = Number(advice?.idealMin ?? 0);
  const idealMax = Number(advice?.idealMax ?? 0);

  /* The headline answers the question actually being asked at the table — "at
     this price, yes or no?" — so it follows the live number, not the static
     recommendation. The recommendation stays underneath as the reference. */
  const unaffordable = maxBid < rules.auction.minPrice;
  const priceTone = unaffordable
    ? "stop"
    : value > legalMax || value > maxBid
      ? "stop"
      : value > idealMax
        ? "warn"
        : "go";
  const tone = !advice
    ? null
    : hasPrice
      ? priceTone
      : RECOMMENDATION_TONE[advice.recommendation] || null;

  const recommendation =
    RECOMMENDATION_LABELS[advice?.recommendation] || "Valuta";
  const headline = !advice
    ? "Calcolo…"
    : unaffordable
      ? "Non acquistabile"
      : !hasPrice
        ? recommendation
        : value > legalMax
          ? "Fuori budget"
          : value > maxBid
            ? "Troppo caro"
            : value > idealMax
              ? "Ancora accettabile"
              : recommendation;

  /* The scale is framed on the decision, not on the whole wallet: anchoring it
     to the legal ceiling would squeeze every marker into the first few pixels. */
  const anchor = Math.max(
    maxBid,
    Number.isFinite(market) ? market : 0,
    hasPrice ? value : 0,
    rules.auction.minPrice,
  );
  const scale = Math.max(anchor * 1.25, anchor + 4);
  const pct = (input) => clampPercent((input / scale) * 100);

  const forOther = owner !== userTeamIndex;

  return (
    <section
      className={`verdict${tone ? ` is-${tone}` : ""}`}
      aria-label="Consiglio sul giocatore in asta"
    >
      <div className="verdict-head">
        <RoleChip role={player.ruolo} large />
        <div className="verdict-id">
          <h2>{player.nome}</h2>
          <p>
            {player.squadra} · {formatTier(player.guida_asta_fascia)}
          </p>
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onOpenPlayer}
        >
          Scheda
        </button>
      </div>

      <div className="verdict-call">
        <strong className="verdict-word">{headline}</strong>
        <span className="verdict-sub">
          {advice
            ? `Consiglio: ${recommendation} · confidenza ${Math.round(advice.confidence * 100)}% · ${advice.utility}`
            : "Sto valutando la rosa e il mercato."}
        </span>
      </div>

      {advice && maxBid >= rules.auction.minPrice ? (
        <div className="gauge">
          <div
            className="gauge-track"
            style={{
              "--ideal-start": `${pct(idealMin)}%`,
              "--ideal-width": `${Math.max(0, pct(idealMax) - pct(idealMin))}%`,
              "--now": `${hasPrice ? pct(value) : 0}%`,
            }}
          >
            <span className="gauge-fill" />
            <span className="gauge-band" />
            {Number.isFinite(market) ? (
              <span
                className="gauge-mark gauge-mark--market"
                style={{ "--at": `${pct(market)}%` }}
              />
            ) : null}
            <span
              className="gauge-mark gauge-mark--cap"
              style={{ "--at": `${pct(maxBid)}%` }}
            />
            {hasPrice ? (
              <span
                className="gauge-thumb"
                style={{ "--now": `${pct(value)}%` }}
              >
                {value}
              </span>
            ) : null}
          </div>
          <div className="gauge-legend">
            <span>
              <i className="k-band" />
              ideale <b>{idealMin}–{idealMax}</b>
            </span>
            <span>
              <i className="k-cap" />
              non superare <b>{maxBid}</b>
            </span>
            {Number.isFinite(market) ? (
              <span>
                <i className="k-market" />
                mercato <b>{market}</b>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="bidbar">
        <div className="stepper">
          {STEPS.slice(0, 2).map((step) => (
            <button
              key={step}
              type="button"
              onClick={() => onStep(step)}
              aria-label={`Riduci di ${Math.abs(step)}`}
            >
              {step}
            </button>
          ))}
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={rules.auction.minPrice}
            max={legalMax}
            step={rules.auction.increment}
            value={price}
            onChange={(event) => onPrice(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && onAssign()}
            placeholder="Prezzo"
            aria-label="Prezzo di acquisto in crediti"
          />
          {STEPS.slice(2).map((step) => (
            <button
              key={step}
              type="button"
              onClick={() => onStep(step)}
              aria-label={`Aumenta di ${step}`}
            >
              +{step}
            </button>
          ))}
        </div>

        <div className="assign-row">
          <select
            className="select"
            value={owner}
            onChange={(event) => onOwner(Number(event.target.value))}
            aria-label="Squadra acquirente"
          >
            {teams.map((team, index) => (
              <option value={index} key={index}>
                {index === userTeamIndex ? "→ " : ""}
                {team.name} · {team.credits} cr.
              </option>
            ))}
          </select>
          {/* Recording a purchase is neutral: green here would read as approval
              of the price, which is exactly what the gauge is for. */}
          <button type="button" className="btn btn--primary" onClick={onAssign}>
            Assegna
          </button>
        </div>

        <div className="bid-foot">
          <span className="micro">
            {forOther
              ? "Stai registrando l'acquisto di un'altra squadra: il consiglio resta calcolato sulla tua."
              : `Massimo consentito dalle regole: ${legalMax} crediti.`}
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onCancel}
          >
            Annulla
          </button>
        </div>
      </div>

      {advice ? (
        <div className="verdict-more">
          <Disclosure summary="Perché" badge={`${advice.reasons.length}`}>
            <ul className="bullets">
              {advice.reasons.slice(0, 4).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </Disclosure>
          <Disclosure
            summary="Attenzione"
            badge={advice.risks.length ? `${advice.risks.length}` : "0"}
          >
            {advice.risks.length ? (
              <ul className="bullets bullets--warn">
                {advice.risks.slice(0, 4).map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            ) : (
              <p className="micro">Nessun rischio specifico rilevato.</p>
            )}
          </Disclosure>
          {advice.alternatives.length ? (
            <Disclosure
              summary="Alternative nello stesso ruolo"
              badge={`${advice.alternatives.length}`}
            >
              <div className="rows">
                {advice.alternatives.map((alternative) => (
                  <div className="row" key={alternative.id}>
                    <RoleChip role={alternative.role} />
                    <span className="row-main">
                      <span className="row-title">{alternative.name}</span>
                      <span className="row-sub">
                        differenza di valore {alternative.valueGap}
                      </span>
                    </span>
                    <span className="row-value">
                      ≈ {alternative.estimatedCost}
                    </span>
                  </div>
                ))}
              </div>
            </Disclosure>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Where the remaining budget should go next, by department. */
function RosePlan({ overview }) {
  return (
    <section className="card">
      <div className="section-head">
        <div>
          <span className="kicker">Piano aggiornato</span>
          <h2>Prossime mosse</h2>
        </div>
        <div className="stat" style={{ textAlign: "right" }}>
          <span className="stat-label">Spendibili</span>
          <span className="stat-value">{overview.summary.spendableCredits}</span>
        </div>
      </div>
      <div className="rows">
        {overview.priorities.map((priority) => {
          const plan = overview.rolePlan[priority.role];
          const tone =
            priority.urgency === "ALTA"
              ? "stop"
              : priority.urgency === "MEDIA"
                ? "warn"
                : priority.urgency === "COMPLETO"
                  ? "go"
                  : "";
          return (
            <div className="row" key={priority.role}>
              <RoleChip role={priority.role} />
              <span className="row-main">
                <span className="row-title">
                  {ROLE_LABELS[priority.role]}{" "}
                  <span className={`pill${tone ? ` pill--${tone}` : ""}`}>
                    {priority.urgency}
                  </span>
                </span>
                <span className="row-sub" style={{ whiteSpace: "normal" }}>
                  {priority.reason}
                </span>
              </span>
              <span className="player-metric">
                <b>{plan.budgetTarget}</b>
                <small>obiettivo</small>
              </span>
            </div>
          );
        })}
      </div>
      <p className="micro" style={{ marginTop: "var(--s-3)" }}>
        Mercato rilevato {overview.summary.marketInflation.toFixed(2)}× rispetto
        ai valori base. Il piano si aggiorna dopo ogni assegnazione.
      </p>
    </section>
  );
}

/** One league team: collapsed to budget and slots, expandable to the squad. */
function TeamCard({
  team,
  index,
  rules,
  isMine,
  assigned,
  showSetup,
  canSetStartingCredits,
  onRename,
  onCredits,
  onOpenPlayer,
}) {
  const left = slotsLeft(team, rules);
  const max = legalMaxBid(team, rules);
  return (
    <details className={`team-card${isMine ? " is-mine" : ""}`} open={isMine}>
      <summary>
        <span className="team-card-name">
          {team.name}
          <small>
            max {max} · P{left.P} D{left.D} C{left.C} A{left.A}
          </small>
        </span>
        <span className="team-card-credits">
          {team.credits}
          <small> cr.</small>
        </span>
      </summary>
      {showSetup ? (
        <div className="team-setup">
          <label className="field">
            <span className="field-label">Nome squadra</span>
            <input
              className="input"
              value={team.name}
              onChange={(event) => onRename(event.target.value)}
              aria-label={`Nome squadra ${index + 1}`}
            />
          </label>
          {canSetStartingCredits ? (
            <label className="field">
              <span className="field-label">Crediti iniziali</span>
              <input
                className="input"
                type="number"
                min="25"
                step="1"
                value={team.credits}
                onChange={(event) => onCredits(event.target.value)}
              />
            </label>
          ) : (
            <p className="micro">
              L&apos;asta è iniziata: i crediti iniziali non si cambiano più.
            </p>
          )}
        </div>
      ) : null}
      <div className="team-card-body">
        {team.roster.length ? (
          team.roster.map((player) => (
            <PlayerRow
              key={player.id}
              player={player}
              className="player-row"
              value={assigned[playerIdKey(player.id)]?.price}
              valueLabel="pagato"
              onClick={() => onOpenPlayer(player)}
            />
          ))
        ) : (
          <p className="micro" style={{ padding: "var(--s-2)" }}>
            Nessun giocatore.
          </p>
        )}
      </div>
    </details>
  );
}
