export const LEGACY_RULES = Object.freeze({
  participants: 8,
  rosterSlots: { P: 3, D: 8, C: 8, A: 6 },
  formations: [[3, 4, 3], [3, 5, 2], [4, 3, 3], [4, 4, 2], [4, 5, 1], [5, 3, 2], [5, 4, 1]],
  startingCredits: 500,
  bench: { roles: ["P", "P", "D", "D", "D", "C", "C", "C", "A", "A", "A"], maxSubstitutions: 3, mode: "Basic" },
  scoring: { goalkeeperConceded: 0 },
  virtualGoals: { threshold: 66, increment: 5 },
  defenseModifier: { enabled: false, requiredDefenders: 4, tiers: [] },
  standings: { win: 3, draw: 1, loss: 0, tieBreakers: ["goal_difference", "head_to_head", "season_fantasy_score"], exactTie: "index" },
  incompleteLineup: "error",
  auction: {
    minPrice: 1,
    increment: 1,
    reserve: 1,
    nomination: "call",
    roleBudgetPercentages: { P: 7, D: 18, C: 25, A: 50 },
    roleBudgetFlexibilityPercent: 5,
  },
});

const integer = (value, fallback, minimum = 0) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum ? number : fallback;
};

const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const nominationPolicy = (value) => {
  const normalized = { round_robin: "call", rotation: "call" }[value] ?? value;
  return ["call", "call_by_role", "random", "random_by_role", "alphabetical", "alphabetical_by_role"].includes(normalized)
    ? normalized
    : LEGACY_RULES.auction.nomination;
};
const formations = (value) => Array.isArray(value) ? value.map((formation) => {
  if (Array.isArray(formation)) return formation;
  const parts = String(formation).split("-").map(Number);
  return parts.length === 3 && parts.every(Number.isInteger) ? parts : formation;
}) : LEGACY_RULES.formations;

/** Normalize the public league profile while accepting the Italian API field names. */
export const normalizeRules = (input = {}) => {
  const source = object(input);
  const rosterSource = object(source.rosterSlots || source.roster_slots || source.slots || source.ruoli);
  const rosterSlots = Object.fromEntries(
    Object.entries(rosterSource).filter(([, slots]) => Number.isInteger(Number(slots)) && Number(slots) >= 0),
  );
  const slots = Object.keys(rosterSlots).length ? rosterSlots : { ...LEGACY_RULES.rosterSlots };
  const teamNames = Array.isArray(source.teamNames || source.team_names || source.squadre)
    ? (source.teamNames || source.team_names || source.squadre).map((team) => String(team))
    : undefined;
  const participants = integer(source.participants ?? source.numero_partecipanti ?? source.teamCount, teamNames?.length || LEGACY_RULES.participants, 2);
  const auction = object(source.auction || source.asta);
  const requestedRoleBudgets = object(
    auction.roleBudgetPercentages || auction.role_budget_percentages,
  );
  const roleBudgetPercentages = Object.fromEntries(
    Object.keys(slots).map((role) => [role, Number(requestedRoleBudgets[role])]),
  );
  const validRoleBudgets =
    Object.values(roleBudgetPercentages).every(
      (value) => Number.isFinite(value) && value >= 0,
    ) &&
    Math.abs(
      Object.values(roleBudgetPercentages).reduce((sum, value) => sum + value, 0) -
        100,
    ) < 1e-9;
  const requestedFlexibility = Number(
    auction.roleBudgetFlexibilityPercent ??
      auction.role_budget_flexibility_percent,
  );
  const bench = object(source.bench || source.panchina);
  const scoring = object(source.scoring || source.punteggio);
  const virtualGoals = object(source.virtualGoals || source.virtual_goals || source.gol_virtuali);
  const defense = object(source.defenseModifier || source.defense_modifier || source.modificatore_difesa);
  const standings = object(source.standings || source.classifica);
  const horizons = object(source.horizons || source.orizzonti);
  const validTieBreakers = new Set(["goal_difference", "head_to_head", "season_fantasy_score"]);
  const requestedTieBreakers = Array.isArray(standings.tieBreakers || standings.tie_breakers) ? standings.tieBreakers || standings.tie_breakers : LEGACY_RULES.standings.tieBreakers;
  const tieBreakers = [...new Set(requestedTieBreakers.filter((rule) => validTieBreakers.has(rule)))];
  return {
    participants,
    teamNames,
    userTeam: source.userTeam ?? source.user_team,
    rosterSlots: slots,
    formations: formations(source.formations || source.formazioni),
    startingCredits: source.startingCredits ?? source.starting_credits ?? source.crediti_iniziali ?? LEGACY_RULES.startingCredits,
    bench: {
      roles: Array.isArray(bench.roles ?? bench.bench_roles)
        ? (bench.roles ?? bench.bench_roles).filter((role) => Object.hasOwn(slots, role))
        : [...LEGACY_RULES.bench.roles],
      maxSubstitutions: integer(bench.maxSubstitutions ?? bench.max_substitutions ?? bench.max_subs ?? source.maxSubstitutions, LEGACY_RULES.bench.maxSubstitutions),
      mode: ["Basic", "Strict", "None"].includes(bench.mode) ? bench.mode : LEGACY_RULES.bench.mode,
    },
    scoring: { ...LEGACY_RULES.scoring, ...scoring, goalkeeperConceded: Number(scoring.goalkeeperConceded ?? scoring.goalkeeper_conceded ?? scoring.portiere_gol_subiti ?? LEGACY_RULES.scoring.goalkeeperConceded) },
    virtualGoals: { threshold: Number(virtualGoals.threshold ?? virtualGoals.soglia ?? LEGACY_RULES.virtualGoals.threshold), increment: Number(virtualGoals.increment ?? virtualGoals.scatto ?? LEGACY_RULES.virtualGoals.increment) },
    defenseModifier: { enabled: defense.enabled === true, tableName: defense.tableName ?? defense.table_name, requiredDefenders: integer(defense.requiredDefenders ?? defense.difensori_richiesti, LEGACY_RULES.defenseModifier.requiredDefenders, 1), tiers: Array.isArray(defense.tiers || defense.fasce) ? defense.tiers || defense.fasce : [] },
    standings: { win: Number(standings.win ?? standings.vittoria ?? 3), draw: Number(standings.draw ?? standings.pareggio ?? 1), loss: Number(standings.loss ?? standings.sconfitta ?? 0), tieBreakers: tieBreakers.length ? tieBreakers : LEGACY_RULES.standings.tieBreakers, exactTie: standings.exactTie ?? standings.exact_tie ?? LEGACY_RULES.standings.exactTie },
    incompleteLineup: object(source.incompleteLineup ?? source.incomplete_lineup ?? source.formazione_incompleta).policy ?? source.incompleteLineup ?? source.incomplete_lineup ?? source.formazione_incompleta ?? LEGACY_RULES.incompleteLineup,
    incompleteLineupScore: Number(object(source.incompleteLineup ?? source.incomplete_lineup ?? source.formazione_incompleta).score ?? 0),
    auction: {
      minPrice: integer(auction.minPrice ?? auction.prezzo_minimo, LEGACY_RULES.auction.minPrice, 1),
      increment: integer(auction.increment ?? auction.rilancio, LEGACY_RULES.auction.increment, 1),
      reserve: integer(auction.reserve ?? auction.riserva, LEGACY_RULES.auction.reserve, 0),
      nomination: nominationPolicy(auction.nomination ?? auction.nominazione),
      roleBudgetPercentages: validRoleBudgets
        ? roleBudgetPercentages
        : { ...LEGACY_RULES.auction.roleBudgetPercentages },
      roleBudgetFlexibilityPercent:
        Number.isFinite(requestedFlexibility) &&
        requestedFlexibility >= 0 &&
        requestedFlexibility <= 100
          ? requestedFlexibility
          : LEGACY_RULES.auction.roleBudgetFlexibilityPercent,
    },
    calendar: source.calendario_lega ?? source.calendar,
    horizons: {
      historical: { matchdays: integer(object(horizons.historical).matchdays, 38, 1), label: object(horizons.historical).label || `storico ${integer(object(horizons.historical).matchdays, 38, 1)}` },
      currentLeague: { matchdayIndices: Array.isArray(object(horizons.currentLeague).matchdayIndices) ? object(horizons.currentLeague).matchdayIndices.filter((day) => Number.isInteger(day) && day >= 0) : [], label: object(horizons.currentLeague).label || "lega corrente" },
    },
  };
};
