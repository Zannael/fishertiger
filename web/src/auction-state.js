export const AUCTION_STORAGE_VERSION = 2;

const integer = (value, minimum = 0) =>
  Number.isInteger(Number(value)) && Number(value) >= minimum
    ? Number(value)
    : null;

export const playerIdKey = (id) => String(id);

export const emptyDraft = () => ({ playerId: null, query: "", price: "" });

export const draftPlayer = (draft, players) => {
  const id = draft?.playerId;
  if (id === null || id === undefined) return null;
  return (
    (players || []).find(
      (candidate) => playerIdKey(candidate.id) === playerIdKey(id),
    ) || null
  );
};

export const auctionStorageKey = (profileId) =>
  `fanta-auction-v${AUCTION_STORAGE_VERSION}:${encodeURIComponent(profileId || "default")}`;

const teamNames = (rules) =>
  Array.from({ length: rules.participants }, (_, index) =>
    String(
      rules.teamNames?.[index] ||
      (index === 0 ? "La mia squadra" : `Squadra ${index + 1}`),
    ),
  );

export const emptyAuction = (rules) => ({
  teams: teamNames(rules).map((name) => ({
    name,
    startingCredits: rules.startingCredits,
    credits: rules.startingCredits,
    roster: [],
  })),
  assigned: {},
  history: [],
  undone: [],
});

export const slotsLeft = (team, rules) =>
  Object.fromEntries(
    Object.entries(rules.rosterSlots).map(([role, count]) => [
      role,
      count - (team.roster || []).filter((player) => player.ruolo === role).length,
    ]),
  );

export const legalMaxBid = (team, rules) => {
  const openSlots = Object.values(slotsLeft(team, rules)).reduce(
    (sum, count) => sum + Math.max(0, count),
    0,
  );
  return Math.max(0, team.credits - Math.max(0, openSlots - 1) * rules.auction.reserve);
};

export const isValidBid = (price, team, rules) => {
  const value = integer(price, rules.auction.minPrice);
  return (
    value != null &&
    (value - rules.auction.minPrice) % rules.auction.increment === 0 &&
    value <= legalMaxBid(team, rules)
  );
};

const transactionFrom = (item) => {
  const playerId = item?.playerId ?? item?.player?.id;
  const owner = integer(item?.owner);
  const price = integer(item?.price, 1);
  return playerId == null || owner == null || price == null
    ? null
    : { playerId, owner, price };
};

const hydrate = (seed, transactions, playersById, rules) => {
  const state = {
    ...seed,
    teams: seed.teams.map((team) => ({ ...team, roster: [] })),
    assigned: {},
    history: [],
    undone: [],
  };
  for (const transaction of transactions) {
    const player = playersById.get(playerIdKey(transaction.playerId));
    const team = state.teams[transaction.owner];
    if (
      !player ||
      !team ||
      state.assigned[playerIdKey(transaction.playerId)] ||
      !Object.hasOwn(rules.rosterSlots, player.ruolo) ||
      slotsLeft(team, rules)[player.ruolo] < 1 ||
      !isValidBid(transaction.price, team, rules)
    ) {
      return null;
    }
    const record = { playerId: player.id, owner: transaction.owner, price: transaction.price };
    team.credits -= transaction.price;
    team.roster.push(player);
    state.assigned[playerIdKey(player.id)] = { owner: transaction.owner, price: transaction.price };
    state.history.push(record);
  }
  return state;
};

/** Rebuilds runtime player references from compact, versioned transactions. */
export const rehydrateAuction = (saved, players, rules) => {
  if (!saved || typeof saved !== "object") return null;
  const isCurrent = saved.version === AUCTION_STORAGE_VERSION;
  const rawTeams = Array.isArray(saved.teams) ? saved.teams : null;
  const rawHistory = Array.isArray(saved.history) ? saved.history : null;
  const rawUndone = Array.isArray(saved.undone) ? saved.undone : [];
  if (!rawTeams || rawTeams.length !== rules.participants || !rawHistory) return null;
  const playersById = new Map((players || []).map((player) => [playerIdKey(player.id), player]));
  const transactions = rawHistory.map(transactionFrom);
  const undone = rawUndone.map(transactionFrom);
  if (transactions.some((item) => !item) || undone.some((item) => !item)) return null;
  const spent = rawTeams.map((_, index) =>
    transactions.reduce((sum, item) => sum + (item.owner === index ? item.price : 0), 0),
  );
  const teams = rawTeams.map((team, index) => {
    const credits = integer(isCurrent ? team?.startingCredits : Number(team?.credits) + spent[index], 0);
    return typeof team?.name === "string" && credits != null
      ? { name: team.name, startingCredits: credits, credits, roster: [] }
      : null;
  });
  if (teams.some((team) => !team)) return null;
  const state = hydrate({ teams, assigned: {}, history: [], undone: [] }, transactions, playersById, rules);
  if (!state) return null;
  const redoState = {
    ...state,
    teams: state.teams.map((team) => ({ ...team, roster: team.roster.slice() })),
    assigned: { ...state.assigned },
  };
  // Redo restores the newest undone transaction first, so validate that sequence.
  for (const item of undone.slice().reverse()) {
    const player = playersById.get(playerIdKey(item.playerId));
    const team = redoState.teams[item.owner];
    if (
      !player ||
      !team ||
      redoState.assigned[playerIdKey(item.playerId)] ||
      !Object.hasOwn(rules.rosterSlots, player.ruolo) ||
      slotsLeft(team, rules)[player.ruolo] < 1 ||
      !isValidBid(item.price, team, rules)
    ) return null;
    team.credits -= item.price;
    team.roster.push(player);
    redoState.assigned[playerIdKey(player.id)] = { owner: item.owner, price: item.price };
  }
  state.undone = undone.map((item) => ({ ...item, playerId: playersById.get(playerIdKey(item.playerId)).id }));
  return state;
};

export const serializeAuction = (state) => ({
  version: AUCTION_STORAGE_VERSION,
  teams: state.teams.map(({ name, startingCredits }) => ({ name, startingCredits })),
  history: state.history.map(({ playerId, owner, price }) => ({ playerId, owner, price })),
  undone: (state.undone || []).map(({ playerId, owner, price }) => ({ playerId, owner, price })),
});
