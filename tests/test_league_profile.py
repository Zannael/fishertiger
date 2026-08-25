import json
from pathlib import Path

import pytest

from advisor.league_profile import LeagueProfile, NOMINATION_POLICIES, SourceDeclaration, TIE_BREAKERS


PROFILE_PATH = Path(__file__).parents[1] / "config" / "default_profile.json"


def test_default_profile_loads_and_matches_current_league_rules():
    profile = LeagueProfile.load_json(PROFILE_PATH)

    assert profile.profile_id == "example-2026-27"
    assert profile.participants.team_names == tuple(
        f"Squadra {index}" for index in range(1, 9)
    )
    assert profile.season.serie_a_matchdays == 38
    assert profile.season.fantasy_matchdays == 36
    assert (profile.season.fantasy_start_matchday, profile.season.fantasy_end_matchday) == (1, 36)
    assert profile.roster_slots.total == 25
    assert profile.scoring.goalkeeper_conceded_goal == -1
    assert profile.standings.tie_breakers == TIE_BREAKERS
    assert profile.auction.nomination_policy == "call"
    assert profile.auction.role_budget_percentages.P == 7
    assert profile.auction.role_budget_percentages.D == 18
    assert profile.auction.role_budget_percentages.C == 25
    assert profile.auction.role_budget_percentages.A == 50
    assert profile.auction.role_budget_flexibility_percent == 5
    assert profile.configuration_hash == LeagueProfile.from_dict(profile.to_dict()).configuration_hash


def test_json_round_trip_is_canonical_and_hash_is_content_sensitive(tmp_path):
    profile = LeagueProfile.load_json(PROFILE_PATH)
    output = tmp_path / "profile.json"

    assert json.loads(profile.dump_json(output)) == json.loads(profile.canonical_json())
    assert LeagueProfile.load_json(output) == profile

    changed = profile.to_dict()
    changed["credits"]["starting"] = 751
    assert LeagueProfile.from_dict(changed).configuration_hash != profile.configuration_hash


def test_validation_rejects_invalid_profile_rules():
    value = json.loads(PROFILE_PATH.read_text())
    value["season"]["fantasy_end_matchday"] = 39
    with pytest.raises(ValueError, match="range"):
        LeagueProfile.from_dict(value)
    value = json.loads(PROFILE_PATH.read_text())
    value["participants"]["user_team"] = "Unknown"
    with pytest.raises(ValueError, match="user_team"):
        LeagueProfile.from_dict(value)


def test_auction_nomination_policies_and_legacy_round_robin_are_supported():
    value = json.loads(PROFILE_PATH.read_text())
    assert NOMINATION_POLICIES == ("call", "call_by_role", "random", "random_by_role", "alphabetical", "alphabetical_by_role")
    for policy in NOMINATION_POLICIES:
        value["auction"]["nomination_policy"] = policy
        assert LeagueProfile.from_dict(value).auction.nomination_policy == policy
    value["auction"]["nomination_policy"] = "round_robin"
    assert LeagueProfile.from_dict(value).auction.nomination_policy == "call"


def test_legacy_auction_uses_default_role_budgets():
    value = json.loads(PROFILE_PATH.read_text())
    del value["auction"]["role_budget_percentages"]
    del value["auction"]["role_budget_flexibility_percent"]

    profile = LeagueProfile.from_dict(value)

    assert (
        profile.auction.role_budget_percentages.P,
        profile.auction.role_budget_percentages.D,
        profile.auction.role_budget_percentages.C,
        profile.auction.role_budget_percentages.A,
    ) == (7, 18, 25, 50)
    assert profile.auction.role_budget_flexibility_percent == 5


def test_role_budgets_must_sum_to_one_hundred():
    value = json.loads(PROFILE_PATH.read_text())
    value["auction"]["role_budget_percentages"]["A"] = 49

    with pytest.raises(ValueError, match="sum to 100"):
        LeagueProfile.from_dict(value)

@pytest.mark.parametrize("path, invalid", [
    (("standings", "exact_tie_policy"), "other"),
    (("standings", "tie_breakers"), ["unknown"]),
    (("payouts", "unplaced_policy"), "other"),
    (("auction", "nomination_policy"), "other"),
])
def test_validation_rejects_unsupported_policy_values(path, invalid):
    value = json.loads(PROFILE_PATH.read_text())
    value[path[0]][path[1]] = invalid

    with pytest.raises(ValueError, match="unsupported"):
        LeagueProfile.from_dict(value)


def test_validation_rejects_points_as_a_tie_breaker():
    value = json.loads(PROFILE_PATH.read_text())
    value["standings"]["tie_breakers"] = ["points"]

    with pytest.raises(ValueError, match="unsupported"):
        LeagueProfile.from_dict(value)


def test_extra_formations_are_accepted_without_bench_role_capacity_limit():
    value = json.loads(PROFILE_PATH.read_text())
    value["formations"]["allowed"] = [
        "2-1-7", "2-2-6", "2-3-5", "2-4-4", "2-5-3", "2-6-2", "2-7-1",
        "3-1-6", "3-2-5", "3-3-4", "3-6-1", "4-1-5", "4-2-4", "5-1-4",
        "5-2-3", "6-1-3", "6-2-2", "6-3-1",
    ]
    value["bench_switch"]["bench_roles"] = ["P"]
    value["bench_switch"]["max_substitutions"] = 3

    profile = LeagueProfile.from_dict(value)

    assert profile.formations.allowed == tuple(value["formations"]["allowed"])


@pytest.mark.parametrize("formation", ["1-4-5", "2-0-8", "2-1-6-1", "2-1-6"])
def test_formation_validation_keeps_component_and_minimum_requirements(formation):
    value = json.loads(PROFILE_PATH.read_text())
    value["formations"]["allowed"] = [formation]

    with pytest.raises(ValueError, match="formation"):
        LeagueProfile.from_dict(value)


def test_legacy_profile_range_defaults_to_matchdays_count():
    value = json.loads(PROFILE_PATH.read_text())
    del value["season"]["fantasy_start_matchday"]
    del value["season"]["fantasy_end_matchday"]

    profile = LeagueProfile.from_dict(value)

    assert (profile.season.fantasy_start_matchday, profile.season.fantasy_end_matchday) == (1, 36)


def test_legacy_mvp_configuration_is_ignored():
    value = json.loads(PROFILE_PATH.read_text())
    value["mvp"] = {"enabled": True, "bonus": 999, "selection": "highest_pure_vote"}

    profile = LeagueProfile.from_dict(value)

    assert "mvp" not in profile.to_dict()


def test_source_paths_are_stored_with_posix_separators():
    """A profile exported from Windows must resolve on a POSIX host."""
    windows = SourceDeclaration(
        name="league_calendar",
        path=r"data\uploads\my-league\current_sources\league_calendar.xlsx",
        format="xlsx",
    )
    assert windows.path == "data/uploads/my-league/current_sources/league_calendar.xlsx"

    unchanged = SourceDeclaration(name="teams", path="data/raw/squadre.csv", format="csv")
    assert unchanged.path == "data/raw/squadre.csv"


def test_a_profile_round_trips_through_json_with_portable_paths(tmp_path):
    profile = LeagueProfile.load_json(PROFILE_PATH)
    exported = tmp_path / "exported.json"
    profile.dump_json(exported)

    reimported = LeagueProfile.load_json(exported)
    assert reimported.to_dict() == profile.to_dict()
    assert reimported.configuration_hash == profile.configuration_hash
    assert all(
        "\\" not in source.path
        for source in (*reimported.current_sources, *reimported.history_sources)
    )
