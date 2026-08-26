import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseLineup,
  rankMockStandings,
  scoreTeam,
  simulateMockLeague,
} from "../src/mock-league-engine.js";
import { defenseModifierBonus, expectedDefenseModifier } from "../src/defense-modifier.js";

const ROLES = { P: 3, D: 8, C: 8, A: 6 };
const teamNames = Array.from({ length: 8 }, (_, index) => `Team ${index + 1}`);
const players = [];
const events = [];
let id = 1;

for (let owner = 0; owner < teamNames.length; owner++) {
  for (const [role, count] of Object.entries(ROLES)) {
    for (let slot = 0; slot < count; slot++) {
      const player = {
        id: id++,
        nome: `${role} ${owner}-${slot}`,
        ruolo: role,
        p_gioca_per_giornata: Array(36).fill(0.72 + (slot % 3) * 0.08),
        voto_puro_mean_per_giornata: Array(36).fill(
          5.8 + owner * 0.04 + slot * 0.03,
        ),
        voto_puro_std_per_giornata: Array(36).fill(0.45),
        bonus_atteso_per_giornata: Array(36).fill(role === "A" ? 0.8 : 0.15),
      };
      players.push(player);
      events.push({
        callNumber: events.length + 1,
        nominator: owner,
        playerId: player.id,
        owner,
        price: 1,
      });
    }
  }
}

const simulate = (seed = 202627) =>
  simulateMockLeague({ players, events, teamNames, seed });

test("same seed produces the same final standings", () => {
  assert.deepEqual(simulate(), simulate());
});

test("returns eight ranked standings rows sorted by league tie-breakers", () => {
  const standings = simulate();
  assert.equal(standings.length, 8);
  assert.deepEqual(
    standings.map((row) => row.rank),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  for (let index = 1; index < standings.length; index++) {
    const previous = standings[index - 1];
    const current = standings[index];
    assert.ok(
      previous.points > current.points ||
        (previous.points === current.points &&
          previous.goalsFor - previous.goalsAgainst >=
            current.goalsFor - current.goalsAgainst),
    );
  }
});

test("every team plays 36 matches and points agree with its record", () => {
  const standings = simulate();
  for (const row of standings) {
    assert.equal(row.wins + row.draws + row.losses, 36);
    assert.equal(row.points, row.wins * 3 + row.draws);
  }
  assert.equal(
    standings.reduce((sum, row) => sum + row.goalsFor, 0),
    standings.reduce((sum, row) => sum + row.goalsAgainst, 0),
  );
});

test("points remain primary and configured tie-breaker priority resolves only points ties", () => {
  const table = [
    { team: "Alpha", points: 10, goalsFor: 8, goalsAgainst: 7, fantasyPoints: 100 },
    { team: "Beta", points: 10, goalsFor: 7, goalsAgainst: 7, fantasyPoints: 90 },
    { team: "Lower", points: 9, goalsFor: 99, goalsAgainst: 0, fantasyPoints: 999 },
  ];
  const directPoints = [[0, 0, 3], [3, 0, 0], [0, 0, 0]];
  const baseRules = { standings: { exactTie: "shared" } };

  assert.deepEqual(rankMockStandings(table, directPoints, { ...baseRules, standings: { ...baseRules.standings, tieBreakers: ["goal_difference", "head_to_head"] } }).map((row) => row.team), ["Alpha", "Beta", "Lower"]);
  assert.deepEqual(rankMockStandings(table, directPoints, { ...baseRules, standings: { ...baseRules.standings, tieBreakers: ["head_to_head", "goal_difference"] } }).map((row) => row.team), ["Beta", "Alpha", "Lower"]);
});

test("uses two reserve goalkeepers and three reserves for every outfield role", () => {
  let playerId = 1;
  const roster = Object.entries({ P: 4, D: 9, C: 9, A: 7 }).flatMap(
    ([ruolo, count]) =>
      Array.from({ length: count }, (_, index) => ({
        id: playerId++,
        ruolo,
        p_gioca_per_giornata: [1],
        voto_puro_mean_per_giornata: [10 - index / 10],
        bonus_atteso_per_giornata: [0],
        voto_puro_std_per_giornata: [0],
      })),
  );

  const selection = chooseLineup(roster, 0, {
    rosterSlots: ROLES,
    formations: [[3, 4, 3]],
    incompleteLineup: "error",
  });

  assert.deepEqual(
    Object.fromEntries(
      Object.keys(ROLES).map((role) => [
        role,
        selection.bench.filter((item) => item.player.ruolo === role).length,
      ]),
    ),
    { P: 2, D: 3, C: 3, A: 3 },
  );
});

test("respects the configured global substitution limit", () => {
  let playerId = 1;
  const item = (ruolo, probability) => ({
    player: { id: playerId++, ruolo },
    values: { probability, vote: 6, bonus: 0, deviation: 0, conceded: 0 },
  });
  const selection = {
    starters: [item("P", 0), ...Array.from({ length: 4 }, () => item("D", 0)), ...Array.from({ length: 4 }, () => item("C", 0)), ...Array.from({ length: 4 }, () => item("A", 0))],
    bench: [item("P", 1), item("P", 1), ...Array.from({ length: 3 }, () => item("D", 1)), ...Array.from({ length: 3 }, () => item("C", 1)), ...Array.from({ length: 3 }, () => item("A", 1))],
  };

  const result = scoreTeam(selection, () => 0.5, {
    bench: { roles: ["P", "P", "D", "D", "D", "C", "C", "C", "A", "A", "A"], maxSubstitutions: 3, mode: "Basic" },
    scoring: { goalkeeperConceded: 0 },
    defenseModifier: { requiredDefenders: 4, tiers: [] },
  });

  assert.deepEqual(
    Object.fromEntries(
      Object.keys(ROLES).map((role) => [
        role,
        result.scored.filter((player) => player.player.ruolo === role).length,
      ]),
    ),
    { P: 1, D: 2, C: 0, A: 0 },
  );
});

test("applies the defense modifier only when enabled", () => {
  let playerId = 1;
  const item = (ruolo) => ({
    player: { id: playerId++, ruolo },
    values: { probability: 1, vote: 6.5, bonus: 0, deviation: 0, conceded: 0 },
  });
  const selection = {
    starters: [item("P"), ...Array.from({ length: 4 }, () => item("D")), ...Array.from({ length: 3 }, () => item("C")), ...Array.from({ length: 3 }, () => item("A"))],
    bench: [],
  };
  const baseRules = {
    bench: { roles: [], maxSubstitutions: 0, mode: "None" },
    scoring: { goalkeeperConceded: 0 },
    defenseModifier: {
      requiredDefenders: 4,
      tiers: [{ threshold: 6, bonus: 2 }],
    },
  };

  const withoutModifier = scoreTeam(selection, () => 0.5, {
    ...baseRules,
    defenseModifier: { ...baseRules.defenseModifier, enabled: false },
  });
  const withModifier = scoreTeam(selection, () => 0.5, {
    ...baseRules,
    defenseModifier: { ...baseRules.defenseModifier, enabled: true },
  });

  assert.equal(withModifier.score - withoutModifier.score, 2);
});

test("defense modifier matches canonical pure-vote semantics", () => {
  const base = { enabled: true, requiredDefenders: 4, tiers: [{ threshold: 6, bonus: 1 }, { threshold: 6.5, bonus: 2 }, { threshold: 7, bonus: 3 }] };
  assert.equal(defenseModifierBonus({ ...base, goalkeeperVote: undefined, defenderVotes: [7, 7, 7, 7] }), 0);
  assert.equal(defenseModifierBonus({ ...base, goalkeeperVote: 7, defenderVotes: [7, 7, 7] }), 0);
  assert.equal(defenseModifierBonus({ ...base, goalkeeperVote: 4, defenderVotes: [5, 6, 6, 6, 10] }), 2);
  assert.equal(defenseModifierBonus({ ...base, goalkeeperVote: 7, defenderVotes: [7, 7, 7, 7] }), 3);
});

test("does not award a modifier to an incomplete lineup", () => {
  const item = (id, ruolo) => ({ player: { id, ruolo }, values: { probability: 1, vote: 7, bonus: 0, deviation: 0, conceded: 0 } });
  const selection = { starters: [item(1, "P"), ...Array.from({ length: 4 }, (_, index) => item(index + 2, "D")), ...Array.from({ length: 5 }, (_, index) => item(index + 6, "C"))], bench: [] };
  const result = scoreTeam(selection, () => 0.5, { bench: { mode: "None", maxSubstitutions: 0 }, scoring: {}, incompleteLineup: "allow_partial", defenseModifier: { enabled: true, requiredDefenders: 4, tiers: [{ threshold: 6, bonus: 3 }] } });
  assert.equal(result.score, 70);
});

test("incomplete lineup policies produce their configured outcomes", () => {
  const item = (id, ruolo) => ({ player: { id, ruolo }, values: { probability: 1, vote: 7, bonus: 0, deviation: 0, conceded: 0 } });
  const selection = { starters: [item(1, "P"), ...Array.from({ length: 3 }, (_, index) => item(index + 2, "D")), ...Array.from({ length: 3 }, (_, index) => item(index + 5, "C")), ...Array.from({ length: 3 }, (_, index) => item(index + 8, "A"))], bench: [] };
  const baseRules = { bench: { mode: "None", maxSubstitutions: 0 }, scoring: {}, defenseModifier: { enabled: true, requiredDefenders: 4, tiers: [{ threshold: 6, bonus: 3 }] } };

  assert.equal(scoreTeam(selection, () => 0.5, { ...baseRules, incompleteLineup: "zero_score", incompleteLineupScore: 0 }).score, 0);
  assert.equal(scoreTeam(selection, () => 0.5, { ...baseRules, incompleteLineup: "forfeit", incompleteLineupScore: 9 }).score, 9);
  assert.equal(scoreTeam(selection, () => 0.5, { ...baseRules, incompleteLineup: "allow_partial" }).score, 70);
});

test("lineup selection can prefer four defenders for the expected modifier", () => {
  const roster = [
    { id: 1, ruolo: "P" },
    ...Array.from({ length: 4 }, (_, index) => ({ id: index + 2, ruolo: "D" })),
    ...Array.from({ length: 4 }, (_, index) => ({ id: index + 6, ruolo: "C" })),
    ...Array.from({ length: 4 }, (_, index) => ({ id: index + 10, ruolo: "A" })),
  ].map((player) => ({ ...player, p_gioca_per_giornata: [1], voto_puro_mean_per_giornata: [player.ruolo === "P" || player.ruolo === "D" ? 7 : 6], bonus_atteso_per_giornata: [player.ruolo === "C" ? 0.4 : 0], voto_puro_std_per_giornata: [0] }));
  const rules = { rosterSlots: ROLES, formations: [[3, 4, 3], [4, 3, 3]], incompleteLineup: "error", defenseModifier: { enabled: true, requiredDefenders: 4, tiers: [{ threshold: 6, bonus: 1 }] } };

  assert.equal(chooseLineup(roster, 0, rules).starters.filter((item) => item.player.ruolo === "D").length, 4);
  assert.equal(expectedDefenseModifier({ ...rules.defenseModifier, goalkeeper: { probability: 1, vote: 7 }, defenders: Array.from({ length: 4 }, () => ({ probability: 1, vote: 7 })) }), 1);
});
