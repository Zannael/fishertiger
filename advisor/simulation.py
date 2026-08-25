"""Reproducible season-level Monte Carlo for the configured Classic league."""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any

import numpy as np

from .config import LeagueConfig
from .defense import defense_modifier

@dataclass(frozen=True)
class SimulationResult:
    iterations: int
    teams: dict[str, dict[str, float | list[float]]]
    scenarios: dict[str, dict[str, float | int]]
    diagnostics: dict[str, float]


def make_sample_rosters(payload: dict[str, Any], league: LeagueConfig = LeagueConfig()) -> dict[str, list[int]]:
    """Build balanced, non-overlapping rosters using the configured slots."""
    names = _calendar_teams(payload)
    if len(names) != league.participants:
        raise ValueError(f"Expected {league.participants} fantasy teams in the league calendar")
    players = payload["players"]
    rosters = {name: [] for name in names}
    used: set[int] = set()
    for role_index, (role, slots) in enumerate(league.roster_slots.items()):
        candidates = sorted((p for p in players if p["ruolo"] == role), key=lambda p: p["fvm_scaled"], reverse=True)
        required = len(names) * slots
        if len(candidates) < required:
            raise ValueError(f"Not enough {role} players to create sample rosters")
        # Each role is distributed in snake rounds so every sample team receives
        # a comparable blend of high and medium projections.
        base_order = names[role_index:] + names[:role_index]
        for slot_round in range(slots):
            order = base_order if slot_round % 2 == 0 else list(reversed(base_order))
            for owner, player in zip(order, candidates[slot_round * len(names):(slot_round + 1) * len(names)]):
                rosters[owner].append(player["id"])
                used.add(player["id"])
    return rosters


def validate_rosters(rosters: dict[str, list[int]], players: dict[int, dict[str, Any]], league: LeagueConfig) -> None:
    assigned: set[int] = set()
    for team, roster in rosters.items():
        if len(roster) != sum(league.roster_slots.values()):
            raise ValueError(f"{team}: invalid roster size")
        if len(set(roster)) != len(roster) or assigned.intersection(roster):
            raise ValueError(f"{team}: duplicate player within or across rosters")
        assigned.update(roster)
        for role, count in league.roster_slots.items():
            if sum(players[player_id]["ruolo"] == role for player_id in roster) != count:
                raise ValueError(f"{team}: invalid {role} count")


def _formation_counts(formation: str) -> dict[str, int]:
    defenders, midfielders, attackers = (int(value) for value in formation.split("-"))
    return {"P": 1, "D": defenders, "C": midfielders, "A": attackers}


def _choose_lineup(available: list[dict[str, Any]], league: LeagueConfig) -> list[dict[str, Any]]:
    """Choose the highest expected legal XI; used both pre-lineup and for Basic replacements."""
    by_role: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for player in available:
        by_role[player["ruolo"]].append(player)
    for role in by_role:
        by_role[role].sort(key=lambda player: player["selection_value"], reverse=True)
    best: list[dict[str, Any]] = []
    best_value = -float("inf")
    for formation in league.allowed_formations:
        counts = _formation_counts(formation)
        if any(len(by_role[role]) < count for role, count in counts.items()):
            continue
        lineup = [player for role, count in counts.items() for player in by_role[role][:count]]
        value = sum(player["selection_value"] for player in lineup)
        if value > best_value:
            best, best_value = lineup, value
    return best


def _draw_outcome(player: dict[str, Any], day_index: int, rng: np.random.Generator, team_factor: float) -> dict[str, Any]:
    probability = player["p_gioca_per_giornata"][day_index]
    outcome = {"id": player["id"], "ruolo": player["ruolo"], "selection_value": probability * (player["voto_puro_mean_per_giornata"][day_index] + player["bonus_atteso_per_giornata"][day_index]), "plays": bool(rng.random() < probability)}
    if not outcome["plays"]:
        return outcome
    pure_vote = float(np.clip(rng.normal(player["voto_puro_mean_per_giornata"][day_index] + team_factor, player["voto_puro_std_per_giornata"][day_index]), 4, 10))
    rates = player.get("event_rates", {})
    goals = rng.poisson(max(0, rates.get("gol", 0)))
    assists = rng.poisson(max(0, rates.get("assist", 0)))
    yellow = rng.poisson(max(0, rates.get("ammonizioni", 0)))
    red = rng.poisson(max(0, rates.get("espulsioni", 0)))
    own_goals = rng.poisson(max(0, rates.get("autogol", 0)))
    conceded = rng.poisson(max(0, rates.get("gol_subiti", 0))) if player["ruolo"] == "P" else 0
    outcome.update({"pure": pure_vote, "events": (goals, assists, yellow, red, own_goals, conceded), "fantavote": pure_vote + goals * 3 + assists - yellow * .5 - red - own_goals * 2 - conceded, "selection_value": pure_vote + player["bonus_atteso_per_giornata"][day_index]})
    return outcome


def _series_a_factors(payload: dict[str, Any], serie_day: int, rng: np.random.Generator) -> dict[str, float]:
    factors: dict[str, float] = {}
    for fixture in payload["calendario_serie_a"]:
        if int(fixture["matchday"]) != serie_day:
            continue
        quality = rng.normal(0, .16)
        factors[fixture["home_team"]] = quality
        factors[fixture["away_team"]] = -quality
    return factors


def _team_score(roster: list[int], players: dict[int, dict[str, Any]], day_index: int, factors: dict[str, float], rng: np.random.Generator, league: LeagueConfig) -> tuple[float, list[dict[str, Any]]]:
    pre_lineup = []
    for player_id in roster:
        player = players[player_id]
        probability = player["p_gioca_per_giornata"][day_index]
        pre_lineup.append({"id": player_id, "ruolo": player["ruolo"], "selection_value": probability * (player["voto_puro_mean_per_giornata"][day_index] + player["bonus_atteso_per_giornata"][day_index])})
    starters = _choose_lineup(pre_lineup, league)
    starter_ids = {player["id"] for player in starters}
    bench_pool = [player for player in pre_lineup if player["id"] not in starter_ids]
    bench_limits = Counter(league.bench_roles)
    bench = [
        player
        for role, limit in bench_limits.items()
        for player in sorted(
            (candidate for candidate in bench_pool if candidate["ruolo"] == role),
            key=lambda candidate: candidate["selection_value"],
            reverse=True,
        )[:limit]
    ]
    drawn = {player_id: _draw_outcome(players[player_id], day_index, rng, factors.get(players[player_id]["squadra"], 0)) for player_id in roster}
    for outcome in drawn.values():
        if "events" in outcome:
            goals, assists, yellow, red, own_goals, conceded = outcome["events"]
            outcome["fantavote"] = outcome["pure"] + goals * league.scoring_goal + assists * league.scoring_assist + yellow * league.scoring_yellow_card + red * league.scoring_red_card + own_goals * league.scoring_own_goal + conceded * league.scoring_goalkeeper_conceded_goal
    playing_starters = [drawn[player["id"]] for player in starters if drawn[player["id"]]["plays"]]
    replacements = []
    if league.switch_mode == "None":
        bench = []
    for role, limit in bench_limits.items():
        if len(replacements) >= league.max_substitutions:
            break
        missing = sum(player["ruolo"] == role for player in starters) - sum(player["ruolo"] == role for player in playing_starters)
        available = [
            drawn[player["id"]]
            for player in bench
            if player["ruolo"] == role and drawn[player["id"]]["plays"]
        ]
        replacements.extend(available[:min(missing, limit, league.max_substitutions - len(replacements))])
    final_lineup = playing_starters + replacements
    partial_lineup = final_lineup
    if len(final_lineup) != 11:
        if league.incomplete_lineup_policy in {"zero_score", "forfeit"}:
            return league.incomplete_lineup_score, final_lineup
        # allow_partial intentionally preserves points from players who received a vote.
        return sum(player["fantavote"] for player in partial_lineup), partial_lineup
    score = sum(player["fantavote"] for player in final_lineup)
    keeper = next((player["pure"] for player in final_lineup if player["ruolo"] == "P"), None)
    defender_votes = [player["pure"] for player in final_lineup if player["ruolo"] == "D"]
    if league.defense_modifier_enabled:
        score += defense_modifier(keeper, defender_votes, league.defense_table, league.defense_tiers, league.defense_required_defenders)
    return score, final_lineup


def _goals(score: float, league: LeagueConfig) -> int:
    return 0 if score < league.score_threshold else 1 + int((score - league.score_threshold) // league.points_per_virtual_goal)


def _require_league_calendar(payload: dict[str, Any]) -> Any:
    """Season simulation needs fixtures; fail with a readable message when absent."""
    calendar = payload.get("calendario_lega")
    if not calendar:
        raise ValueError("The league calendar is required to simulate a season. Upload calendario_lega and regenerate the dataset.")
    return calendar


def _calendar_teams(payload: dict[str, Any]) -> list[str]:
    calendar = _require_league_calendar(payload)
    if isinstance(calendar, dict):
        return list(calendar["teams"])
    return sorted({fixture["home_team"] for fixture in calendar} | {fixture["away_team"] for fixture in calendar})


def _calendar_matchdays(payload: dict[str, Any]) -> dict[int, list[dict[str, Any]]]:
    calendar = _require_league_calendar(payload)
    if isinstance(calendar, dict):
        return {day["number"]: [{"home_team": fixture["home"], "away_team": fixture["away"], "serie_a_matchday": day["serie_a_matchday"]} for fixture in day["fixtures"]] for day in calendar["matchdays"]}
    fixtures: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for fixture in calendar:
        fixtures[int(fixture["league_matchday"])].append(fixture)
    return fixtures


def _standing_keys(
    names: list[str],
    points: dict[str, int],
    goals_for: dict[str, int],
    goals_against: dict[str, int],
    season_scores: dict[str, float],
    direct_points: dict[str, dict[str, int]],
    tie_breakers: tuple[str, ...],
) -> dict[str, tuple[int | float, ...]]:
    """Build points-first keys; head-to-head only counts matches inside each points tie group."""
    head_to_head = {
        name: sum(score for opponent, score in direct_points[name].items() if points[opponent] == points[name])
        for name in names
    }
    values = {
        "goal_difference": {name: goals_for[name] - goals_against[name] for name in names},
        "head_to_head": head_to_head,
        "season_fantasy_score": season_scores,
    }
    return {
        name: (points[name], *(values[rule][name] for rule in tie_breakers))
        for name in names
    }


def simulate_season(payload: dict[str, Any], rosters: dict[str, list[int]], iterations: int = 2000, seed: int = 202627, league: LeagueConfig | None = None) -> SimulationResult:
    """Simulate the configured calendar and return rank, payout, score and points distributions."""
    league = league or LeagueConfig()
    players = {player["id"]: player for player in payload["players"]}
    validate_rosters(rosters, players, league)
    fixtures_by_day = _calendar_matchdays(payload)
    expected_days = set(range(1, len(fixtures_by_day) + 1))
    if set(fixtures_by_day) != expected_days:
        raise ValueError("League calendar matchdays must be consecutive starting at 1")
    rng = np.random.default_rng(seed)
    names = list(rosters)
    ranks = {name: np.zeros(league.participants, dtype=int) for name in names}
    utilities = {name: [] for name in names}
    points_outcomes = {name: [] for name in names}
    score_outcomes = {name: [] for name in names}
    scenarios = {name: {"best_score": -float("inf"), "worst_score": float("inf")} for name in names}
    for _ in range(iterations):
        points = {name: 0 for name in names}
        goals_for = {name: 0 for name in names}
        goals_against = {name: 0 for name in names}
        direct_points = {name: {opponent: 0 for opponent in names if opponent != name} for name in names}
        season_scores = {name: 0.0 for name in names}
        for league_day in sorted(fixtures_by_day):
            serie_day = int(fixtures_by_day[league_day][0]["serie_a_matchday"])
            factors = _series_a_factors(payload, serie_day, rng)
            scores, lineups = {}, {}
            for name in names:
                scores[name], lineups[name] = _team_score(rosters[name], players, serie_day - 1, factors, rng, league)
            for fixture in fixtures_by_day[league_day]:
                home, away = fixture["home_team"], fixture["away_team"]
                home_goals, away_goals = _goals(scores[home], league), _goals(scores[away], league)
                goals_for[home] += home_goals; goals_against[home] += away_goals
                goals_for[away] += away_goals; goals_against[away] += home_goals
                if home_goals > away_goals:
                    home_points, away_points = league.win_points, league.loss_points
                elif away_goals > home_goals:
                    home_points, away_points = league.loss_points, league.win_points
                else:
                    home_points = away_points = league.draw_points
                points[home] += home_points; points[away] += away_points
                direct_points[home][away] += home_points; direct_points[away][home] += away_points
            for name in names:
                season_scores[name] += scores[name]
        standing_keys = _standing_keys(names, points, goals_for, goals_against, season_scores, direct_points, league.tie_breakers)
        ordered = sorted(names, key=standing_keys.__getitem__, reverse=True)
        previous_key = None
        shared_rank = 0
        for rank, name in enumerate(ordered):
            standing_key = standing_keys[name]
            if league.exact_tie_policy == "shared_rank" and standing_key == previous_key:
                effective_rank = shared_rank
            else:
                effective_rank = rank
                shared_rank = rank
            previous_key = standing_key
            ranks[name][effective_rank] += 1
            utilities[name].append(league.net_utilities_eur[effective_rank] if effective_rank < len(league.payouts) else -league.entry_fee_eur)
            points_outcomes[name].append(points[name])
            score_outcomes[name].append(season_scores[name])
            if season_scores[name] > scenarios[name]["best_score"]:
                scenarios[name].update({"best_score": round(season_scores[name], 2), "best_points": points[name], "best_rank": effective_rank + 1})
            if season_scores[name] < scenarios[name]["worst_score"]:
                scenarios[name].update({"worst_score": round(season_scores[name], 2), "worst_points": points[name], "worst_rank": effective_rank + 1})
    summary = {}
    for name in names:
        summary[name] = {"rank_probabilities": (ranks[name] / iterations).round(4).tolist(), "top3_probability": round(float(ranks[name][:3].sum() / iterations), 4), "expected_utility": round(float(np.mean(utilities[name])), 2), "expected_points": round(float(np.mean(points_outcomes[name])), 2), "expected_score": round(float(np.mean(score_outcomes[name])), 2), "score_p05": round(float(np.quantile(score_outcomes[name], .05)), 2), "score_p95": round(float(np.quantile(score_outcomes[name], .95)), 2)}
    return SimulationResult(iterations=iterations, teams=summary, scenarios=scenarios, diagnostics={"matchdays": len(fixtures_by_day), "seed": seed})
