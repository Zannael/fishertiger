import { useEffect, useMemo, useRef, useState } from "react";
import {
  auctionStorageKey,
  draftForQuery,
  draftPlayer,
  legalMaxBid,
  nearestAuctionPrice,
  playerIdKey,
  reconcileAuctionDraft,
  slotsLeft,
} from "../auction-state.js";
import { normalizeRules } from "../league-rules.js";
import {
  assignPlayer,
  defaultUserTeamIndex as configuredUserTeamIndex,
  redoAssignment,
  renameTeam,
  resetAuction,
  restoreAuctionBackup,
  setStartingCredits,
  undoAssignment,
  writeUserTeamIndex,
} from "../auction-store.js";
import { useAuctionBoard } from "../use-auction-store.js";
import { useAdvisor } from "../use-advisor.js";
import {
  AdviceDetail,
  BidGauge,
  PriceStepper,
  bidVerdict,
} from "../auction-advice.jsx";
import {
  Empty,
  Icon,
  PlayerRow,
  RoleChip,
  ROLE_LABELS,
  formatTier,
} from "../ui.jsx";

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
export default function AuctionView({
  data,
  openPlayer,
  rules,
  profileId,
  draft,
  setDraft,
}) {
  const activeRules = normalizeRules(
    rules ?? data.league_rules ?? { startingCredits: 750 },
  );
  const activeProfileId = String(
    profileId ?? data.profileId ?? data.profile_id ?? "default",
  );
  const storageKey = auctionStorageKey(activeProfileId);
  const rulesSignature = JSON.stringify(activeRules);
  const defaultUserTeamIndex = configuredUserTeamIndex(activeRules);

  const board = useAuctionBoard(activeProfileId, data.players, activeRules);
  const userTeamIndex = board.userTeamIndex;
  const { query, price } = draft;
  const setQuery = (value) =>
    setDraft((current) => ({ ...current, query: value }));
  const setPrice = (value) =>
    setDraft((current) => ({ ...current, price: value }));
  const player = draftPlayer(draft, data.players);
  const setPlayer = (candidate) =>
    setDraft((current) => ({
      ...current,
      playerId: candidate ? candidate.id : null,
    }));
  const [owner, setOwner] = useState(userTeamIndex);
  const [message, setMessage] = useState(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const priceTouched = useRef(false);
  const resetSignature = `${storageKey}|${rulesSignature}|${defaultUserTeamIndex}`;
  const lastResetSignature = useRef(resetSignature);
  const lastConfiguredUserTeam = useRef({
    key: storageKey,
    index: defaultUserTeamIndex,
  });

  /* A profile or a rules change starts a different auction: the team chosen in
     the settings wins over the one stored for the previous configuration. */
  useEffect(() => {
    const configuredChanged =
      lastConfiguredUserTeam.current.key === storageKey &&
      lastConfiguredUserTeam.current.index !== defaultUserTeamIndex;
    lastConfiguredUserTeam.current = {
      key: storageKey,
      index: defaultUserTeamIndex,
    };
    if (configuredChanged) writeUserTeamIndex(activeProfileId, defaultUserTeamIndex);
    setOwner(configuredChanged ? defaultUserTeamIndex : userTeamIndex);
    if (lastResetSignature.current !== resetSignature) {
      setPlayer(null);
      setQuery("");
      setPrice("");
      setMessage(null);
    }
    lastResetSignature.current = resetSignature;
  }, [storageKey, rulesSignature, defaultUserTeamIndex]);

  useEffect(() => setOwner(userTeamIndex), [userTeamIndex]);

  useEffect(() => {
    setDraft((current) => reconcileAuctionDraft(current, data.players, board));
  }, [data.players, board.assigned, board.activeRole, board.storageReadOk, setDraft]);

  const { advice, squadPlan: overview } = useAdvisor({
    player,
    board,
    players: data.players,
    rules: activeRules,
    overview: true,
  });

  const activeRole = board.activeRole;
  const myTeam = board.teams[userTeamIndex];
  const mySlots = slotsLeft(myTeam, activeRules);
  const myMax = legalMaxBid(myTeam, activeRules);
  const ownerTeam = board.teams[owner];
  const selectedLegalMax = legalMaxBid(ownerTeam, activeRules);
  const totalSlots = Object.values(activeRules.rosterSlots).reduce(
    (sum, count) => sum + count,
    0,
  );
  const canSetStartingCredits = !board.history.length && !board.undone.length;

  const choices = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return data.players
      .filter(
        (candidate) =>
          !board.assigned[playerIdKey(candidate.id)] &&
          (!activeRole || candidate.ruolo === activeRole) &&
          candidate.nome.toLowerCase().includes(needle),
      )
      .slice(0, 8);
  }, [data.players, board.assigned, activeRole, query]);

  /* The price box opens on the estimated market price so the common case needs
     no typing; the moment the user edits it we stop overwriting their number. */
  useEffect(() => {
    if (!player || !advice || priceTouched.current) return;
    const estimate = Number(advice.summary?.estimatedMarketPrice);
    if (!Number.isFinite(estimate) || estimate < activeRules.auction.minPrice)
      return;
    const suggested = nearestAuctionPrice(
      estimate,
      selectedLegalMax,
      activeRules,
    );
    if (suggested != null) setPrice(String(suggested));
  }, [player, advice, selectedLegalMax, rulesSignature]);

  const say = (text, tone = "info") => setMessage({ text, tone });

  /** Every store answer reaches the user: a refused write is not a silent one. */
  const report = (result, tone = "go") => {
    if (result.message) say(result.message, result.ok ? tone : "stop");
    else if (!result.ok) say("Operazione non riuscita.", "stop");
    else setMessage(null);
    return result.ok;
  };

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

  const assign = () => {
    if (!player) return;
    const result = assignPlayer(activeProfileId, data.players, activeRules, {
      playerId: player.id,
      owner,
      price: Number(price),
    });
    if (report(result)) resetSelection();
  };

  const undo = () =>
    report(undoAssignment(activeProfileId, data.players, activeRules), "info");

  const redo = () =>
    report(redoAssignment(activeProfileId, data.players, activeRules));

  const restoreBackup = () => {
    if (report(restoreAuctionBackup(activeProfileId, data.players, activeRules)))
      resetSelection();
  };

  const flushAuction = () => {
    if (
      !window.confirm(
        "Vuoi cancellare tutta l'asta salvata? L'operazione non può essere annullata.",
      )
    )
      return;
    if (report(resetAuction(activeProfileId, data.players, activeRules)))
      resetSelection();
  };

  const updateStartingCredits = (teamIndex, value) => {
    const credits = Number(value);
    if (!Number.isInteger(credits) || credits < 25) return;
    report(
      setStartingCredits(
        activeProfileId,
        data.players,
        activeRules,
        teamIndex,
        credits,
      ),
    );
  };

  const updateTeamName = (teamIndex, name) =>
    report(
      renameTeam(activeProfileId, data.players, activeRules, teamIndex, name),
    );

  const chooseUserTeam = (index) => {
    setOwner(index);
    report(writeUserTeamIndex(activeProfileId, index));
  };

  const lastTransaction = board.history.at(-1);
  const lastPlayer = lastTransaction
    ? data.players.find(
        (item) =>
          playerIdKey(item.id) === playerIdKey(lastTransaction.playerId),
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
            teams={board.teams}
            userTeamIndex={userTeamIndex}
            onChangeUserTeam={chooseUserTeam}
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
                  const nextQuery = event.target.value;
                  if (player && nextQuery !== player.nome)
                    priceTouched.current = false;
                  setDraft((current) =>
                    draftForQuery(current, data.players, nextQuery),
                  );
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

          {board.auctionStatus === "recovered" ? (
            <section className="notice notice--warn auction-recovery" role="status">
              <div>
                <strong>Asta ripristinata con verifiche</strong>
                <p>
                  {board.unresolved.length} assegnazion{board.unresolved.length === 1 ? "e richiede" : "i richiedono"} una verifica dopo l’aggiornamento del listone. Le altre sono state mantenute.
                </p>
              </div>
              <button type="button" className="btn btn--sm" onClick={restoreBackup}>
                Ripristina backup
              </button>
            </section>
          ) : null}

          {player ? (
            <VerdictCard
              player={player}
              advice={advice}
              price={price}
              rules={activeRules}
              legalMax={selectedLegalMax}
              teams={board.teams}
              owner={owner}
              userTeamIndex={userTeamIndex}
              onOwner={setOwner}
              onPrice={(value) => {
                priceTouched.current = true;
                setPrice(value);
              }}
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
                {board.teams[lastTransaction.owner]?.name} per{" "}
                {lastTransaction.price}
              </span>
            ) : (
              <span>Nessuna assegnazione registrata.</span>
            )}
            <button
              type="button"
              className="btn btn--sm"
              onClick={undo}
              disabled={!board.history.length}
            >
              Annulla
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={redo}
              disabled={!board.undone.length}
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
              {board.teams.map((team, index) => (
                <TeamCard
                  key={index}
                  team={team}
                  index={index}
                  rules={activeRules}
                  isMine={index === userTeamIndex}
                  assigned={board.assigned}
                  showSetup={showSetup}
                  canSetStartingCredits={canSetStartingCredits}
                  onRename={(name) => updateTeamName(index, name)}
                  onCredits={(value) => updateStartingCredits(index, value)}
                  onOpenPlayer={openPlayer}
                />
              ))}
            </div>
          </section>

          <button
            type="button"
            className="btn btn--danger"
            onClick={flushAuction}
          >
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
            style={{
              minHeight: 32,
              fontSize: "var(--fs-xs)",
              padding: "0 26px 0 8px",
              width: "auto",
              maxWidth: "12rem",
            }}
          >
            {teams.map((item, index) => (
              <option value={index} key={index}>
                {item.name}
              </option>
            ))}
          </select>
          <div className="myteam-credits">
            {team.credits}
            <span>
              crediti · {rosterSize}/{totalSlots}
            </span>
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
  onAssign,
  onCancel,
  onOpenPlayer,
}) {
  /* The headline answers the question actually being asked at the table — "at
     this price, yes or no?" — so it follows the live number, not the static
     recommendation. The recommendation stays underneath as the reference. */
  const { tone, headline, recommendation, purpose } = bidVerdict({
    advice,
    price,
    rules,
    legalMax,
  });

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
          {player.availability_overlay?.effective ? (
            <p className="availability-context">
              {player.availability_overlay.effective === "OUT" ? "Indisponibile" : "In dubbio"}
              {player.availability_overlay.automatic?.reason
                ? ` · ${player.availability_overlay.automatic.reason}${player.availability_overlay.automatic.expected_return ? ` · rientro ${player.availability_overlay.automatic.expected_return}` : ""}${player.availability_overlay.automatic.return_date_source ? ` (${player.availability_overlay.automatic.return_date_source})` : ""} · Fantacalcio Online`
                : " · override manuale"}
            </p>
          ) : null}
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
            ? `Utilità: ${purpose} · prezzo: ${recommendation} · confidenza ${Math.round(advice.confidence * 100)}% · ${advice.utility}`
            : "Sto valutando la rosa e il mercato."}
        </span>
      </div>

      <BidGauge advice={advice} price={price} rules={rules} legalMax={legalMax} />

      <div className="bidbar">
        <PriceStepper
          price={price}
          rules={rules}
          legalMax={legalMax}
          onPrice={onPrice}
          onSubmit={onAssign}
        />

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

      <AdviceDetail advice={advice} />
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
          <span className="stat-value">
            {overview.summary.spendableCredits}
          </span>
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
