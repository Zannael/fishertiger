"""Pure functions for the configured defensive modifier."""

TABLES = {
    # League setting: [6, 6.5) = 1; [6.5, 7) = 2; >= 7 = 3.
    "LEAGUE": ((6.0, 1), (6.5, 2), (7.0, 3)),
    # Default Fantacalcio-style wide bands. Confirm these against the league before use.
    "A": ((6.0, 1), (6.5, 3), (7.0, 5), (7.5, 6)),
    # Progressive six-band fallback, retained as a separately selectable rule.
    "B": ((6.0, 1), (6.25, 2), (6.5, 3), (6.75, 4), (7.0, 5), (7.25, 6)),
}


def defense_modifier(goalkeeper_vote: float | None, defender_votes: list[float], table: str = "A", tiers: tuple[tuple[float, float], ...] | None = None, required_defenders: int = 4) -> float:
    """Return zero unless a keeper and at least four valid defender votes exist."""
    if goalkeeper_vote is None or len(defender_votes) < required_defenders:
        return 0
    average = (goalkeeper_vote + sum(sorted(defender_votes, reverse=True)[:3])) / 4
    bonus = 0
    for threshold, value in (tiers if tiers is not None else TABLES[table]):
        if average >= threshold:
            bonus = value
    return bonus


def expected_defense_modifier(
    goalkeeper: tuple[float, float] | None,
    defenders: list[tuple[float, float]],
    table: str = "A",
    tiers: tuple[tuple[float, float], ...] | None = None,
    required_defenders: int = 4,
) -> float:
    """Return the expected modifier across independent player availability draws."""
    if goalkeeper is None or len(defenders) < required_defenders:
        return 0
    goalkeeper_probability, goalkeeper_vote = goalkeeper
    expected = 0.0
    for mask in range(1 << len(defenders)):
        probability = goalkeeper_probability
        votes = []
        for index, (availability, vote) in enumerate(defenders):
            if mask & (1 << index):
                probability *= availability
                votes.append(vote)
            else:
                probability *= 1 - availability
        expected += probability * defense_modifier(
            goalkeeper_vote, votes, table, tiers, required_defenders
        )
    return expected
