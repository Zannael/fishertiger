import test from "node:test";
import assert from "node:assert/strict";
import {
  FORCE_AVAILABLE,
  FORCE_OUT,
  isPlayerInjured,
  loadPlayerInjuries,
  normalizePlayerInjuries,
  playerInjuriesStorageKey,
  withPlayerInjury,
} from "../src/player-injuries.js";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

test("injuries are stored per profile", () => {
  assert.equal(playerInjuriesStorageKey("Fantabosco"), "fanta-player-injuries-v2:Fantabosco");
  assert.equal(playerInjuriesStorageKey("a b/c"), "fanta-player-injuries-v2:a%20b%2Fc");
});

test("a player can be marked injured and available again", () => {
  const injured = withPlayerInjury({}, 42, true);
  assert.equal(isPlayerInjured(injured, "42"), true);
  assert.deepEqual(injured, { 42: FORCE_OUT });
  assert.deepEqual(withPlayerInjury(injured, 42, FORCE_AVAILABLE), { 42: FORCE_AVAILABLE });
  assert.deepEqual(withPlayerInjury(injured, 42, false), {});
});

test("stored injury data accepts only numeric IDs with explicit override status", () => {
  assert.deepEqual(
    normalizePlayerInjuries({ 1: FORCE_OUT, 2: FORCE_AVAILABLE, player: FORCE_OUT, 3: "yes" }),
    { 1: FORCE_OUT, 2: FORCE_AVAILABLE },
  );
  assert.deepEqual(normalizePlayerInjuries([1, 2]), {});
  assert.deepEqual(normalizePlayerInjuries(null), {});
});

test("invalid player IDs cannot be added", () => {
  assert.deepEqual(withPlayerInjury({ 1: FORCE_OUT }, "not-an-id", true), { 1: FORCE_OUT });
});

test("v1 true reminders migrate to explicit force-out overrides", () => {
  store.clear();
  store.set(playerInjuriesStorageKey("legacy", 1), JSON.stringify({ 7: true, 8: false }));
  assert.deepEqual(loadPlayerInjuries("legacy"), { 7: FORCE_OUT });
  assert.equal(store.has(playerInjuriesStorageKey("legacy", 1)), false);
  assert.deepEqual(JSON.parse(store.get(playerInjuriesStorageKey("legacy"))), { 7: FORCE_OUT });
});
