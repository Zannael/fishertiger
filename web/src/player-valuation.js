const finite = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

const quantile = (sorted, fraction) => {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

const percentile = (sorted, value) =>
  sorted.length
    ? sorted.filter((item) => item <= value).length / sorted.length
    : 0;

export const sourceFvm = (player) =>
  finite(player?.fvm_original, finite(player?.fvm_scaled) / 0.75);

export const projectedContribution = (player, matchdayIndices = null) => {
  const chances = Array.isArray(player?.p_gioca_per_giornata)
    ? player.p_gioca_per_giornata
    : [];
  const votes = Array.isArray(player?.voto_puro_mean_per_giornata)
    ? player.voto_puro_mean_per_giornata
    : [];
  const bonuses = Array.isArray(player?.bonus_atteso_per_giornata)
    ? player.bonus_atteso_per_giornata
    : [];
  if (chances.length) {
    const days = Array.isArray(matchdayIndices) && matchdayIndices.length
      ? matchdayIndices
      : chances.map((_, day) => day);
    return days.reduce(
      (sum, day) =>
        sum + finite(chances[day]) * (finite(votes[day]) + finite(bonuses[day])),
      0,
    );
  }
  const projection = player?.proiezione || {};
  return (
    (Array.isArray(matchdayIndices) && matchdayIndices.length ? matchdayIndices.length : 38) *
    finite(projection.p_gioca) *
    (finite(projection.voto_puro) + finite(projection.bonus))
  );
};

export const createRoleValuation = (players, rules) => {
  const roles = Object.keys(rules.rosterSlots);
  const participants = Math.max(1, Number(rules.participants) || 1);
  const unique = [...new Map(players.map((player) => [String(player.id), player])).values()];
  const models = Object.fromEntries(
    roles.map((role) => {
      const rolePlayers = unique.filter((player) => player.ruolo === role);
      const sourceValues = rolePlayers
        .map(sourceFvm)
        .filter((value) => value > 0)
        .sort((a, b) => a - b);
      const projectedValues = rolePlayers
        .map((player) => projectedContribution(player, rules.horizons?.currentLeague?.matchdayIndices))
        .sort((a, b) => a - b);
      const demand = participants * rules.rosterSlots[role];
      const pricedSupply = sourceValues.slice(-demand);
      const sourceTotal = pricedSupply.reduce((sum, value) => sum + value, 0);
      const targetPerTeam =
        finite(rules.startingCredits) *
        finite(rules.auction.roleBudgetPercentages[role]) /
        100;
      const leagueTarget = targetPerTeam * participants;
      const q1 = quantile(sourceValues, 0.25);
      const q3 = quantile(sourceValues, 0.75);
      const q95 = quantile(sourceValues, 0.95);
      return [
        role,
        {
          demand,
          targetPerTeam,
          scale: sourceTotal > 0 ? leagueTarget / sourceTotal : 1,
          sourceValues,
          projectedValues,
          q1,
          q3,
          upperFence: Math.max(q3 + 5 * (q3 - q1), q95 * 2),
        },
      ];
    }),
  );

  const normalizedFvm = (player) =>
    Math.max(1, sourceFvm(player) * finite(models[player.ruolo]?.scale, 1));
  const outliersFor = (player) => {
    const model = models[player.ruolo];
    if (!model) return [];
    const source = sourceFvm(player);
    const notices = [];
    if (source > model.upperFence && model.upperFence > 0) {
      notices.push({
        code: "source_fvm_high",
        label: "FVM fonte fuori scala nel ruolo",
      });
    }
    const projectionRank = percentile(
      model.projectedValues,
      projectedContribution(player, rules.horizons?.currentLeague?.matchdayIndices),
    );
    if (source <= model.q1 && projectionRank >= 0.8) {
      notices.push({
        code: "source_fvm_low_for_projection",
        label: "FVM fonte molto basso rispetto alla proiezione",
      });
    }
    if (source >= model.q3 && projectionRank <= 0.3) {
      notices.push({
        code: "source_fvm_high_for_projection",
        label: "FVM fonte alto rispetto alla proiezione",
      });
    }
    return notices;
  };

  return { models, normalizedFvm, outliersFor };
};
