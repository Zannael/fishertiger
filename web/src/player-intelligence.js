import { projectedContribution } from "./player-valuation.js";

const id = (value) => String(value ?? "");
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const percentile = (values, value) => Number.isFinite(value) && values.length ? Math.round(values.filter((item) => item <= value).length / values.length * 100) : null;

export const teamCalendar = (fixtureContext, team, horizon = 5) => {
  const current = Number(fixtureContext?.current_matchday || 1);
  return (fixtureContext?.fixtures || [])
    .filter((row) => row.normalized_team === String(team || "").toLocaleLowerCase() || row.team === team)
    .filter((row) => row.matchday > current || (row.matchday === current && row.fixture_state === "upcoming"))
    .sort((a, b) => a.matchday - b.matchday)
    .slice(0, horizon);
};

export const pairingMetrics = (first, second, horizon = Math.min(first.length, second.length)) => {
  const hasRounds = first.every((row) => Number.isInteger(row.matchday)) && second.every((row) => Number.isInteger(row.matchday));
  const pairs = hasRounds
    ? first.map((row) => [row, second.find((candidate) => candidate.matchday === row.matchday)]).filter(([, row]) => row).slice(0, horizon)
    : first.slice(0, horizon).map((row, index) => [row, second[index]]).filter(([, row]) => row);
  const length = pairs.length;
  const a = pairs.map(([row]) => row.opponent_strength_percentile);
  const b = pairs.map(([, row]) => row.opponent_strength_percentile);
  const best = a.map((value, index) => Math.min(value, b[index]));
  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const meanA = average(a), meanB = average(b), meanBest = average(best);
  return { matchdays: pairs.map(([row], index) => row.matchday ?? index + 1), vector_a: a, vector_b: b, best_pair: best, mean_a: meanA, mean_b: meanB, mean_best_pair: meanBest, complementarity_gain: length ? Math.min(meanA, meanB) - meanBest : null, hard_overlap: a.filter((value, index) => value >= 70 && b[index] >= 70).length, easy_coverage: best.filter((value) => value <= 40).length, sample_size: length };
};

export const pairingSuggestions = (fixtureContext, selected, players, assigned = {}, horizon = 5) => {
  const base = teamCalendar(fixtureContext, selected?.squadra, 38);
  return (players || []).filter((candidate) => candidate.id !== selected?.id && candidate.ruolo === selected?.ruolo && candidate.squadra && !candidate.ceduto)
    .map((candidate) => ({ player: candidate, auctioned: Boolean(assigned?.[id(candidate.id)]), metrics: pairingMetrics(base, teamCalendar(fixtureContext, candidate.squadra, 38), horizon) }))
    .filter((row) => row.metrics.sample_size === horizon)
    .sort((left, right) => (right.metrics.complementarity_gain - left.metrics.complementarity_gain) || (left.metrics.mean_best_pair - right.metrics.mean_best_pair) || left.player.nome.localeCompare(right.player.nome));
};

export const finalizedForm = (performance, playerId) => {
  const states = new Map((performance?.matchdays || []).map((row) => [row.matchday, row.state]));
  const rows = (performance?.players || []).filter((row) => id(row.fantacalcio_id) === id(playerId) && states.get(row.matchday) === "final");
  const appearances = rows.filter((row) => row.started || row.entered_from_bench);
  const votes = rows.filter((row) => row.vote_fc?.state === "numeric").map((row) => Number(row.vote_fc.value));
  return {
    final_appearances: appearances.length,
    starts: appearances.filter((row) => row.started).length,
    substitute_appearances: appearances.filter((row) => row.entered_from_bench).length,
    minutes: appearances.reduce((sum, row) => sum + (Number.isFinite(row.minutes_played) ? row.minutes_played : 0), 0),
    numeric_fc_votes: votes.length,
    mean_fc_vote: mean(votes),
    last_3_mean: mean(votes.slice(-3)), last_3_sample_size: votes.slice(-3).length,
    last_5_mean: mean(votes.slice(-5)), last_5_sample_size: votes.slice(-5).length,
    ...Object.fromEntries(["goals", "assists", "yellow_cards", "red_cards"].map((key) => [key, rows.reduce((sum, row) => sum + (Number.isFinite(row[key]) ? row[key] : 0), 0)])),
  };
};

export const p1PlayerViewModel = (snapshot, playerId, players = [], rules = {}, board = null) => {
  const states = new Map((snapshot?.performance?.matchdays || []).map((row) => [row.matchday, row.state]));
  const performance = (snapshot?.performance?.players || [])
    .filter((row) => id(row.fantacalcio_id) === id(playerId))
    .map((row) => ({ ...row, round_state: states.get(row.matchday) || "provisional" }))
    .sort((left, right) => right.matchday - left.matchday);
  const marketRows = snapshot?.market?.players || [];
  const market = marketRows.find((row) => id(row.fantacalcio_id) === id(playerId)) || null;
  const forecast = (snapshot?.forecast?.players || []).find((row) => id(row.fantacalcio_id) === id(playerId)) || null;
  const lineup = (snapshot?.lineups?.players || []).find((row) => id(row.fantacalcio_id) === id(playerId) && row.matchday === snapshot?.lineups?.matchday && row.fixture_state === "upcoming") || null;
  const player = players.find((row) => id(row.id) === id(playerId));
  const role = player?.ruolo || market?.canonical_role;
  const modelValues = players.filter((row) => row.ruolo === role).map((row) => projectedContribution(row, rules?.horizons?.currentLeague?.matchdayIndices)).filter(Number.isFinite);
  const modelValue = player ? projectedContribution(player, rules?.horizons?.currentLeague?.matchdayIndices) : null;
  const priceFor = (row) => row?.price_cohort_compatible ? row.market_price : row?.benchmark_market_price;
  const currentPrices = marketRows.filter((row) => row.canonical_role === role).map(priceFor).filter((price) => price?.current_season && !price?.fallback_previous_season && !price?.unavailable && Number.isFinite(price?.value)).map((price) => price.value);
  const selectedPrice = priceFor(market);
  const ownershipValues = marketRows.filter((row) => row.canonical_role === role && Number.isFinite(row.ownership_pct)).map((row) => row.ownership_pct);
  const modelPercentile = percentile(modelValues, modelValue);
  const marketPercentile = selectedPrice?.current_season && !selectedPrice?.fallback_previous_season && !selectedPrice?.unavailable ? percentile(currentPrices, selectedPrice.value) : null;
  const calendars = Object.fromEntries([5, 8, 10].map((horizon) => [horizon, {
    fixtures: teamCalendar(snapshot?.fixture_context, player?.squadra, horizon),
    pairings: pairingSuggestions(snapshot?.fixture_context, player, players, board?.assigned, horizon),
  }]));
  return {
    performance: performance.slice(0, 5),
    form: (snapshot?.performance?.form_analytics || []).find((row) => id(row.fantacalcio_id) === id(playerId)) || finalizedForm(snapshot?.performance, playerId),
    market,
    forecast: forecast && { ...forecast, potential_gap: forecast.fantaindex_potential - forecast.fantaindex_current },
    lineup,
    positioning: { model_percentile: modelPercentile, market_percentile: marketPercentile, model_market_gap_pp: Number.isFinite(modelPercentile) && Number.isFinite(marketPercentile) ? modelPercentile - marketPercentile : null, ownership_role_percentile: Number.isFinite(market?.ownership_pct) ? percentile(ownershipValues, market.ownership_pct) : null, market_sample_size: currentPrices.length, model_sample_size: modelValues.length, ownership_sample_size: ownershipValues.length, non_comparable_credits: market ? !market.price_cohort_compatible : null },
    calendar: calendars,
  };
};

export const voteLabel = (vote) => vote?.state === "numeric" ? Number(vote.value).toFixed(1) : vote?.state === "sv" ? "s.v." : "—";

export const appearanceLabel = (row) => {
  if (row?.did_not_enter) return "non entrato";
  if (Number.isFinite(row?.minutes_played)) return `${row.minutes_played}'`;
  return row?.entered_from_bench ? "subentrato" : row?.started ? "titolare" : "—";
};
