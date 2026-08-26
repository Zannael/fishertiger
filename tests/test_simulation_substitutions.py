import pytest

from advisor.config import LeagueConfig
from advisor import simulation


def _players():
    roles = {1: "P", 2: "D", 3: "D", 4: "D", 5: "D", 6: "C", 7: "C", 8: "C", 9: "C", 10: "A", 11: "A", 12: "A", 13: "A"}
    return {
        player_id: {
            "id": player_id,
            "ruolo": role,
            "squadra": "Club",
            "p_gioca_per_giornata": [1.0],
            "voto_puro_mean_per_giornata": [9.0 if player_id in {5, 13} else 10.0],
            "voto_puro_std_per_giornata": [0.0],
            "bonus_atteso_per_giornata": [0.0],
        }
        for player_id, role in roles.items()
    }


def _set_outcomes(monkeypatch, absent=()):
    def draw(player, day_index, rng, team_factor):
        if player["id"] in absent:
            return {"id": player["id"], "ruolo": player["ruolo"], "selection_value": 0.0, "plays": False}
        vote = 20.0 if player["id"] == 5 else (1.0 if player["id"] == 12 else 10.0)
        return {"id": player["id"], "ruolo": player["ruolo"], "selection_value": vote, "plays": True, "pure": vote, "fantavote": vote}

    monkeypatch.setattr(simulation, "_draw_outcome", draw)


def test_playing_starter_is_not_replaced_by_higher_scoring_bench_player(monkeypatch):
    _set_outcomes(monkeypatch)

    _, lineup = simulation._team_score(list(range(1, 14)), _players(), 0, {}, None, LeagueConfig(defense_modifier_enabled=False))

    assert {player["id"] for player in lineup} == {1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12}


def test_absent_starter_is_replaced_only_by_the_same_role(monkeypatch):
    _set_outcomes(monkeypatch, absent={12})

    _, lineup = simulation._team_score(list(range(1, 14)), _players(), 0, {}, None, LeagueConfig(defense_modifier_enabled=False))

    assert {player["id"] for player in lineup} == {1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13}


def test_lineup_selection_can_prefer_four_defenders_for_expected_modifier():
    available = [
        {"id": 1, "ruolo": "P", "availability": 1.0, "pure_vote": 7.0, "selection_value": 6.0},
        *[{"id": index, "ruolo": "D", "availability": 1.0, "pure_vote": 7.0, "selection_value": 6.0} for index in range(2, 6)],
        *[{"id": index, "ruolo": "C", "availability": 1.0, "pure_vote": 6.0, "selection_value": 6.4} for index in range(6, 10)],
        *[{"id": index, "ruolo": "A", "availability": 1.0, "pure_vote": 6.0, "selection_value": 6.0} for index in range(10, 14)],
    ]
    league = LeagueConfig(
        allowed_formations=("3-4-3", "4-3-3"),
        defense_modifier_enabled=True,
        defense_tiers=((6.0, 1.0),),
    )

    lineup = simulation._choose_lineup(available, league)

    assert sum(player["ruolo"] == "D" for player in lineup) == 4


@pytest.mark.parametrize("switch_mode", ("Basic", "Strict"))
def test_basic_and_strict_replace_an_absent_starter_with_the_same_role(monkeypatch, switch_mode):
    _set_outcomes(monkeypatch, absent={12})

    _, lineup = simulation._team_score(
        list(range(1, 14)), _players(), 0, {}, None,
        LeagueConfig(defense_modifier_enabled=False, switch_mode=switch_mode),
    )

    assert {player["id"] for player in lineup} == {1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13}


def test_none_disables_replacements(monkeypatch):
    _set_outcomes(monkeypatch, absent={12})

    score, lineup = simulation._team_score(
        list(range(1, 14)), _players(), 0, {}, None,
        LeagueConfig(defense_modifier_enabled=False, switch_mode="None", incomplete_lineup_policy="allow_partial"),
    )

    assert len(lineup) == 10
    assert score == 100


@pytest.mark.parametrize(
    ("policy", "incomplete_score", "expected"),
    (("zero_score", 0, 0), ("forfeit", 7, 7), ("allow_partial", 0, 100)),
)
def test_incomplete_lineup_policies_are_explicit(monkeypatch, policy, incomplete_score, expected):
    _set_outcomes(monkeypatch, absent={12})

    score, _ = simulation._team_score(
        list(range(1, 14)), _players(), 0, {}, None,
        LeagueConfig(
            defense_modifier_enabled=False,
            switch_mode="None",
            incomplete_lineup_policy=policy,
            incomplete_lineup_score=incomplete_score,
        ),
    )

    assert score == expected
