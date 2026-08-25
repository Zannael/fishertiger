"""Versioned, serializable league rules independent of application services."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, is_dataclass
from hashlib import sha256
import json
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
ROLES = ("P", "D", "C", "A")
TIE_BREAKERS = ("goal_difference", "head_to_head", "season_fantasy_score")
EXACT_TIE_POLICIES = ("shared_rank", "sequential_rank")
UNPLACED_POLICIES = ("no_payout",)
NOMINATION_POLICIES = ("call", "call_by_role", "random", "random_by_role", "alphabetical", "alphabetical_by_role")


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _positive(value: int | float, name: str, allow_zero: bool = False) -> None:
    _require(isinstance(value, (int, float)) and not isinstance(value, bool), f"{name} must be a number")
    _require(value >= 0 if allow_zero else value > 0, f"{name} must be {'non-negative' if allow_zero else 'positive'}")


@dataclass(frozen=True)
class SourceDeclaration:
    """A manifest entry; name is the source role and season labels history files."""
    name: str
    path: str
    format: str
    required: bool = True
    season: str | None = None

    def __post_init__(self) -> None:
        _require(bool(self.name.strip()), "source name is required")
        _require(bool(self.path.strip()), "source path is required")
        object.__setattr__(self, "path", self.path.replace("\\", "/"))
        _require(bool(self.format.strip()), "source format is required")
        _require(self.format.lower() in {"csv", "xlsx", "json"}, f"unsupported source format: {self.format}")
        if self.season is not None:
            _require(bool(self.season.strip()), "source season cannot be blank")


@dataclass(frozen=True)
class SeasonSelection:
    season: str
    serie_a_matchdays: int
    fantasy_matchdays: int
    fantasy_start_matchday: int
    fantasy_end_matchday: int

    def __post_init__(self) -> None:
        _require(bool(self.season.strip()), "season is required")
        _positive(self.serie_a_matchdays, "serie_a_matchdays")
        _require(isinstance(self.fantasy_start_matchday, int) and not isinstance(self.fantasy_start_matchday, bool), "fantasy_start_matchday must be an integer")
        _require(isinstance(self.fantasy_end_matchday, int) and not isinstance(self.fantasy_end_matchday, bool), "fantasy_end_matchday must be an integer")
        _require(1 <= self.fantasy_start_matchday <= self.fantasy_end_matchday <= self.serie_a_matchdays,
                 "fantasy matchday range must satisfy 1 <= start <= end <= serie_a_matchdays")
        object.__setattr__(self, "fantasy_matchdays", self.fantasy_end_matchday - self.fantasy_start_matchday + 1)


@dataclass(frozen=True)
class ParticipantConfig:
    team_names: tuple[str, ...]
    user_team: str

    def __post_init__(self) -> None:
        _require(len(self.team_names) >= 2, "at least two team names are required")
        _require(all(name.strip() for name in self.team_names), "team names cannot be blank")
        _require(len(set(self.team_names)) == len(self.team_names), "team names must be unique")
        _require(self.user_team in self.team_names, "user_team must be a team name")


@dataclass(frozen=True)
class CreditsConfig:
    starting: int
    entry_fee_eur: int

    def __post_init__(self) -> None:
        _positive(self.starting, "starting credits")
        _positive(self.entry_fee_eur, "entry_fee_eur", allow_zero=True)


@dataclass(frozen=True)
class RosterSlots:
    P: int = 3
    D: int = 8
    C: int = 8
    A: int = 6

    def __post_init__(self) -> None:
        for role, slots in asdict(self).items():
            _positive(slots, f"roster slot {role}")

    @property
    def total(self) -> int:
        return sum(asdict(self).values())


@dataclass(frozen=True)
class FormationConfig:
    allowed: tuple[str, ...]

    def __post_init__(self) -> None:
        _require(bool(self.allowed), "at least one formation is required")
        _require(len(set(self.allowed)) == len(self.allowed), "formations must be unique")
        for formation in self.allowed:
            try:
                defenders, midfielders, attackers = (int(value) for value in formation.split("-"))
            except (TypeError, ValueError):
                raise ValueError(f"invalid formation: {formation!r}") from None
            _require(defenders >= 2 and midfielders >= 1 and attackers >= 1, f"invalid formation: {formation!r}")
            _require(defenders + midfielders + attackers == 10, f"formation must field ten outfield players: {formation!r}")


@dataclass(frozen=True)
class BenchSwitchConfig:
    bench_roles: tuple[str, ...]
    mode: str
    max_substitutions: int

    def __post_init__(self) -> None:
        _require(self.mode in {"Basic", "Strict", "None"}, "switch mode must be Basic, Strict, or None")
        _require(all(role in ROLES for role in self.bench_roles), "bench roles must be P, D, C, or A")
        _positive(self.max_substitutions, "max_substitutions", allow_zero=True)


@dataclass(frozen=True)
class ScoringEventValues:
    goal: float
    assist: float
    yellow_card: float
    red_card: float
    own_goal: float
    goalkeeper_conceded_goal: float

    def __post_init__(self) -> None:
        _positive(self.goal, "goal value")
        _positive(self.assist, "assist value", allow_zero=True)
        _require(self.yellow_card <= 0 and self.red_card <= 0 and self.own_goal <= 0 and self.goalkeeper_conceded_goal <= 0,
                 "card, own-goal, and goalkeeper-conceded values must be non-positive")


@dataclass(frozen=True)
class VirtualGoalConfig:
    threshold: float
    step: float

    def __post_init__(self) -> None:
        _positive(self.threshold, "virtual goal threshold")
        _positive(self.step, "virtual goal step")


@dataclass(frozen=True)
class DefenseTier:
    minimum_average: float
    bonus: float

    def __post_init__(self) -> None:
        _positive(self.minimum_average, "defense tier minimum")
        _positive(self.bonus, "defense tier bonus", allow_zero=True)


@dataclass(frozen=True)
class DefenseModifierConfig:
    enabled: bool
    table_name: str
    required_defenders: int
    tiers: tuple[DefenseTier, ...]

    def __post_init__(self) -> None:
        _require(bool(self.table_name.strip()), "defense table_name is required")
        _positive(self.required_defenders, "required_defenders")
        _require(bool(self.tiers), "at least one defense tier is required")
        thresholds = tuple(t.minimum_average for t in self.tiers)
        _require(thresholds == tuple(sorted(thresholds)) and len(set(thresholds)) == len(thresholds), "defense tiers must have ascending unique thresholds")


@dataclass(frozen=True)
class StandingsConfig:
    win_points: int
    draw_points: int
    loss_points: int
    tie_breakers: tuple[str, ...]
    exact_tie_policy: str

    def __post_init__(self) -> None:
        _positive(self.win_points, "win_points", allow_zero=True)
        _positive(self.draw_points, "draw_points", allow_zero=True)
        _positive(self.loss_points, "loss_points", allow_zero=True)
        _require(self.win_points > self.draw_points >= self.loss_points, "standings points must satisfy win > draw >= loss")
        _require(bool(self.tie_breakers), "at least one tie breaker is required")
        _require(len(set(self.tie_breakers)) == len(self.tie_breakers), "tie_breakers must be unique")
        _require(all(rule in TIE_BREAKERS for rule in self.tie_breakers), "unsupported tie_breaker")
        _require(self.exact_tie_policy in EXACT_TIE_POLICIES, "unsupported exact_tie_policy")


@dataclass(frozen=True)
class PayoutPrize:
    rank: int
    amount_eur: int

    def __post_init__(self) -> None:
        _positive(self.rank, "payout rank")
        _positive(self.amount_eur, "payout amount", allow_zero=True)


@dataclass(frozen=True)
class PayoutPolicy:
    prizes: tuple[PayoutPrize, ...]
    unplaced_policy: str

    def __post_init__(self) -> None:
        ranks = tuple(prize.rank for prize in self.prizes)
        _require(bool(ranks) and ranks == tuple(range(1, len(ranks) + 1)), "payout prizes must cover consecutive ranks starting at 1")
        _require(self.unplaced_policy in UNPLACED_POLICIES, "unsupported unplaced_policy")


@dataclass(frozen=True)
class IncompleteLineupPolicy:
    policy: str
    score: float

    def __post_init__(self) -> None:
        _require(self.policy in {"zero_score", "forfeit", "allow_partial"}, "invalid incomplete lineup policy")
        _positive(self.score, "incomplete lineup score", allow_zero=True)
        _require(self.policy != "zero_score" or self.score == 0, "zero_score policy must use score zero")


@dataclass(frozen=True)
class RoleBudgetPercentages:
    P: float = 7
    D: float = 18
    C: float = 25
    A: float = 50

    def __post_init__(self) -> None:
        values = (self.P, self.D, self.C, self.A)
        for value in values:
            _positive(value, "role budget percentage", allow_zero=True)
        _require(abs(sum(values) - 100) < 1e-9, "role budget percentages must sum to 100")


@dataclass(frozen=True)
class AuctionPolicy:
    minimum_bid: int
    bid_increment: int
    reserve_credits_per_open_slot: int
    nomination_policy: str
    role_budget_percentages: RoleBudgetPercentages = field(default_factory=RoleBudgetPercentages)
    role_budget_flexibility_percent: float = 5

    def __post_init__(self) -> None:
        _positive(self.minimum_bid, "minimum_bid")
        _positive(self.bid_increment, "bid_increment")
        _positive(self.reserve_credits_per_open_slot, "reserve_credits_per_open_slot", allow_zero=True)
        _require(self.nomination_policy in NOMINATION_POLICIES, "unsupported nomination_policy")
        _positive(self.role_budget_flexibility_percent, "role_budget_flexibility_percent", allow_zero=True)
        _require(self.role_budget_flexibility_percent <= 100, "role budget flexibility cannot exceed 100")


@dataclass(frozen=True)
class LeagueProfile:
    profile_id: str
    name: str
    season: SeasonSelection
    current_sources: tuple[SourceDeclaration, ...]
    history_sources: tuple[SourceDeclaration, ...]
    participants: ParticipantConfig
    credits: CreditsConfig
    roster_slots: RosterSlots = field(default_factory=RosterSlots)
    formations: FormationConfig = field(default_factory=lambda: FormationConfig(("3-4-3",)))
    bench_switch: BenchSwitchConfig = field(default_factory=lambda: BenchSwitchConfig((), "None", 0))
    scoring: ScoringEventValues = field(default_factory=lambda: ScoringEventValues(3, 1, -.5, -1, -2, -1))
    virtual_goals: VirtualGoalConfig = field(default_factory=lambda: VirtualGoalConfig(66, 5))
    defense_modifier: DefenseModifierConfig = field(default_factory=lambda: DefenseModifierConfig(False, "none", 4, (DefenseTier(6, 0),)))
    standings: StandingsConfig = field(default_factory=lambda: StandingsConfig(3, 1, 0, TIE_BREAKERS, "shared_rank"))
    payouts: PayoutPolicy = field(default_factory=lambda: PayoutPolicy((PayoutPrize(1, 0),), "no_payout"))
    incomplete_lineup: IncompleteLineupPolicy = field(default_factory=lambda: IncompleteLineupPolicy("zero_score", 0))
    auction: AuctionPolicy = field(default_factory=lambda: AuctionPolicy(1, 1, 1, "call"))
    schema_version: int = SCHEMA_VERSION

    def __post_init__(self) -> None:
        _require(self.schema_version == SCHEMA_VERSION, f"unsupported schema_version: {self.schema_version}")
        _require(bool(self.profile_id.strip()), "profile_id is required")
        _require(bool(self.name.strip()), "profile name is required")
        _require(bool(self.current_sources), "at least one current source is required")
        _require(bool(self.history_sources), "at least one history source is required")
        _require(len({source.name for source in self.current_sources}) == len(self.current_sources), "current source names must be unique")
        _require(len({source.season or source.name for source in self.history_sources}) == len(self.history_sources), "history source seasons must be unique")
        _require(len(self.participants.team_names) >= len(self.payouts.prizes), "payout ranks cannot exceed participants")
        extra_formation = any(
            int(defenders) < 3 or int(midfielders) < 3
            for defenders, midfielders, _ in (formation.split("-") for formation in self.formations.allowed)
        )
        if not extra_formation:
            _require(self.bench_switch.max_substitutions <= len(self.bench_switch.bench_roles), "max_substitutions cannot exceed bench size")
        _require(self.roster_slots.P >= self.bench_switch.bench_roles.count("P"), "bench has more goalkeepers than roster")
        _require(self.roster_slots.total >= 11 + len(self.bench_switch.bench_roles), "roster cannot cover XI and bench")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def canonical_json(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"), ensure_ascii=True)

    @property
    def configuration_hash(self) -> str:
        return sha256(self.canonical_json().encode("utf-8")).hexdigest()

    def dump_json(self, path: str | Path | None = None, *, indent: int | None = 2) -> str:
        rendered = json.dumps(self.to_dict(), sort_keys=True, indent=indent, ensure_ascii=True) + "\n"
        if path is not None:
            Path(path).write_text(rendered, encoding="utf-8")
        return rendered

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "LeagueProfile":
        if not isinstance(value, dict):
            raise ValueError("profile JSON must contain an object")
        try:
            season = dict(value["season"])
            auction = dict(value["auction"])
            auction["nomination_policy"] = {"round_robin": "call"}.get(
                auction.get("nomination_policy"), auction.get("nomination_policy")
            )
            role_budgets = RoleBudgetPercentages(
                **auction.pop("role_budget_percentages", {})
            )
            auction.setdefault("role_budget_flexibility_percent", 5)
            # Profiles saved before the explicit range always represented days 1..N.
            season.setdefault("fantasy_start_matchday", 1)
            season.setdefault("fantasy_end_matchday", season["fantasy_matchdays"])
            return cls(
                profile_id=value["profile_id"], name=value["name"], schema_version=value["schema_version"],
                season=SeasonSelection(**season),
                current_sources=tuple(SourceDeclaration(**item) for item in value["current_sources"]),
                history_sources=tuple(SourceDeclaration(**item) for item in value["history_sources"]),
                participants=ParticipantConfig(team_names=tuple(value["participants"]["team_names"]), user_team=value["participants"]["user_team"]),
                credits=CreditsConfig(**value["credits"]), roster_slots=RosterSlots(**value["roster_slots"]),
                formations=FormationConfig(allowed=tuple(value["formations"]["allowed"])),
                bench_switch=BenchSwitchConfig(bench_roles=tuple(value["bench_switch"]["bench_roles"]), mode=value["bench_switch"]["mode"], max_substitutions=value["bench_switch"]["max_substitutions"]),
                scoring=ScoringEventValues(**value["scoring"]), virtual_goals=VirtualGoalConfig(**value["virtual_goals"]),
                defense_modifier=DefenseModifierConfig(enabled=value["defense_modifier"]["enabled"], table_name=value["defense_modifier"]["table_name"], required_defenders=value["defense_modifier"]["required_defenders"], tiers=tuple(DefenseTier(**item) for item in value["defense_modifier"]["tiers"])),
                standings=StandingsConfig(tie_breakers=tuple(value["standings"]["tie_breakers"]), **{key: item for key, item in value["standings"].items() if key != "tie_breakers"}),
                payouts=PayoutPolicy(prizes=tuple(PayoutPrize(**item) for item in value["payouts"]["prizes"]), unplaced_policy=value["payouts"]["unplaced_policy"]),
                incomplete_lineup=IncompleteLineupPolicy(**value["incomplete_lineup"]), auction=AuctionPolicy(role_budget_percentages=role_budgets, **auction),
            )
        except (KeyError, TypeError) as error:
            raise ValueError(f"invalid league profile: {error}") from error

    @classmethod
    def load_json(cls, path: str | Path) -> "LeagueProfile":
        try:
            return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid league profile JSON: {error}") from error
