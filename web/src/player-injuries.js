export const PLAYER_INJURIES_VERSION = 2;
export const FORCE_OUT = "FORCE_OUT";
export const FORCE_AVAILABLE = "FORCE_AVAILABLE";

export const playerInjuriesStorageKey = (profileId, version = PLAYER_INJURIES_VERSION) =>
  `fanta-player-injuries-v${version}:${encodeURIComponent(profileId || "default")}`;

export const playerInjuriesStorageKeys = (profileId) => [
  playerInjuriesStorageKey(profileId),
  playerInjuriesStorageKey(profileId, 1),
];

export const normalizePlayerInjuries = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([id, value]) => /^\d+$/.test(id) && [FORCE_OUT, FORCE_AVAILABLE].includes(value),
    ),
  );
};

export const isPlayerInjured = (injuries, playerId) =>
  injuries?.[String(playerId)] === FORCE_OUT;

export const withPlayerInjury = (injuries, playerId, injured) => {
  const key = String(playerId);
  if (!/^\d+$/.test(key)) return normalizePlayerInjuries(injuries);
  const next = { ...normalizePlayerInjuries(injuries) };
  if (injured === true || injured === FORCE_OUT) next[key] = FORCE_OUT;
  else if (injured === FORCE_AVAILABLE) next[key] = FORCE_AVAILABLE;
  else delete next[key];
  return next;
};

export const loadPlayerInjuries = (profileId) => {
  try {
    const current = localStorage.getItem(playerInjuriesStorageKey(profileId));
    if (current !== null) return normalizePlayerInjuries(JSON.parse(current));
    const legacyKey = playerInjuriesStorageKey(profileId, 1);
    const legacy = JSON.parse(localStorage.getItem(legacyKey) || "null");
    const migrated = Object.fromEntries(
      Object.entries(legacy && typeof legacy === "object" && !Array.isArray(legacy) ? legacy : {})
        .filter(([id, injured]) => /^\d+$/.test(id) && injured === true)
        .map(([id]) => [id, FORCE_OUT]),
    );
    if (Object.keys(migrated).length && savePlayerInjuries(profileId, migrated))
      localStorage.removeItem(legacyKey);
    return migrated;
  } catch {
    return {};
  }
};

export const savePlayerInjuries = (profileId, injuries) => {
  try {
    localStorage.setItem(
      playerInjuriesStorageKey(profileId),
      JSON.stringify(normalizePlayerInjuries(injuries)),
    );
    return true;
  } catch {
    return false;
  }
};
