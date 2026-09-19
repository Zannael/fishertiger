import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const { clearProfileBrowserData } = await import("../src/profile-storage.js");
const { auctionStorageKey } = await import("../src/auction-state.js");
const { userTeamStorageKey } = await import("../src/auction-store.js");
const { playerNotesStorageKey } = await import("../src/player-notes.js");
const { playerFiltersStorageKey } = await import("../src/player-filters.js");
const { playerInjuriesStorageKey } = await import("../src/player-injuries.js");

const KEEP = "profilo-da-tenere";
const DROP = "profilo-da-eliminare";

const seed = (profileId) => {
  store.set(auctionStorageKey(profileId), "{}");
  store.set(userTeamStorageKey(profileId), "1");
  store.set(playerNotesStorageKey(profileId), "{}");
  store.set(playerFiltersStorageKey(profileId), "{}");
  store.set(playerInjuriesStorageKey(profileId), "{}");
  store.set(playerInjuriesStorageKey(profileId, 1), "{}");
};

test("deleting a profile drops every browser key scoped to it", () => {
  store.clear();
  seed(DROP);
  clearProfileBrowserData(DROP);
  assert.deepEqual([...store.keys()], []);
});

test("deleting a profile leaves the other profiles untouched", () => {
  store.clear();
  seed(KEEP);
  seed(DROP);
  store.set("fanta-player-media", "on");
  clearProfileBrowserData(DROP);
  assert.deepEqual(
    [...store.keys()].sort(),
    [
      auctionStorageKey(KEEP),
      playerFiltersStorageKey(KEEP),
      playerInjuriesStorageKey(KEEP),
      playerInjuriesStorageKey(KEEP, 1),
      playerNotesStorageKey(KEEP),
      userTeamStorageKey(KEEP),
      "fanta-player-media",
    ].sort(),
  );
});

test("clearing an unknown profile changes nothing", () => {
  store.clear();
  seed(KEEP);
  clearProfileBrowserData("mai-esistito");
  assert.equal(store.size, 6);
});

test("a missing profile id never falls back to wiping the default profile", () => {
  store.clear();
  seed("default");
  clearProfileBrowserData("");
  clearProfileBrowserData(null);
  clearProfileBrowserData(undefined);
  assert.equal(store.size, 6);
});
