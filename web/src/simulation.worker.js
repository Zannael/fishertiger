import { normalizeRules } from "./league-rules.js";
import {
  createRoleValuation,
  projectedContribution,
  sourceFvm,
} from "./player-valuation.js";
import { expectedDefenseModifier } from "./defense-modifier.js";
const EMPTY = -1e15;

const finite = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const rounded = (value) => Math.round(finite(value));
const playerKey = (player) =>
  player?.id == null
    ? `${player?.nome || ""}|${player?.ruolo || ""}|${player?.squadra || ""}`
    : String(player.id);

const contribution = (player, rules) => projectedContribution(player, rules.horizons?.currentLeague?.matchdayIndices);

const defenseProfile = (player) => ({
  probability: Array.isArray(player?.p_gioca_per_giornata) && player.p_gioca_per_giornata.length
    ? player.p_gioca_per_giornata.reduce((sum, value) => sum + finite(value), 0) / player.p_gioca_per_giornata.length
    : finite(player?.proiezione?.p_gioca),
  vote: Array.isArray(player?.voto_puro_mean_per_giornata) && player.voto_puro_mean_per_giornata.length
    ? player.voto_puro_mean_per_giornata.reduce((sum, value) => sum + finite(value), 0) / player.voto_puro_mean_per_giornata.length
    : finite(player?.proiezione?.voto_puro),
});

const defenseValue = (roster, rules) => {
  if (!rules.defenseModifier.enabled) return 0;
  const goalkeepers = roster.filter((item) => item.ruolo === "P").sort((a, b) => defenseProfile(b).vote - defenseProfile(a).vote);
  const defenders = roster.filter((item) => item.ruolo === "D").sort((a, b) => defenseProfile(b).vote - defenseProfile(a).vote);
  const goalkeeper = goalkeepers[0];
  if (!goalkeeper || defenders.length < rules.defenseModifier.requiredDefenders) return 0;
  return expectedDefenseModifier({
    ...rules.defenseModifier,
    goalkeeper: defenseProfile(goalkeeper),
    defenders: defenders.map(defenseProfile),
  });
};

const roleNeeds = (team, rules) =>
  Object.fromEntries(
    Object.keys(rules.rosterSlots).map((role) => [
      role,
      Math.max(
        0,
        rules.rosterSlots[role] -
          (team?.roster || []).filter((player) => player.ruolo === role).length,
      ),
    ]),
  );

const totalNeeds = (needs) => Object.keys(needs).reduce((sum, role) => sum + needs[role], 0);

const median = (values) => {
  if (!values.length) return 1;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const assignmentRecords = (data, teams) => {
  if (Array.isArray(data.history) && data.history.length) {
    return data.history.filter(
      (item) => item?.player && finite(item.price) > 0,
    );
  }
  const players = new Map();
  teams.forEach((team) =>
    (team?.roster || []).forEach((player) =>
      players.set(playerKey(player), player),
    ),
  );
  return Object.entries(data.assigned || {}).flatMap(([id, assignment]) => {
    const player = players.get(String(id));
    return player && finite(assignment?.price) > 0
      ? [{ player, owner: assignment.owner, price: finite(assignment.price) }]
      : [];
  });
};

const marketModel = (data, teams, rules, baseValueFor) => {
  const records = assignmentRecords(data, teams);
  const spentByTeam = teams.map(() => 0);
  records.forEach((record) => {
    if (
      Number.isInteger(Number(record.owner)) &&
      spentByTeam[Number(record.owner)] != null
    ) {
      spentByTeam[Number(record.owner)] += finite(record.price);
    }
  });
  const inferredStarts = teams
    .map((team, index) => finite(team?.credits) + spentByTeam[index])
    .filter(Boolean);
  const budgetScale = inferredStarts.length ? median(inferredStarts) / Number(rules.startingCredits || 1) : 1;
  const ratios = records.flatMap((record) => {
    const reference = baseValueFor(record.player) * budgetScale;
    return reference > 0
      ? [clamp(finite(record.price) / reference, 0.25, 4)]
      : [];
  });
  const observed = median(ratios);
  const inflation = 1 + ((observed - 1) * ratios.length) / (ratios.length + 8);
  const roleInflation = Object.fromEntries(
    Object.keys(rules.rosterSlots).map((role) => {
      const roleRatios = records.flatMap((record) => {
        const reference = baseValueFor(record.player) * budgetScale;
        return record.player?.ruolo === role && reference > 0
          ? [clamp(finite(record.price) / reference, 0.25, 4)]
          : [];
      });
      const roleObserved = median(roleRatios);
      const shrunk =
        inflation +
        ((roleObserved - inflation) * roleRatios.length) /
          (roleRatios.length + 5);
      return [role, shrunk];
    }),
  );
  return { records, inflation, roleInflation, budgetScale };
};

const scarcityModel = (pool, teams, rules) =>
  Object.fromEntries(
    Object.keys(rules.rosterSlots).map((role) => {
      const supply = pool.filter((player) => player.ruolo === role).length;
      const demand = teams.reduce(
        (sum, team) => sum + roleNeeds(team, rules)[role],
        0,
      );
      const ratio = demand / Math.max(1, supply);
      return [
        role,
        {
          supply,
          demand,
          ratio,
          factor: clamp(0.9 + ratio * 0.35, 0.92, 1.35),
        },
      ];
    }),
  );

const opponentModel = (role, teams, ownerIndex, rules) => {
  const opponents = teams.filter((_, index) => index !== ownerIndex);
  const needing = opponents.filter((team) => roleNeeds(team, rules)[role] > 0);
  const legalMaxima = needing.map((team) => {
    const needs = roleNeeds(team, rules);
    return Math.max(
      0,
      Math.floor(finite(team.credits)) - rules.auction.reserve * (totalNeeds(needs) - 1),
    );
  });
  return {
    needing: needing.length,
    affordable: legalMaxima.filter((value) => value > 0).length,
    maxBudget: legalMaxima.length ? Math.max(...legalMaxima) : 0,
    averageBudget: legalMaxima.length
      ? legalMaxima.reduce((sum, value) => sum + value, 0) / legalMaxima.length
      : 0,
  };
};

const roleBudgetPlan = (records, ownerIndex, needs, rules) => {
  const roles = Object.keys(rules.rosterSlots);
  const targets = Object.fromEntries(
    roles.map((role) => [
      role,
      (finite(rules.startingCredits) *
        finite(rules.auction.roleBudgetPercentages[role])) /
        100,
    ]),
  );
  const spent = Object.fromEntries(roles.map((role) => [role, 0]));
  records.forEach((record) => {
    if (
      Number(record.owner) === ownerIndex &&
      spent[record.player?.ruolo] != null
    )
      spent[record.player.ruolo] += finite(record.price);
  });
  const released = roles.reduce(
    (sum, role) =>
      sum + (!needs[role] ? Math.max(0, targets[role] - spent[role]) : 0),
    0,
  );
  const openWeight = roles.reduce(
    (sum, role) =>
      sum +
      (needs[role]
        ? finite(rules.auction.roleBudgetPercentages[role])
        : 0),
    0,
  );
  return Object.fromEntries(
    roles.map((role) => {
      const redistributed =
        needs[role] && openWeight
          ? (released * finite(rules.auction.roleBudgetPercentages[role])) /
            openWeight
          : 0;
      const remaining = Math.max(0, targets[role] - spent[role]) + redistributed;
      const softRemaining =
        remaining *
        (1 + finite(rules.auction.roleBudgetFlexibilityPercent) / 100);
      return [
        role,
        {
          target: targets[role],
          spent: spent[role],
          remaining,
          bidCap: Math.max(
            0,
            Math.floor(
              softRemaining -
                Math.max(0, needs[role] - 1) * rules.auction.reserve,
            ),
          ),
        },
      ];
    }),
  );
};

const estimatedCost = (
  player,
  market,
  scarcity,
  baseValueFor,
  competition = null,
) => {
  const role = player?.ruolo;
  const base = Math.max(1, baseValueFor(player) * market.budgetScale);
  const roleMarket = finite(market.roleInflation[role], market.inflation);
  const pressure = competition
    ? 1 + Math.min(0.12, competition.affordable * 0.012)
    : 1;
  return Math.max(
    1,
    rounded(base * roleMarket * finite(scarcity[role]?.factor, 1) * pressure),
  );
};

// Returns the best exact-count value for every budget. Descending loops ensure
// each available player can be selected only once.
const roleFrontier = (players, count, budget, costFor, valueFor) => {
  const dp = Array.from({ length: count + 1 }, () => {
    const row = new Float64Array(budget + 1);
    row.fill(EMPTY);
    return row;
  });
  dp[0].fill(0);
  for (const player of players) {
    const cost = costFor(player);
    if (cost > budget) continue;
    const value = valueFor(player);
    for (let selected = count; selected >= 1; selected--) {
      const current = dp[selected];
      const previous = dp[selected - 1];
      for (let credits = budget; credits >= cost; credits--) {
        if (previous[credits - cost] > EMPTY / 2) {
          current[credits] = Math.max(
            current[credits],
            previous[credits - cost] + value,
          );
        }
      }
    }
  }
  const result = dp[count];
  for (let credits = 1; credits <= budget; credits++) {
    result[credits] = Math.max(result[credits], result[credits - 1]);
  }
  return result;
};

const completionFrontier = (pool, needs, budget, costFor, valueFor) => {
  let combined = new Float64Array(budget + 1);
  combined.fill(0);
  for (const role of Object.keys(needs)) {
    if (!needs[role]) continue;
    const rolePlayers = pool.filter((player) => player.ruolo === role);
    const roleValues = roleFrontier(rolePlayers, needs[role], budget, costFor, valueFor);
    const next = new Float64Array(budget + 1);
    next.fill(EMPTY);
    for (let credits = 0; credits <= budget; credits++) {
      for (let roleBudget = 0; roleBudget <= credits; roleBudget++) {
        if (
          combined[credits - roleBudget] > EMPTY / 2 &&
          roleValues[roleBudget] > EMPTY / 2
        ) {
          next[credits] = Math.max(
            next[credits],
            combined[credits - roleBudget] + roleValues[roleBudget],
          );
        }
      }
    }
    combined = next;
  }
  for (let credits = 1; credits <= budget; credits++) {
    combined[credits] = Math.max(combined[credits], combined[credits - 1]);
  }
  return combined;
};

const invalidResult = (ownerIndex, team, legalMax, reason, needs) => ({
  kind: "candidate",
  recommendation: "INELIGIBLE",
  idealMin: 0,
  idealMax: 0,
  maxBid: 0,
  legalMax,
  confidence: 1,
  utility: "Acquisto non consentito",
  simulations: 0,
  reasons: [reason],
  risks: [],
  alternatives: [],
  rolePlan: {},
  summary: {
    owner: ownerIndex,
    ownerName: team?.name || `Squadra ${ownerIndex + 1}`,
    credits: finite(team?.credits),
    rosterSize: team?.roster?.length || 0,
    slotsOpen: totalNeeds(needs),
    deterministic: true,
  },
});

export const evaluateOverview = (data = {}) => {
  const rules = normalizeRules(data.rules);
  const roles = Object.keys(rules.rosterSlots);
  const teams = Array.isArray(data.teams) ? data.teams : [];
  const requestedOwner = Number(data.owner);
  const mineIndex = teams.indexOf(data.mine);
  const ownerIndex =
    Number.isInteger(requestedOwner) &&
    requestedOwner >= 0 &&
    requestedOwner < teams.length
      ? requestedOwner
      : mineIndex >= 0
        ? mineIndex
        : 0;
  const team = teams[ownerIndex] || data.mine || { credits: 0, roster: [] };
  const pool = Array.isArray(data.remaining) ? data.remaining : [];
  const needs = roleNeeds(team, rules);
  const slotsOpen = totalNeeds(needs);
  const credits = Math.max(0, Math.floor(finite(team.credits)));
  const reservedCredits = Math.min(credits, slotsOpen * rules.auction.reserve);
  const spendableCredits = Math.max(0, credits - reservedCredits);
  const records = assignmentRecords(data, teams);
  const valuation = createRoleValuation(
    [...pool, ...records.map((record) => record.player)],
    rules,
  );
  const market = marketModel(data, teams, rules, valuation.normalizedFvm);
  const scarcity = scarcityModel(pool, teams, rules);
  const costFor = (item) =>
    estimatedCost(item, market, scarcity, valuation.normalizedFvm);
  const budgetPlan = roleBudgetPlan(records, ownerIndex, needs, rules);
  const valueFor = (player) => contribution(player, rules);

  const plans = Object.fromEntries(
    roles.map((role) => {
      const available = pool.filter((item) => item.ruolo === role);
      const planned = available
        .map((item) => ({ value: valueFor(item), cost: costFor(item) }))
        .sort((a, b) => b.value - a.value || a.cost - b.cost)
        .slice(0, needs[role]);
      return [
        role,
        {
          open: needs[role],
          owned: rules.rosterSlots[role] - needs[role],
          available: available.length,
          scarcity: Number(scarcity[role].ratio.toFixed(3)),
          estimatedSpend: planned.reduce((sum, item) => sum + item.cost, 0),
          budgetTarget: rounded(budgetPlan[role].target),
          budgetSpent: rounded(budgetPlan[role].spent),
          budgetRemaining: rounded(budgetPlan[role].remaining),
        },
      ];
    }),
  );

  const priorities = roles.map((role, index) => {
    const plan = plans[role];
    if (!plan.open) {
      return {
        role,
        urgency: "COMPLETO",
        reason: "Reparto completo: nessuno slot da coprire.",
        score: -1,
        index,
      };
    }
    const shortage = plan.available < plan.open;
    const fillShare = plan.open / rules.rosterSlots[role];
    const score = plan.scarcity * 2 + fillShare + (shortage ? 3 : 0);
    const urgency =
      shortage || plan.scarcity >= 1
        ? "ALTA"
        : plan.scarcity >= 0.5 || fillShare >= 0.5
          ? "MEDIA"
          : "BASSA";
    const reason = shortage
      ? `Mancano ${plan.open} giocatori ma ne restano solo ${plan.available} disponibili.`
      : urgency === "ALTA"
        ? `Servono ${plan.open} giocatori e la domanda del ruolo supera l'offerta.`
        : urgency === "MEDIA"
          ? `Servono ancora ${plan.open} giocatori: conviene monitorare i prossimi prezzi.`
          : `Restano ${plan.open} slot, con offerta sufficiente per attendere valore.`;
    return { role, urgency, reason, score, index };
  })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ role, urgency, reason }) => ({ role, urgency, reason }));

  return {
    kind: "overview",
    priorities,
    rolePlan: plans,
    summary: {
      owner: ownerIndex,
      ownerName: team.name || `Squadra ${ownerIndex + 1}`,
      credits,
      reservedCredits,
      spendableCredits,
      marketInflation: Number(market.inflation.toFixed(3)),
      slotsOpen,
      deterministic: true,
    },
  };
};

export const evaluateAuction = (data = {}) => {
  const rules = normalizeRules(data.rules);
  const roles = Object.keys(rules.rosterSlots);
  const teams = Array.isArray(data.teams) ? data.teams : [];
  const requestedOwner = Number(data.owner);
  const mineIndex = teams.indexOf(data.mine);
  const ownerIndex =
    Number.isInteger(requestedOwner) &&
    requestedOwner >= 0 &&
    requestedOwner < teams.length
      ? requestedOwner
      : mineIndex >= 0
        ? mineIndex
        : 0;
  const team = teams[ownerIndex] || data.mine || { credits: 0, roster: [] };
  const player = data.player;
  const needs = roleNeeds(team, rules);
  const openSlots = totalNeeds(needs);
  const credits = Math.max(0, Math.floor(finite(team.credits)));
  const legalMax = Math.max(0, credits - Math.max(0, openSlots - 1) * rules.auction.reserve);

  if (!player || !roles.includes(player.ruolo)) {
    return invalidResult(
      ownerIndex,
      team,
      legalMax,
      "Giocatore o ruolo non valido.",
      needs,
    );
  }
  if (needs[player.ruolo] < 1) {
    return invalidResult(
      ownerIndex,
      team,
      0,
      `Nessuno slot ${player.ruolo} disponibile.`,
      needs,
    );
  }
  if (legalMax < rules.auction.minPrice) {
    return invalidResult(
      ownerIndex,
      team,
      0,
      "Crediti insufficienti dopo la riserva di un credito per slot.",
      needs,
    );
  }

  const candidateKey = playerKey(player);
  // The auctioned player must not also be available as his own replacement.
  const pool = (Array.isArray(data.remaining) ? data.remaining : []).filter(
    (item) => playerKey(item) !== candidateKey,
  );
  const records = assignmentRecords(data, teams);
  const valuation = createRoleValuation(
    [player, ...pool, ...records.map((record) => record.player)],
    rules,
  );
  const market = marketModel(data, teams, rules, valuation.normalizedFvm);
  const scarcity = scarcityModel(pool, teams, rules);
  const competition = Object.fromEntries(
    roles.map((role) => [role, opponentModel(role, teams, ownerIndex, rules)]),
  );
  const costFor = (item) =>
    estimatedCost(item, market, scarcity, valuation.normalizedFvm);
  const candidateCost = estimatedCost(
    player,
    market,
    scarcity,
    valuation.normalizedFvm,
    competition[player.ruolo],
  );
  const budgetPlan = roleBudgetPlan(records, ownerIndex, needs, rules);
  const valueFor = (item) => contribution(item, rules);
  const roleBidCap = budgetPlan[player.ruolo].bidCap;

  const roleAlternatives = pool
    .filter((item) => item.ruolo === player.ruolo)
    .map((item) => ({
      player: item,
      value: valueFor(item),
      estimatedCost: costFor(item),
    }))
    .sort((a, b) => b.value - a.value || a.estimatedCost - b.estimatedCost);
  const scarcityInfo = scarcity[player.ruolo];
  const replacementIndex = roleAlternatives.length
    ? Math.min(roleAlternatives.length - 1, Math.max(0, scarcityInfo.demand - 1))
    : null;
  const replacement =
    replacementIndex == null ? null : roleAlternatives[replacementIndex];
  const candidateValue = valueFor(player);
  const individualMarginalValue = candidateValue - finite(replacement?.value);
  const currentDefenseValue = defenseValue(team.roster || [], rules);
  const candidateDefenseValue = defenseValue([...(team.roster || []), player], rules);
  const alternativeDefenseValue = replacement
    ? defenseValue([...(team.roster || []), replacement.player], rules)
    : currentDefenseValue;
  const defenseMarginalValue = candidateDefenseValue - alternativeDefenseValue;
  const marginalValue = individualMarginalValue + defenseMarginalValue;
  const opponents = competition[player.ruolo];
  const qualityEdge = replacement
    ? marginalValue / Math.max(1, candidateValue, replacement.value)
    : 0.625;
  const qualityMultiplier = clamp(1 + qualityEdge * 0.4, 0.75, 1.25);
  const rawValueCap = rounded(candidateCost * qualityMultiplier);
  const valueCap =
    rawValueCap < rules.auction.minPrice
      ? 0
      : rules.auction.minPrice +
        Math.floor(
          (rawValueCap - rules.auction.minPrice) / rules.auction.increment,
        ) *
          rules.auction.increment;

  const baseline = completionFrontier(pool, needs, credits, costFor, valueFor);
  const withNeeds = { ...needs, [player.ruolo]: needs[player.ruolo] - 1 };
  const withCandidate = completionFrontier(pool, withNeeds, credits, costFor, valueFor);
  const baselineValue = baseline[credits];
  const baselineFeasible = baselineValue > EMPTY / 2;
  let maxBid = 0;
  for (
    let bid = rules.auction.minPrice;
    bid <= Math.min(legalMax, valueCap, roleBidCap);
    bid += rules.auction.increment
  ) {
    if (withCandidate[credits - bid] > EMPTY / 2) maxBid = bid;
  }

  const idealMax = Math.min(maxBid, Math.max(0, rounded(candidateCost * 1.05)));
  const idealMin =
    idealMax > 0
      ? Math.max(
          rules.auction.minPrice,
          Math.min(
            rounded(candidateCost * 0.75),
            rounded(idealMax * 0.8),
          ),
        )
      : 0;
  const recommendation =
    maxBid < 1
      ? "PASS"
      : maxBid >= candidateCost * 1.2
        ? "STRONG_BUY"
        : maxBid >= candidateCost * 0.9
          ? "BID"
          : "VALUE_ONLY";

  const dataCoverage = Number(
    Array.isArray(player.p_gioca_per_giornata) &&
      player.p_gioca_per_giornata.length > 0,
  );
  const historyCoverage = Math.min(1, market.records.length / 20);
  const poolCoverage = Math.min(
    1,
    scarcityInfo.supply / Math.max(1, scarcityInfo.demand),
  );
  const confidence = clamp(
    0.3 + dataCoverage * 0.18 + historyCoverage * 0.32 + poolCoverage * 0.1,
    0,
    market.records.length ? 0.9 : 0.58,
  );
  const reasons = [
    replacement
      ? `${rounded(candidateValue)} punti proiettati; margine di ${rounded(marginalValue)} sul cutoff del ruolo (${replacementIndex + 1}° tra i disponibili).`
      : `${rounded(candidateValue)} punti proiettati; nessuna alternativa disponibile nel ruolo.`,
     `Margine corretto: ${rounded(individualMarginalValue)} punti individuali + ${rounded(defenseMarginalValue)} punti modificatore difesa.`,
     `Limite ancorato al mercato a ${candidateCost} crediti, corretto per qualità relativa e fattibilità del completamento.`,
    `Completamento ottimizzato rispettando ${openSlots} slot aperti e la riserva minima di ${Math.max(0, openSlots - 1) * rules.auction.reserve} crediti dopo l'acquisto.`,
    `Mercato osservato a ${market.inflation.toFixed(2)}x (${market.records.length} assegnazioni); ruolo ${player.ruolo} a ${market.roleInflation[player.ruolo].toFixed(2)}x.`,
    `${opponents.needing} avversari hanno ancora bisogno del ruolo; ${opponents.affordable} possono offrire almeno un credito oltre le proprie riserve.`,
  ];
  const risks = [];
  valuation.outliersFor(player).forEach((outlier) => risks.push(outlier.label));
  if (!baselineFeasible)
    risks.push(
      "Il mercato residuo non consente un completamento stimato senza questo giocatore.",
    );
  if (withCandidate[credits - maxBid] <= EMPTY / 2)
    risks.push(
      "Il mercato residuo non consente un completamento stimato della rosa, anche acquistando il candidato.",
    );
  if (market.records.length < 5)
    risks.push(
      "Storico prezzi ancora limitato: la stima dell'inflazione dipende soprattutto dai valori base.",
    );
  if (scarcityInfo.supply < scarcityInfo.demand)
    risks.push(
      `Offerta insufficiente nel ruolo: ${scarcityInfo.supply} giocatori per ${scarcityInfo.demand} slot complessivi.`,
    );
  if (candidateCost > maxBid && maxBid > 0)
    risks.push(
      `Prezzo di mercato stimato (${candidateCost}) superiore alla soglia di valore (${maxBid}).`,
    );
  if (opponents.maxBudget > legalMax)
    risks.push(
      "Almeno un avversario ha una capacita di rilancio superiore al limite legale della squadra.",
    );

  const rolePlan = Object.fromEntries(
    roles.map((role) => {
      const available = pool.filter((item) => item.ruolo === role);
      const planned = available
        .map((item) => ({ value: valueFor(item), cost: costFor(item) }))
        .sort((a, b) => b.value - a.value || a.cost - b.cost)
        .slice(0, needs[role]);
      return [
        role,
        {
          owned: rules.rosterSlots[role] - needs[role],
          open: needs[role],
          available: available.length,
          leagueDemand: scarcity[role].demand,
          scarcity: Number(scarcity[role].ratio.toFixed(3)),
          estimatedSpend: planned.reduce((sum, item) => sum + item.cost, 0),
          budgetTarget: rounded(budgetPlan[role].target),
          budgetSpent: rounded(budgetPlan[role].spent),
          budgetRemaining: rounded(budgetPlan[role].remaining),
          projectedValue: rounded(
            planned.reduce((sum, item) => sum + item.value, 0),
          ),
        },
      ];
    }),
  );

  return {
    kind: "candidate",
    recommendation,
    idealMin,
    idealMax,
    maxBid,
    legalMax,
    confidence: Number(confidence.toFixed(2)),
    utility: `${rounded(marginalValue)} pts marginali`,
    simulations: 0,
    reasons,
    risks,
    alternatives: roleAlternatives.slice(0, 3).map((item) => ({
      id: item.player.id,
      name: item.player.nome,
      role: item.player.ruolo,
      projectedValue: rounded(item.value),
      estimatedCost: item.estimatedCost,
      valueGap: rounded(candidateValue - item.value),
    })),
    rolePlan,
    summary: {
      owner: ownerIndex,
      ownerName: team.name || `Squadra ${ownerIndex + 1}`,
      credits,
      rosterSize: team.roster?.length || 0,
      slotsOpen: openSlots,
      reservedCredits:
        Math.max(0, openSlots - 1) * rules.auction.reserve,
       candidateValue: rounded(candidateValue),
       individualMarginalValue: rounded(individualMarginalValue),
       defenseMarginalValue: rounded(defenseMarginalValue),
       defenseValueBefore: rounded(currentDefenseValue),
       defenseValueWithCandidate: rounded(candidateDefenseValue),
      replacementValue: rounded(replacement?.value),
      replacementRank: replacementIndex == null ? null : replacementIndex + 1,
      marginalValue: rounded(marginalValue),
      marketValueCap: valueCap,
      roleBudgetTarget: rounded(budgetPlan[player.ruolo].target),
      roleBudgetRemaining: rounded(budgetPlan[player.ruolo].remaining),
      roleBudgetCap: roleBidCap,
      sourceFvm: Number(sourceFvm(player).toFixed(2)),
      normalizedFvm: Number(valuation.normalizedFvm(player).toFixed(2)),
      outliers: valuation.outliersFor(player),
      baselineCompletionValue: baselineFeasible ? rounded(baselineValue) : null,
      completionValueAtMaxBid:
        withCandidate[credits - maxBid] > EMPTY / 2
          ? rounded(candidateValue + withCandidate[credits - maxBid])
          : null,
      estimatedMarketPrice: candidateCost,
      marketInflation: Number(market.inflation.toFixed(3)),
      roleInflation: Number(market.roleInflation[player.ruolo].toFixed(3)),
      roleScarcity: Number(scarcityInfo.ratio.toFixed(3)),
      opponentDemand: opponents.needing,
      opponentAffordable: opponents.affordable,
      deterministic: true,
      horizon: rules.horizons.currentLeague.label,
    },
  };
};

if (typeof self !== "undefined") {
  self.onmessage = ({ data }) =>
    self.postMessage(
      data?.mode === "overview"
        ? evaluateOverview(data)
        : evaluateAuction(data),
    );
}
