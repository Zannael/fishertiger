import { normalizeRules } from "./league-rules.js";
import { defenseModifierBonus, expectedDefenseModifier } from "./defense-modifier.js";

const idKey = (id) => `${typeof id}:${String(id)}`;
const finiteAt = (values, day, label, fallback = 0) => {
  const value = Number(values?.[day]);
  if (!Number.isFinite(value)) {
    if (fallback !== undefined) return fallback;
    throw new TypeError(`Missing ${label} for matchday ${day + 1}`);
  }
  return value;
};
const seedNumber = (seed) => {
  let hash = typeof seed === "number" && Number.isFinite(seed) ? seed >>> 0 : 2166136261;
  for (const char of typeof seed === "number" ? "" : String(seed ?? 1)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
};
const randomFor = (seed) => { let state = seedNumber(seed); return () => { state = (state + 0x6d2b79f5) | 0; let value = Math.imul(state ^ (state >>> 15), 1 | state); value ^= value + Math.imul(value ^ (value >>> 7), 61 | value); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; }; };
const normal = (random) => Math.sqrt(-2 * Math.log(Math.max(random(), Number.EPSILON))) * Math.cos(2 * Math.PI * random());
const countsFor = (formation) => Array.isArray(formation) ? { P: 1, D: formation[0], C: formation[1], A: formation[2] } : formation;

const playerValues = (player, day) => ({
  probability: finiteAt(player.p_gioca_per_giornata, day, "p_gioca", 1),
  vote: finiteAt(player.voto_puro_mean_per_giornata, day, "voto", undefined),
  bonus: finiteAt(player.bonus_atteso_per_giornata, day, "bonus", 0),
  deviation: finiteAt(player.voto_puro_std_per_giornata, day, "std", 0),
  conceded: finiteAt(player.gol_subiti_per_giornata || player.goals_conceded_per_matchday, day, "gol subiti", 0),
});

const reconstructRosters = (players, events, names, rules) => {
  const byId = new Map(players.map((player) => [idKey(player?.id), player]));
  if (byId.size !== players.length || players.some((player) => player?.id == null)) throw new Error("Players must have unique ids");
  const rosters = names.map(() => []); const assigned = new Set();
  for (const event of events) {
    if (event?.type && String(event.type).toLowerCase() !== "sale") continue;
    const reference = event.player && typeof event.player === "object" ? event.player.id : (event.player ?? event.playerId ?? event.player_id);
    const player = byId.get(idKey(reference));
    const named = names.indexOf(event.team ?? event.teamName);
    const owner = Number.isInteger(Number(event.owner)) ? Number(event.owner) : Number.isInteger(Number(event.teamIndex)) ? Number(event.teamIndex) : named;
    if (!player || owner < 0 || owner >= names.length) throw new Error("Sale event references an unknown player or team");
    if (assigned.has(idKey(player.id))) throw new Error(`Player ${player.id} was sold more than once`);
    assigned.add(idKey(player.id)); rosters[owner].push(player);
  }
  if (rules.incompleteLineup === "error") rosters.forEach((roster, owner) => {
    const legal = Object.entries(rules.rosterSlots).every(([role, slots]) => roster.filter((player) => player.ruolo === role).length === slots);
    if (!legal) throw new Error(`${names[owner]} does not have a legal roster`);
  });
  return rosters;
};

const generatedSchedule = (teamCount, days) => {
  let rotation = Array.from({ length: teamCount }, (_, index) => index); const first = [];
  for (let round = 0; round < teamCount - 1; round++) { const fixtures = []; for (let index = 0; index < teamCount / 2; index++) fixtures.push(index === 0 && round % 2 ? [rotation.at(-1 - index), rotation[index]] : [rotation[index], rotation.at(-1 - index)]); first.push(fixtures); rotation = [rotation[0], rotation.at(-1), ...rotation.slice(1, -1)]; }
  return Array.from({ length: days }, (_, day) => { const fixtures = first[day % first.length]; return Math.floor(day / first.length) % 2 ? fixtures.map(([a, b]) => [b, a]) : fixtures; });
};
const calendarSchedule = (calendar, names) => {
  if (Array.isArray(calendar?.matchdays)) return calendar.matchdays.map((round, index) => ({
    day: Number(round.serie_a_matchday ?? round.serieAMatchday ?? index + 1) - 1,
    fixtures: (round.fixtures || []).map((fixture) => {
      const result = [names.indexOf(String(fixture.home)), names.indexOf(String(fixture.away))];
      if (result.some((team) => team < 0)) throw new Error("Calendar references an unknown team");
      return result;
    }),
  }));
  const rounds = Array.isArray(calendar) ? calendar : calendar?.giornate || calendar?.rounds || calendar?.fixtures;
  if (!Array.isArray(rounds)) return null;
  const indexFor = (team) => Number.isInteger(Number(team)) ? Number(team) : names.indexOf(String(team));
  return rounds.map((round, day) => ({ day, fixtures: (Array.isArray(round) ? round : round.partite || round.matches || round.fixtures || []).map((fixture) => {
    const pair = Array.isArray(fixture) ? fixture : [fixture.home ?? fixture.casa ?? fixture.team1, fixture.away ?? fixture.trasferta ?? fixture.team2];
    const result = [indexFor(pair[0]), indexFor(pair[1])]; if (result.some((index) => index < 0 || index >= names.length)) throw new Error("Calendar references an unknown team"); return result;
  }) }));
};

export const chooseLineup = (roster, day, rules) => {
  const roles = Object.keys(rules.rosterSlots); const byRole = Object.fromEntries(roles.map((role) => [role, []]));
  roster.forEach((player, order) => { if (byRole[player.ruolo]) { const values = playerValues(player, day); byRole[player.ruolo].push({ player, values, order, expected: values.probability * (values.vote + values.bonus) }); } });
  Object.values(byRole).forEach((items) => items.sort((a, b) => b.expected - a.expected || a.order - b.order));
  let best; let expected = -Infinity;
  for (const formation of rules.formations) {
    const counts = countsFor(formation);
    const lineup = Object.entries(counts).flatMap(([role, count]) => byRole[role]?.slice(0, count) || []);
    const score = lineup.reduce((sum, item) => sum + item.expected, 0) + expectedDefenseModifier({
      ...rules.defenseModifier,
      goalkeeper: lineup.find((item) => item.player.ruolo === "P") && { probability: lineup.find((item) => item.player.ruolo === "P").values.probability, vote: lineup.find((item) => item.player.ruolo === "P").values.vote },
      defenders: lineup.filter((item) => item.player.ruolo === "D").map((item) => ({ probability: item.values.probability, vote: item.values.vote })),
    });
    if (lineup.length === 11 && score > expected) { best = lineup; expected = score; }
  }
  if (!best && rules.incompleteLineup === "error") throw new Error("Roster cannot field an allowed formation");
  const starters = best || roster.slice(0, 11).map((player, order) => ({ player, order, values: playerValues(player, day), expected: 0 }));
  const starterIds = new Set(starters.map((item) => idKey(item.player.id)));
  const benchRoles = rules.bench?.roles || ["P", "P", "D", "D", "D", "C", "C", "C", "A", "A", "A"];
  const benchLimits = benchRoles.reduce((counts, role) => ({ ...counts, [role]: (counts[role] || 0) + 1 }), {});
  const bench = Object.entries(benchLimits).flatMap(([role, limit]) =>
    (byRole[role] || []).filter((item) => !starterIds.has(idKey(item.player.id))).slice(0, limit),
  );
  return { starters, bench };
};

export const scoreTeam = (selection, random, rules) => {
  const played = (item) => random() < item.values.probability;
  const active = selection.starters.map((item) => ({ ...item, played: played(item) }));
  const bench = selection.bench.map((item) => ({ ...item, played: played(item) }));
  let substitutions = 0;
  for (const missing of active.filter((item) => !item.played)) {
    if (rules.bench?.mode === "None" || substitutions >= (rules.bench?.maxSubstitutions ?? 3)) break;
    const replacement = bench.find((item) => !item.used && item.played && item.player.ruolo === missing.player.ruolo);
    if (replacement) { replacement.used = true; substitutions++; missing.player = replacement.player; missing.values = replacement.values; missing.played = true; }
  }
  const scored = active.filter((item) => item.played).map((item) => {
    const pureVote = Math.max(4, Math.min(10, item.values.vote + normal(random) * item.values.deviation));
    return { ...item, pureVote, points: pureVote + item.values.bonus + (item.player.ruolo === "P" ? item.values.conceded * Number(rules.scoring.goalkeeperConceded || 0) : 0) };
  });
  if (scored.length !== 11) {
    if (["zero_score", "forfeit"].includes(rules.incompleteLineup)) return { score: Number(rules.incompleteLineupScore || 0), scored };
    return { score: scored.reduce((sum, item) => sum + item.points, 0), scored };
  }
  const modifier = defenseModifierBonus({
    ...rules.defenseModifier,
    goalkeeperVote: scored.find((item) => item.player.ruolo === "P")?.pureVote,
    defenderVotes: scored.filter((item) => item.player.ruolo === "D").map((item) => item.pureVote),
  });
  return { score: scored.reduce((sum, item) => sum + item.points, 0) + modifier, scored };
};
const goals = (score, rules) => score < rules.virtualGoals.threshold ? 0 : 1 + Math.floor((score - rules.virtualGoals.threshold) / rules.virtualGoals.increment);

export const rankMockStandings = (table, directPoints, rules) => {
  // Direct results are restricted to the current league-points tie group.
  const headToHead = new Map(table.map((row, team) => [team, table.reduce((total, opponent, opponentIndex) => total + (opponent.points === row.points ? directPoints[team][opponentIndex] : 0), 0)]));
  const value = (row, index, key) => key === "goal_difference" ? row.goalsFor - row.goalsAgainst : key === "head_to_head" ? headToHead.get(index) : row.fantasyPoints;
  const key = (row, index) => [row.points, ...rules.standings.tieBreakers.map((rule) => value(row, index, rule))];
  const compare = (a, b) => key(b.row, b.index).map((part, index) => part - key(a.row, a.index)[index]).find(Boolean) || 0;
  const sharedRank = rules.standings.exactTie === "shared" || rules.standings.exactTie === "shared_rank";
  return table.map((row, index) => ({ row, index })).sort((a, b) => compare(a, b) || (sharedRank ? 0 : a.index - b.index)).map(({ row, index }, position, all) => ({ rank: sharedRank && position && compare(all[position - 1], { row, index }) === 0 ? all[position - 1].rank : position + 1, ...row }));
};

export const simulateMockLeague = ({ players, events, teamNames, seed, matchdays, calendario_lega, rules: suppliedRules } = {}) => {
  if (!Array.isArray(players) || !Array.isArray(events)) throw new TypeError("players and events must be arrays");
  const rules = normalizeRules({ ...suppliedRules, calendario_lega: suppliedRules?.calendario_lega ?? calendario_lega }); const names = teamNames || rules.teamNames;
  if (!Array.isArray(names) || names.length !== rules.participants || new Set(names).size !== names.length) throw new Error(`teamNames must contain ${rules.participants} unique names`);
  const schedule = calendarSchedule(rules.calendar, names) || generatedSchedule(names.length, matchdays ?? 36).map((fixtures, day) => ({ fixtures, day }));
  const rosters = reconstructRosters(players, events, names, rules); const random = randomFor(seed);
  const table = names.map((team) => ({ team, points: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, fantasyPoints: 0 }));
  const directPoints = names.map(() => Array(names.length).fill(0));
  schedule.forEach(({ fixtures, day }) => {
    const results = rosters.map((roster) => scoreTeam(chooseLineup(roster, day, rules), random, rules));
    results.forEach((result, team) => { table[team].fantasyPoints += result.score; });
    fixtures.forEach(([home, away]) => { const homeGoals = goals(results[home].score, rules); const awayGoals = goals(results[away].score, rules); Object.assign(table[home], { goalsFor: table[home].goalsFor + homeGoals, goalsAgainst: table[home].goalsAgainst + awayGoals }); Object.assign(table[away], { goalsFor: table[away].goalsFor + awayGoals, goalsAgainst: table[away].goalsAgainst + homeGoals }); let homePoints; let awayPoints; if (homeGoals > awayGoals) { table[home].wins++; table[away].losses++; homePoints = rules.standings.win; awayPoints = rules.standings.loss; } else if (awayGoals > homeGoals) { table[away].wins++; table[home].losses++; homePoints = rules.standings.loss; awayPoints = rules.standings.win; } else { table[home].draws++; table[away].draws++; homePoints = awayPoints = rules.standings.draw; } table[home].points += homePoints; table[away].points += awayPoints; directPoints[home][away] += homePoints; directPoints[away][home] += awayPoints; });
  });
  return rankMockStandings(table.map((row) => ({ ...row, fantasyPoints: Number(row.fantasyPoints.toFixed(2)) })), directPoints, rules);
};
