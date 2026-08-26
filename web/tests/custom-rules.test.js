import test from "node:test";
import assert from "node:assert/strict";
import { generateRandomAuction } from "../src/random-auction-engine.js";
import { simulateMockLeague } from "../src/mock-league-engine.js";
import { evaluateAuction, evaluateOverview } from "../src/simulation.worker.js";

const rules = {
  participants: 4,
  teamNames: ["Arco", "Borgo", "Cima", "Duna"],
  rosterSlots: { P: 1, D: 4, C: 4, A: 3 },
  formations: [[4, 4, 2]],
  startingCredits: 120,
  bench: { maxSubstitutions: 2, switch: true },
  scoring: { goalkeeperConceded: -1 },
  virtualGoals: { threshold: 60, increment: 4 },
  defenseModifier: { requiredDefenders: 4, tiers: [{ threshold: 6, bonus: 2 }] },
  standings: { win: 2, draw: 1, loss: 0, tieBreakers: ["season_fantasy_score"], exactTie: "shared" },
  incompleteLineup: "error",
  auction: { minPrice: 2, increment: 2, reserve: 2, nomination: "rotation" },
  calendario_lega: [
    [["Arco", "Borgo"], ["Cima", "Duna"]],
    [["Arco", "Cima"], ["Borgo", "Duna"]],
  ],
};

const players = [];
let id = 1;
for (const [role, slots] of Object.entries(rules.rosterSlots)) {
  for (let index = 0; index < slots * rules.participants + 4; index++) {
    players.push({ id: id++, nome: `${role}-${index}`, ruolo: role, fvm_scaled: 10 + index, p_gioca_per_giornata: [1, 1], voto_puro_mean_per_giornata: [6.5, 6.5], voto_puro_std_per_giornata: [0, 0], bonus_atteso_per_giornata: [0, 0], gol_subiti_per_giornata: [0, 0] });
  }
}

test("custom auction derives team, slots, credits, reserve and increment from rules", () => {
  const events = generateRandomAuction(players, { rules, seed: "custom" });
  assert.equal(events.length, 48);
  assert.ok(events.every((event) => event.price >= 2 && (event.price - 2) % 2 === 0));
  for (let owner = 0; owner < rules.participants; owner++) {
    const roster = events.filter((event) => event.owner === owner).map((event) => players.find((player) => player.id === event.playerId));
    assert.equal(roster.length, 12);
    for (const [role, slots] of Object.entries(rules.rosterSlots)) assert.equal(roster.filter((player) => player.ruolo === role).length, slots);
  }
});

test("mock league uses supplied calendar and configured standings profile", () => {
  const events = generateRandomAuction(players, { rules, seed: "calendar" });
  const standings = simulateMockLeague({ players, events, rules, seed: 4 });
  assert.equal(standings.length, 4);
  assert.ok(standings.every((row) => row.wins + row.draws + row.losses === 2));
  assert.ok(standings.every((row) => row.points === row.wins * 2 + row.draws));
});

test("mock league uses canonical calendar matchdays and Serie A indexes", () => {
  const events = generateRandomAuction(players, { rules, seed: "canonical-calendar" });
  const canonicalCalendar = {
    matchdays: [
      { number: 1, serie_a_matchday: 2, fixtures: [{ home: "Arco", away: "Borgo" }, { home: "Cima", away: "Duna" }] },
      { number: 2, serie_a_matchday: 1, fixtures: [{ home: "Arco", away: "Cima" }, { home: "Borgo", away: "Duna" }] },
    ],
  };
  const standings = simulateMockLeague({ players, events, rules: { ...rules, calendario_lega: canonicalCalendar }, seed: 4 });
  assert.ok(standings.every((row) => row.wins + row.draws + row.losses === 2));
});

test("worker plans custom roles and preserves the configured two-credit reserve", () => {
  const roster = players.filter((player) => player.ruolo === "P").slice(0, 1);
  const teams = [{ name: "Arco", credits: 30, roster }];
  const candidate = players.find((player) => player.ruolo === "D");
  const data = { rules, teams, mine: teams[0], owner: 0, player: candidate, remaining: players, assigned: {} };
  assert.equal(evaluateAuction(data).legalMax, 10);
  assert.deepEqual(Object.keys(evaluateOverview(data).rolePlan).sort(), ["A", "C", "D", "P"]);
});
