import test from "node:test";
import assert from "node:assert/strict";
import { draftPlayer, emptyAuction, emptyDraft, legalMaxBid, rehydrateAuction, serializeAuction } from "../src/auction-state.js";

const rules = { participants: 2, teamNames: ["Mine", "Other"], startingCredits: 20, rosterSlots: { P: 1, A: 1 }, auction: { minPrice: 2, increment: 2, reserve: 2 } };
const players = [{ id: 1, ruolo: "P" }, { id: 2, ruolo: "A" }];

test("rehydrates compact transactions and preserves player references", () => {
  const saved = { version: 2, teams: [{ name: "Mine", startingCredits: 20 }, { name: "Other", startingCredits: 20 }], history: [{ playerId: 1, owner: 0, price: 4 }], undone: [] };
  const state = rehydrateAuction(saved, players, rules);
  assert.equal(state.teams[0].roster[0], players[0]);
  assert.deepEqual(serializeAuction(state).history, saved.history);
});

test("rejects corrupt or incompatible auction state", () => {
  assert.equal(rehydrateAuction({ teams: [], history: [] }, players, rules), null);
  assert.equal(rehydrateAuction({ version: 2, teams: [{ name: "Mine", startingCredits: 20 }, { name: "Other", startingCredits: 20 }], history: [{ playerId: 99, owner: 0, price: 4 }] }, players, rules), null);
});

test("reserves credits for remaining configured slots", () => {
  assert.equal(legalMaxBid(emptyAuction(rules).teams[0], rules), 18);
});

test("an empty nomination draft selects nobody", () => {
  const draft = emptyDraft();
  assert.deepEqual(draft, { playerId: null, query: "", price: "" });
  assert.equal(draftPlayer(draft, players), null);
});

test("a nomination draft resolves its player by id across dataset reloads", () => {
  const draft = { ...emptyDraft(), playerId: 2, query: "Tal", price: "12" };
  assert.equal(draftPlayer(draft, players), players[1]);
  // A regenerated dataset hands back equal-but-distinct player objects.
  assert.deepEqual(draftPlayer(draft, [{ id: 1, ruolo: "P" }, { id: 2, ruolo: "A" }]), players[1]);
  // Ids arriving as strings must still match.
  assert.equal(draftPlayer({ ...draft, playerId: "2" }, players), players[1]);
});

test("a nomination draft for a player the dataset no longer has selects nobody", () => {
  assert.equal(draftPlayer({ ...emptyDraft(), playerId: 99 }, players), null);
  assert.equal(draftPlayer({ ...emptyDraft(), playerId: 1 }, []), null);
  assert.equal(draftPlayer(null, players), null);
});
