from advisor.defense import defense_modifier, expected_defense_modifier


def test_modifier_requires_four_defenders():
    assert defense_modifier(7, [7, 7, 7]) == 0
    assert defense_modifier(None, [7, 7, 7, 7]) == 0


def test_modifier_uses_best_three_and_a_table_thresholds():
    assert defense_modifier(6.5, [6.0, 6.0, 6.5, 7.5], "A") == 3
    assert defense_modifier(6.49, [6.49, 6.49, 6.49, 6.49], "A") == 1


def test_league_modifier_table():
    assert defense_modifier(6.0, [6.0, 6.0, 6.0, 6.0], "LEAGUE") == 1
    assert defense_modifier(6.5, [6.5, 6.5, 6.5, 6.5], "LEAGUE") == 2
    assert defense_modifier(7.0, [7.0, 7.0, 7.0, 7.0], "LEAGUE") == 3


def test_modifier_uses_only_the_best_three_of_five_defenders():
    assert defense_modifier(4.0, [5.0, 6.0, 6.0, 6.0, 10.0], "LEAGUE") == 2


def test_modifier_selects_the_highest_reached_custom_tier():
    tiers = ((6.0, 1), (6.25, 2), (6.5, 3))
    assert defense_modifier(6.5, [6.5, 6.5, 6.5, 5.0], tiers=tiers) == 3


def test_expected_modifier_weights_availability_of_an_eligible_lineup():
    assert expected_defense_modifier(
        (1.0, 6.0), [(0.5, 6.0)] * 4, "LEAGUE"
    ) == 0.0625
