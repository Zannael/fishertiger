import json
from pathlib import Path

import pandas as pd
import pytest

from advisor.league_profile import LeagueProfile
from advisor.pipeline import _clean_record, _json_safe, anonymize_public_calendar, build_projections, fixture_projection_arrays, normalize, vote_standard_deviation, weighted_history, weighted_rate_per_appearance


def history(mv: float, appearances: int, goals: int = 0) -> pd.DataFrame:
    return pd.DataFrame([{"Id": 1, "Mv": mv, "Pv": appearances, "Gf": goals}])


def test_vote_history_ignores_seasons_without_appearances():
    histories = [history(6.0, 10), history(7.0, 10), history(0.0, 0)]

    result = weighted_history(1, histories, "Mv", weights=(0.6, 0.3, 0.1))

    assert result == pytest.approx(6.75)


def test_configurable_weights_are_used_for_history_and_rates():
    histories = [history(6.0, 10, 1), history(7.0, 10, 2), history(8.0, 10, 4)]

    assert weighted_history(1, histories, "Mv", weights=(1.0, 0.0, 0.0)) == 8.0
    assert weighted_rate_per_appearance(1, histories, "Gf", weights=(1.0, 0.0, 0.0)) == pytest.approx(0.48)


def test_vote_deviation_excludes_zero_appearance_seasons():
    histories = [history(0.0, 0), history(6.0, 8), history(6.4, 8)]

    assert vote_standard_deviation(1, histories, default=0.85) == 0.35


def test_vote_deviation_is_capped_at_role_default():
    histories = [history(4.0, 10), history(8.0, 10)]

    assert vote_standard_deviation(1, histories, default=0.85) == 0.85


def test_clean_record_converts_blank_csv_cells_to_json_null():
    result = _clean_record({"status": "TITOLARE", "nota": float("nan")})

    assert result == {"status": "TITOLARE", "nota": None}


def test_generation_without_league_calendar_writes_strict_json(tmp_path):
    root = Path(__file__).parents[1]
    source = json.loads((root / "config/default_profile.json").read_text(encoding="utf-8"))
    calendar = next(item for item in source["current_sources"] if item["name"] == "league_calendar")
    calendar["path"] = str(tmp_path / "missing-calendar.xlsx")

    payload = build_projections(
        raw=root / "data/raw",
        output=tmp_path / "processed",
        profile=LeagueProfile.from_dict(source),
    )

    serialized = (tmp_path / "processed/example-2026-27/2026-27/auction_data.json").read_text(encoding="utf-8")
    decoded = json.loads(serialized, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    assert payload["calendario_lega"] is None
    assert decoded["calendario_lega"] is None


def test_json_safe_converts_non_finite_values_in_nested_payloads():
    result = _json_safe({"projection": [float("nan"), float("inf"), 6.5]})

    assert result == {"projection": [None, None, 6.5]}
    json.dumps(result, allow_nan=False)


def test_fixture_projections_vary_by_opponent_venue_and_rotation():
    team = pd.Series({"rating_att": 8.0, "rating_dif": 7.0, "coppa_europea": "Champions"})
    teams = {
        normalize("Milan"): team,
        normalize("Strong"): pd.Series({"rating_att": 9.0, "rating_dif": 8.0}),
        normalize("Weak"): pd.Series({"rating_att": 3.0, "rating_dif": 3.0}),
    }
    fixtures = {
        1: {"matchday": 1, "opponent": "Strong", "venue": "TRASFERTA"},
        2: {"matchday": 2, "opponent": "Weak", "venue": "CASA"},
        3: {"matchday": 3, "opponent": "Strong", "venue": "CASA"},
        4: {"matchday": 4, "opponent": "Weak", "venue": "TRASFERTA"},
    }

    play, vote, std, bonus = fixture_projection_arrays(.72, 6.2, .8, .35, team, fixtures, teams, 4)

    for values, average in ((play, .72), (vote, 6.2), (std, .8), (bonus, .35)):
        assert len(values) == 4
        assert sum(values) / len(values) == pytest.approx(average)
        assert len(set(values)) > 1
    assert play[2] < play[1]  # European rotation offsets the home advantage on day 3.
    assert bonus[1] > bonus[0]


def test_fixture_projections_fall_back_to_flat_arrays_when_a_fixture_is_missing():
    team = pd.Series({"rating_att": 6.0, "rating_dif": 6.0, "coppa_europea": ""})
    fixtures = {1: {"matchday": 1, "opponent": "Opponent", "venue": "CASA"}}
    opponents = {normalize("Opponent"): pd.Series({"rating_att": 6.0, "rating_dif": 6.0})}

    arrays = fixture_projection_arrays(.7, 6.1, .8, .2, team, fixtures, opponents, 4)

    assert arrays == ([.7] * 4, [6.1] * 4, [.8] * 4, [.2] * 4)


def test_public_calendar_export_anonymizes_fantasy_team_names_and_ids():
    calendar = {
        "teams": ["Private team", "Another team"],
        "matchdays": [{"fixtures": [{"home": "Private team", "away": "Another team", "home_team_id": "private team", "away_team_id": "another team"}]}],
    }

    result = anonymize_public_calendar(calendar)

    assert result["teams"] == ["Squadra 1", "Squadra 2"]
    assert result["matchdays"][0]["fixtures"][0] == {
        "home": "Squadra 1", "away": "Squadra 2", "home_team_id": "squadra 1", "away_team_id": "squadra 2"
    }
    assert calendar["teams"] == ["Private team", "Another team"]
