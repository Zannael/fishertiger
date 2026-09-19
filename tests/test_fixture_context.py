import json
from pathlib import Path

import pytest

from advisor.fixture_context import (
    OFFICIAL_2026_27_DIGEST,
    FixtureContextError,
    build_fixture_rows,
    compare_calendars,
    merge_strengths,
    parse_match_context,
    read_calendar,
    strength_percentiles,
    validate_calendar,
)


CALENDAR = Path(__file__).parents[1] / "data/raw/calendario_2026_27.xlsx"


def test_real_calendar_has_complete_round_robin_and_matches_authority():
    rows = read_calendar(CALENDAR)
    result = validate_calendar(rows, rows, expected_digest=OFFICIAL_2026_27_DIGEST)
    assert result["fixtures"] == result["exact_matches"] == 380
    assert result["rounds"] == 38 and result["teams"] == 20
    assert result["mismatches"] == result["missing_fixtures"] == result["home_away_inversions"] == []


def test_calendar_duplicate_and_authoritative_mismatch_fail_closed():
    rows = read_calendar(CALENDAR)
    duplicate = [*rows[:-1], rows[0]]
    with pytest.raises(FixtureContextError, match="duplicate|exactly once"):
        validate_calendar(duplicate)
    official = [dict(row) for row in rows]
    official[0]["home_team"], official[0]["away_team"] = official[0]["away_team"], official[0]["home_team"]
    report = compare_calendars(rows, official)
    assert report["exact_matches"] == 379 and len(report["home_away_inversions"]) == 1
    with pytest.raises(FixtureContextError, match="Authoritative calendar mismatch"):
        validate_calendar(rows, official)


def match_html(*, status="EventScheduled", strengths=(("Roma", "8,30"), ("Inter", "9,00")), probability=(35, 28, 37), goals=(41, 59), market=True):
    event = {"@type": "SportsEvent", "eventStatus": f"https://schema.org/{status}", "homeTeam": {"name": "Roma"}, "awayTeam": {"name": "Inter"}}
    clubs = "".join(f"<div class='stp-club'><div class='stp-club__nome'>{team}</div><div class='stp-fnum'>{value}<span>/ 10</span></div><div class='stp-flab'>forza · mercati antepost di inizio stagione</div></div>" for team, value in strengths)
    quote = ""
    if market:
        boxes = "".join(f"<div class='stp-qbox'><div class='stp-qlab'>{label}</div><div class='stp-qval'>{odd}</div><div class='stp-qperc'>{pct}%</div></div>" for label, odd, pct in (("1 · Roma", "2,70", probability[0]), ("X · pareggio", "3,40", probability[1]), ("2 · Inter", "2,55", probability[2])))
        quote = f"<div class='stp-quote'><span class='stp-aggiorn'>aggiornate il 18 settembre alle 20:13</span>{boxes}<span class='stp-gol__meno'><b>meno di 3 gol</b> {goals[0]}%</span><span class='stp-gol__piu'><b>3 o più</b> {goals[1]}%</span></div>"
    return f"<html><head><title>Voti Roma-Inter - Serie A 2026/2027 - 5ª Giornata</title><script type='application/ld+json'>{json.dumps(event)}</script></head><body>{clubs}{quote}</body></html>"


def test_strength_and_current_bookmaker_contract():
    parsed = parse_match_context(match_html(), "2026/27", 5, "Roma", "Inter")
    assert [(row["team"], row["strength"]) for row in parsed["strengths"]] == [("Roma", 8.3), ("Inter", 9.0)]
    assert parsed["market"] == {"home_win_pct": 35.0, "draw_pct": 28.0, "away_win_pct": 37.0, "home_odds": 2.7, "draw_odds": 3.4, "away_odds": 2.55, "less_than_3_goals_pct": 41.0, "three_plus_goals_pct": 59.0, "observation_at": "2026-09-18T20:13:00+02:00"}
    assert parse_match_context(match_html(market=False), "2026/27", 5, "Roma", "Inter")["market"] is None
    assert parse_match_context(match_html(status="EventCompleted"), "2026/27", 5, "Roma", "Inter")["market"] is None
    with pytest.raises(FixtureContextError, match="approximately"):
        parse_match_context(match_html(probability=(50, 30, 30)), "2026/27", 5, "Roma", "Inter")


def test_strength_validation_conflicts_missing_drift_and_midrank_ties():
    contexts = [{"strengths": [{"team": f"T{i}", "normalized_team": f"t{i}", "strength": i / 2}]} for i in range(20)]
    assert len(merge_strengths(contexts)) == 20
    with pytest.raises(FixtureContextError, match="Expected 20"):
        merge_strengths(contexts[:-1])
    with pytest.raises(FixtureContextError, match="Conflicting"):
        merge_strengths([contexts[0], {"strengths": [{"team": "T0", "normalized_team": "t0", "strength": 2}]}], require_all=False)
    tied = [{"normalized_team": "a", "strength": 1}, {"normalized_team": "b", "strength": 1}, {"normalized_team": "c", "strength": 3}]
    assert strength_percentiles(tied) == {"a": 25.0, "b": 25.0, "c": 100.0}
    with pytest.raises(FixtureContextError, match="two expected"):
        parse_match_context(match_html(strengths=(("Roma", "8,30"),)), "2026/27", 5, "Roma", "Inter")


def test_fixture_rows_do_not_require_future_market_data():
    rows = read_calendar(CALENDAR)
    names = sorted({row[key] for row in rows for key in ("home_team", "away_team")})
    teams = [{"team": team, "normalized_team": team.lower(), "strength": index / 2} for index, team in enumerate(names)]
    fixtures = build_fixture_rows(rows, teams)
    assert len(fixtures) == 760 and all(row["market"] is None for row in fixtures)
