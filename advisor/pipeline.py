"""Validated data loading, team-scoped name matching, and player projections."""
from __future__ import annotations

import json
import argparse
import copy
import re
import unicodedata
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from rapidfuzz import fuzz

from .config import LeagueConfig, ModelConfig
from .league_calendar import preprocess_legacy_calendar, validate_calendar
from .league_profile import LeagueProfile
from .freshness import dataset_input_hash, source_fingerprints

RAW = Path("data/raw")
PROCESSED = Path("data/processed")
PROJECT_ROOT = Path(__file__).resolve().parents[1]
LISTONE_COLUMNS = {"Id", "R", "RM", "Nome", "Squadra", "Qt.A", "Qt.I", "Diff.", "Qt.A M", "Qt.I M", "Diff.M", "FVM", "FVM M"}
STATS_COLUMNS = {"Id", "R", "Rm", "Nome", "Squadra", "Pv", "Mv", "Fm", "Gf", "Gs", "Rp", "Rc", "R+", "R-", "Ass", "Amm", "Esp", "Au"}
MATCH_COLUMNS = {"match_id", "season", "matchday", "match_date", "leg", "home_team", "away_team", "home_goals", "away_goals", "played", "source_sheet"}

# Fixture model coefficients. Ratings are the 1--10 attack/defence priors in
# squadre.csv; daily signals are centred, so these redistribute rather than
# alter the season projection.
FIXTURE_HOME_PLAY_EFFECT = 0.025
FIXTURE_STRENGTH_PLAY_EFFECT = 0.009
FIXTURE_HOME_VOTE_EFFECT = 0.035
FIXTURE_DEFENCE_VOTE_EFFECT = 0.018
FIXTURE_HOME_BONUS_EFFECT = 0.045
FIXTURE_ATTACK_BONUS_EFFECT = 0.055
FIXTURE_AWAY_STD_EFFECT = 0.025
FIXTURE_OPPONENT_STD_EFFECT = 0.018
EUROPEAN_ROTATION_CYCLE = 3
EUROPEAN_ROTATION_PLAY_EFFECT = 0.070
EUROPEAN_ROTATION_BONUS_EFFECT = 0.020
DAILY_PLAY_BOUNDS = (0.05, 0.95)
DAILY_VOTE_BOUNDS = (4.0, 8.0)
DAILY_BONUS_BOUNDS = (-1.5, 2.5)
DAILY_STD_BOUNDS = (0.25, 1.5)


def normalize(value: object) -> str:
    value = unicodedata.normalize("NFKD", str(value).lower())
    value = "".join(c for c in value if not unicodedata.combining(c))
    # Preserve inner hyphens so compound surnames remain one token.
    value = re.sub(r"[^a-z0-9\s-]", "", value)
    return " ".join(value.split())


def _require_columns(frame: pd.DataFrame, required: set[str], source: str) -> None:
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"{source}: missing required columns {sorted(missing)}")


def _season_sort_key(label: str) -> tuple[int, int, str]:
    numbers = [int(value) for value in re.findall(r"\d+", label)]
    if not numbers:
        raise ValueError(f"history source season must contain a year: {label!r}")
    start = numbers[0]
    if start < 100:
        start += 2000
    return start, numbers[1] if len(numbers) > 1 else 0, label


def _resolve_source(source, raw: Path) -> Path:
    declared = Path(source.path)
    candidates = [declared] if declared.is_absolute() else [raw / declared, PROJECT_ROOT / declared, declared]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    if source.required:
        searched = ", ".join(str(candidate) for candidate in candidates)
        raise FileNotFoundError(f"Missing required source {source.name!r}; searched: {searched}")
    return candidates[0]


def _source_map(profile: LeagueProfile | None, raw: Path) -> dict[str, object]:
    if profile is None:
        return {}
    return {source.name: source for source in profile.current_sources}


def _required_source(sources: dict[str, object], name: str, raw: Path, fallback: str | None = None) -> Path:
    source = sources.get(name)
    if source:
        return _resolve_source(source, raw)
    if fallback is not None:
        return raw / fallback
    raise ValueError(f"profile current_sources must declare a {name!r} source")


def load_raw(raw: Path = RAW, profile: LeagueProfile | None = None) -> tuple[pd.DataFrame, list[tuple[str, pd.DataFrame]], pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    sources = _source_map(profile, raw)
    listone_path = _required_source(sources, "player_list", raw, "listone_2026_27.xlsx")
    listone = pd.read_excel(listone_path, sheet_name="Tutti", header=1)
    ceduti = pd.read_excel(listone_path, sheet_name="Ceduti", header=1)
    _require_columns(listone, LISTONE_COLUMNS, "listone")
    if listone.Id.isna().any() or listone.Id.duplicated().any():
        raise ValueError("listone: Id must be present and unique")
    _require_columns(ceduti, {"Id"}, "ceduti")
    history_sources = profile.history_sources if profile else tuple()
    if not history_sources:
        from .league_profile import SourceDeclaration
        history_sources = tuple(SourceDeclaration(f"stats_{year}", f"statistiche_{year}.xlsx", "xlsx", season=year.replace("_", "-")) for year in ("2023_24", "2024_25", "2025_26"))
    histories = []
    for source in sorted(history_sources, key=lambda item: _season_sort_key(item.season or item.name)):
        frame = pd.read_excel(_resolve_source(source, raw), sheet_name="Tutti", header=1)
        label = source.season or source.name
        _require_columns(frame, STATS_COLUMNS, f"history {label}")
        histories.append((label, frame))
    calendar = pd.read_excel(_required_source(sources, "serie_a_calendar", raw, "calendario_2026_27.xlsx"), sheet_name="matches")
    _require_columns(calendar, MATCH_COLUMNS, "calendario")
    if len(calendar) != 380 or not calendar.matchday.between(1, 38).all() or not (calendar.groupby("matchday").size() == 10).all():
        raise ValueError("calendario: expected 380 matches, ten for each matchday")
    teams = pd.read_csv(_required_source(sources, "teams", raw, "squadre.csv"))
    starters = pd.read_csv(_required_source(sources, "starters", raw, "titolari.csv"))
    set_pieces = pd.read_csv(_required_source(sources, "set_pieces", raw, "piazzati.csv"))
    for frame, cols, label in ((teams, {"squadra", "rating_att", "rating_dif", "coppa_europea"}, "squadre"), (starters, {"squadra", "nome", "id_fantacalcio", "status"}, "titolari"), (set_pieces, {"squadra", "nome", "tipo", "priorita"}, "piazzati")):
        _require_columns(frame, cols, label)
    return listone, histories, calendar, teams, starters, set_pieces, ceduti


def load_league_calendar(raw: Path = RAW) -> pd.DataFrame:
    """Legacy DataFrame API retained for callers that have not moved to JSON."""
    calendar = load_canonical_league_calendar(raw)
    return pd.DataFrame(
        {"league_matchday": day["number"], "serie_a_matchday": day["serie_a_matchday"],
         "home_team": fixture["home"], "away_team": fixture["away"]}
        for day in calendar["matchdays"] for fixture in day["fixtures"]
    ).sort_values(["league_matchday", "home_team"]).reset_index(drop=True)


def load_canonical_league_calendar(raw: Path = RAW, profile: LeagueProfile | None = None) -> dict | None:
    """Load canonical JSON, generating it from the legacy workbook only when needed."""
    declared = _source_map(profile, raw).get("league_calendar")
    source = _resolve_source(declared, raw) if declared else raw / "calendario_lega.json"
    if declared and not source.exists():
        return None
    if source.exists():
        if source.suffix.lower() == ".json":
            calendar = json.loads(source.read_text(encoding="utf-8"))
            validate_calendar(calendar)
        else:
            calendar = preprocess_legacy_calendar(source, profile.profile_id if profile else "legacy")
    else:
        legacy = raw / "calendario_lega.xlsx"
        if not legacy.exists():
            raise FileNotFoundError(f"Missing league fixture file: {legacy}")
        calendar = preprocess_legacy_calendar(legacy, profile.profile_id if profile else "legacy")
    if profile:
        expected = list(profile.participants.team_names)
        if set(calendar["teams"]) != set(expected):
            raise ValueError("league calendar teams must match profile participants")
        if len(calendar["matchdays"]) != profile.season.fantasy_matchdays:
            raise ValueError("league calendar matchdays must match profile fantasy_matchdays")
        matchdays = sorted(calendar["matchdays"], key=lambda day: day["number"])
        if [day["number"] for day in matchdays] != list(range(1, profile.season.fantasy_matchdays + 1)):
            raise ValueError("league calendar matchdays must be consecutive starting at 1")
        calendar = {
            **calendar,
            "teams": expected,
            "participants_count": len(expected),
            "league_id": profile.profile_id,
            "matchdays": [
                {**day, "serie_a_matchday": profile.season.fantasy_start_matchday + index}
                for index, day in enumerate(matchdays)
            ],
        }
    return calendar


def anonymize_public_calendar(calendar: dict) -> dict:
    """Replace local fantasy-team names before publishing a browser demo export."""
    public_calendar = copy.deepcopy(calendar)
    names = public_calendar.get("teams", [])
    replacements = {name: f"Squadra {index}" for index, name in enumerate(names, start=1)}
    replacement_ids = {normalize(name): normalize(replacement) for name, replacement in replacements.items()}
    public_calendar["teams"] = [replacements.get(name, name) for name in names]
    for matchday in public_calendar.get("matchdays", []):
        for fixture in matchday.get("fixtures", []):
            for field in ("home", "away"):
                if fixture.get(field) in replacements:
                    fixture[field] = replacements[fixture[field]]
            for field in ("home_team_id", "away_team_id"):
                if field in fixture:
                    fixture[field] = replacement_ids.get(fixture[field], fixture[field])
    return public_calendar


def load_identity_overrides(path: Path | None = None) -> dict[tuple[str, str, str], dict]:
    path = path or PROJECT_ROOT / "config" / "identity_overrides.json"
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid identity override archive {path}: {error}") from error
    entries = payload.get("overrides", []) if isinstance(payload, dict) else payload
    if not isinstance(entries, list):
        raise ValueError("identity override archive must be a list or contain an overrides list")
    result = {}
    for entry in entries:
        try:
            key = (str(entry["source"]), normalize(entry["name"]), normalize(entry["team"]))
            player_id = int(entry["id_fantacalcio"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"invalid identity override: {entry!r}") from error
        if not all(key) or key in result:
            raise ValueError(f"duplicate or incomplete identity override: {entry!r}")
        result[key] = {"id_fantacalcio": player_id, "confirmed": bool(entry.get("confirmed", False))}
    return result


def _validate_override(entry: pd.Series, source: str, override: dict, listone: pd.DataFrame) -> int:
    player_id = override["id_fantacalcio"]
    candidate = listone[listone.Id == player_id]
    if candidate.empty:
        raise ValueError(f"identity override for {source}:{entry.nome} references unknown Fantacalcio ID {player_id}")
    candidate = candidate.iloc[0]
    matches = normalize(entry.nome) == normalize(candidate.Nome) and normalize(entry.squadra) == normalize(candidate.Squadra)
    if not matches and not override["confirmed"]:
        raise ValueError(f"identity override for {source}:{entry.nome} / {entry.squadra} does not match canonical ID {player_id}; set confirmed=true to acknowledge it")
    return player_id


def match_manual(manual: pd.DataFrame, listone: pd.DataFrame, source: str, overrides: dict[tuple[str, str, str], dict] | None = None) -> pd.DataFrame:
    overrides = overrides or {}
    rows = []
    for _, entry in manual.iterrows():
        override = overrides.get((source, normalize(entry.nome), normalize(entry.squadra)))
        if override:
            rows.append([entry.nome, entry.squadra, _validate_override(entry, source, override, listone), 100.0, "override", source, None])
            continue
        team = normalize(entry.squadra)
        candidates = listone[listone.Squadra.map(normalize) == team]
        given_id = pd.to_numeric(pd.Series([entry.get("id_fantacalcio")]), errors="coerce").iloc[0]
        if pd.notna(given_id) and int(given_id) in set(listone.Id):
            rows.append([entry.nome, entry.squadra, int(given_id), 100.0, "manuale", source, None])
            continue
        query = normalize(entry.nome)
        best_id, score, best_ids = None, 0.0, []
        surname_counts = candidates.Nome.map(lambda name: normalize(name).split()[0] if normalize(name) else "").value_counts()
        for _, candidate in candidates.iterrows():
            candidate_name = normalize(candidate.Nome)
            parts = candidate_name.split()
            aliases = [candidate_name]
            query_aliases = [query]
            # Listone names are usually "Surname F." while manual input is "First Surname".
            if len(parts) == 2 and len(parts[1]) == 1:
                aliases.append(f"{parts[1]} {parts[0]}")
                if surname_counts.get(parts[0], 0) == 1:
                    aliases.append(parts[0])
            query_parts = query.split()
            if len(query_parts) > 1:
                query_aliases.append(f"{query_parts[0][0]} {' '.join(query_parts[1:])}")
            current = max(fuzz.token_sort_ratio(left, right) for left in query_aliases for right in aliases)
            if current > score:
                best_id, score, best_ids = int(candidate.Id), float(current), [int(candidate.Id)]
            elif current == score:
                best_ids.append(int(candidate.Id))
        method = "ambiguo" if score >= 90 and len(best_ids) > 1 else ("auto" if score >= 90 else "nessuno")
        diagnostic = "multiple equally scored candidates" if method == "ambiguo" else ("no confident candidate" if method == "nessuno" else None)
        rows.append([entry.nome, entry.squadra, best_id if method == "auto" else None, round(score, 1), method, source, diagnostic])
    return pd.DataFrame(rows, columns=["nome_originale", "squadra", "id_matched", "score", "metodo", "source", "diagnostic"])


def _history_weights(count: int, weights: tuple[float, ...]) -> tuple[float, ...]:
    if not weights:
        return (1.0,) * count
    return weights[:count] + (weights[-1],) * max(0, count - len(weights))


def weighted_history(player_id: int, histories: list[pd.DataFrame], column: str, default: float = 0.0, weights: tuple[float, ...] = (0.6, 0.3, 0.1)) -> float:
    values, used_weights = [], []
    requires_vote = column in {"Mv", "Fm"}
    # Input order is oldest to newest; weights must track newest observations.
    for frame, weight in zip(reversed(histories), _history_weights(len(histories), weights)):
        row = frame[frame.Id == player_id]
        if not row.empty and pd.notna(row.iloc[0][column]) and (not requires_vote or float(row.iloc[0].Pv) > 0):
            values.append(float(row.iloc[0][column]))
            used_weights.append(weight)
    return float(np.average(values, weights=used_weights)) if values else default


def weighted_rate_per_appearance(player_id: int, histories: list[pd.DataFrame], column: str, weights: tuple[float, ...] = (0.6, 0.3, 0.1)) -> float:
    """Weighted event rate conditioned on receiving a vote (75-minute estimate)."""
    values, used_weights = [], []
    for frame, weight in zip(reversed(histories), _history_weights(len(histories), weights)):
        row = frame[frame.Id == player_id]
        if not row.empty and pd.notna(row.iloc[0][column]) and float(row.iloc[0].Pv) > 0:
            values.append(float(row.iloc[0][column]) / float(row.iloc[0].Pv) / (75 / 90))
            used_weights.append(weight)
    return float(np.average(values, weights=used_weights)) if values else 0.0


def vote_standard_deviation(player_id: int, histories: list[pd.DataFrame], default: float) -> float:
    annual_means, appearances = [], 0.0
    for frame in histories:
        row = frame[frame.Id == player_id]
        if not row.empty and pd.notna(row.iloc[0].Mv) and pd.notna(row.iloc[0].Pv) and float(row.iloc[0].Pv) > 0:
            annual_means.append(float(row.iloc[0].Mv))
            appearances += float(row.iloc[0].Pv)
    if len(annual_means) <= 1 or appearances < 15:
        return default
    return float(np.clip(np.std(annual_means, ddof=1), .35, default))


def _clean_record(record: dict) -> dict:
    """Convert pandas scalar nulls to JSON nulls while retaining numeric values."""
    return {key: (None if pd.isna(value) else value) for key, value in record.items()}


def league_rules_payload(league: LeagueConfig) -> dict:
    """Serialize every simulation-relevant league rule into the processed dataset."""
    rules = {key: value for key, value in league.__dict__.items() if key not in {"payouts_eur"}}
    rules["roster_slots"] = league.roster_slots
    rules["net_utilities_eur"] = league.net_utilities_eur
    return rules


def _center_bounded(base: float, signals: list[float], bounds: tuple[float, float]) -> list[float]:
    """Apply zero-mean fixture signals without exceeding plausible limits."""
    if not signals:
        return []
    base = float(np.clip(base, *bounds))
    centered = np.asarray(signals, dtype=float) - np.mean(signals)
    amplitude = float(np.max(np.abs(centered)))
    if amplitude == 0:
        return [float(np.clip(base, *bounds))] * len(signals)
    scale = min(1.0, (base - bounds[0]) / -float(np.min(centered)), (bounds[1] - base) / float(np.max(centered)))
    return list(base + centered * scale)


def fixture_projection_arrays(
    p_play: float,
    mv: float,
    std: float,
    bonus: float,
    team: pd.Series,
    fixtures: dict[int, dict],
    teams_by_key: dict[str, pd.Series],
    season_days: int,
) -> tuple[list[float], list[float], list[float], list[float]]:
    """Return fixture-aware daily projections, or legacy-flat arrays if incomplete."""
    ordered_fixtures = [fixtures.get(day) for day in range(1, season_days + 1)]
    if any(fixture is None or normalize(fixture["opponent"]) not in teams_by_key for fixture in ordered_fixtures):
        return ([p_play] * season_days, [mv] * season_days, [std] * season_days, [bonus] * season_days)

    own_attack, own_defence = float(team.rating_att), float(team.rating_dif)
    european_team = pd.notna(team.coppa_europea) and bool(str(team.coppa_europea).strip())
    play_signals, vote_signals, bonus_signals, std_signals = [], [], [], []
    for fixture in ordered_fixtures:
        opponent = teams_by_key[normalize(fixture["opponent"])]
        home = fixture["venue"] == "CASA"
        venue = 1.0 if home else -1.0
        attack_edge = own_attack - float(opponent.rating_dif)
        defence_edge = own_defence - float(opponent.rating_att)
        # A European team is relatively more likely to rotate every third Serie A round.
        rotation = european_team and int(fixture["matchday"]) % EUROPEAN_ROTATION_CYCLE == 0
        play_signals.append(venue * FIXTURE_HOME_PLAY_EFFECT + (attack_edge + defence_edge) * FIXTURE_STRENGTH_PLAY_EFFECT - rotation * EUROPEAN_ROTATION_PLAY_EFFECT)
        vote_signals.append(venue * FIXTURE_HOME_VOTE_EFFECT + defence_edge * FIXTURE_DEFENCE_VOTE_EFFECT)
        bonus_signals.append(venue * FIXTURE_HOME_BONUS_EFFECT + attack_edge * FIXTURE_ATTACK_BONUS_EFFECT - rotation * EUROPEAN_ROTATION_BONUS_EFFECT)
        std_signals.append(-venue * FIXTURE_AWAY_STD_EFFECT - defence_edge * FIXTURE_OPPONENT_STD_EFFECT)
    return (
        _center_bounded(p_play, play_signals, DAILY_PLAY_BOUNDS),
        _center_bounded(mv, vote_signals, DAILY_VOTE_BOUNDS),
        _center_bounded(std, std_signals, DAILY_STD_BOUNDS),
        _center_bounded(bonus, bonus_signals, DAILY_BONUS_BOUNDS),
    )


def build_projections(raw: Path = RAW, output: Path = PROCESSED, config: ModelConfig = ModelConfig(), league: LeagueConfig | None = None, profile: LeagueProfile | str | Path | None = None, web_export_dir: Path | None = None) -> dict:
    if isinstance(profile, (str, Path)):
        profile = LeagueProfile.load_json(profile)
    league = LeagueConfig.from_profile(profile) if profile else (league or LeagueConfig())
    if profile:
        config = replace(config, season_days=profile.season.serie_a_matchdays)
    listone, history_entries, calendar, teams, starters, set_pieces, ceduti = load_raw(raw, profile)
    histories = [frame for _, frame in history_entries]
    league_calendar = load_canonical_league_calendar(raw, profile)
    # Retain display names while making league fixtures joinable on stable IDs.
    league_calendar = {
        **league_calendar,
        "matchdays": [
            {
                **day,
                "fixtures": [
                    {**fixture, "home_team_id": normalize(fixture["home"]), "away_team_id": normalize(fixture["away"])}
                    for fixture in day["fixtures"]
                ],
            }
            for day in league_calendar["matchdays"]
        ],
    } if league_calendar else None
    sources = _source_map(profile, raw)
    guide_source = sources.get("auction_guide")
    guide_path = _resolve_source(guide_source, raw) if guide_source else raw / "guide_asta_sosfanta.csv"
    guide = pd.read_csv(guide_path) if guide_path.exists() else pd.DataFrame(columns=["id_fantacalcio", "fascia"])
    if not guide.empty and (guide.id_fantacalcio.duplicated().any() or not set(guide.id_fantacalcio).issubset(set(listone.Id))):
        raise ValueError("guide_asta_sosfanta: IDs must be unique and present in the listone")
    listone = listone[~listone.Id.isin(ceduti.Id.dropna())].copy()
    overrides = load_identity_overrides()
    starter_matches = match_manual(starters, listone, "titolari", overrides)
    piece_matches = match_manual(set_pieces, listone, "piazzati", overrides)
    output = output / profile.profile_id / profile.season.season.replace("/", "-") if profile else output
    output.mkdir(parents=True, exist_ok=True)
    review = pd.concat([starter_matches, piece_matches])
    review[~review.metodo.isin(["auto", "manuale", "override"])].to_csv(output / "matching_review.csv", index=False, encoding="utf-8")
    starter_status = starters.copy()
    starter_status["id_matched"] = starter_matches.id_matched.values
    pieces = set_pieces.copy()
    pieces["id_matched"] = piece_matches.id_matched.values
    teams = teams.copy()
    teams["team_key"] = teams.squadra.map(normalize)
    teams["team_id"] = teams.team_key
    teams_by_key = {team.team_key: team for _, team in teams.iterrows()}
    fixtures_by_team = {team_name: {} for team_name in teams.squadra}
    for _, match in calendar.iterrows():
        matchday = int(match.matchday)
        home_team, away_team = match.home_team, match.away_team
        if home_team in fixtures_by_team:
            fixtures_by_team[home_team][matchday] = {"team_id": normalize(home_team), "matchday": matchday, "date": str(match.match_date)[:10], "opponent": away_team, "opponent_team_id": normalize(away_team), "venue": "CASA"}
        if away_team in fixtures_by_team:
            fixtures_by_team[away_team][matchday] = {"team_id": normalize(away_team), "matchday": matchday, "date": str(match.match_date)[:10], "opponent": home_team, "opponent_team_id": normalize(home_team), "venue": "TRASFERTA"}
    players = []
    for _, player in listone.iterrows():
        guide_entry = guide[guide.id_fantacalcio == player.Id]
        team = teams[teams.team_key == normalize(player.Squadra)]
        if team.empty:
            raise ValueError(f"squadre.csv lacks {player.Squadra}")
        team = team.iloc[0]
        starter_entry = starter_status[starter_status.id_matched == player.Id]
        status = starter_entry.status
        historical_p_play = weighted_history(int(player.Id), histories, "Pv", np.nan, config.history_weights) / 38
        if not status.empty:
            status_p_play = {"TITOLARE": .85, "BALLOTTAGGIO": .55, "RISERVA": .15}.get(status.iloc[0], .30)
            p_play = status_p_play if np.isnan(historical_p_play) else .65 * status_p_play + .35 * historical_p_play
        else:
            p_play = historical_p_play
            if np.isnan(p_play):
                importance = min(float(player.FVM) / 100, 1)
                p_play = .25 + .35 * importance + .04 * (float(team.rating_att) + float(team.rating_dif) - 10)
        if player.R != "P" and pd.notna(team.coppa_europea) and str(team.coppa_europea).strip():
            p_play *= config.european_rotation_discount
        p_play = float(np.clip(p_play, .05, .95))
        team_prior = (float(team.rating_att) - 5.5) * .045
        mv = weighted_history(int(player.Id), histories, "Mv", 6.0 + team_prior, config.history_weights)
        std = vote_standard_deviation(int(player.Id), histories, config.default_std[player.R])
        # 75 minutes per rated appearance is the documented approximation.
        per90 = lambda col: weighted_rate_per_appearance(int(player.Id), histories, col, config.history_weights)
        goal, assist = per90("Gf"), per90("Ass")
        yellow, red, autogoal = per90("Amm"), per90("Esp"), per90("Au")
        malus = yellow * -league.scoring_yellow_card + red * -league.scoring_red_card + autogoal * -league.scoring_own_goal
        first_penalty = pieces[(pieces.id_matched == player.Id) & (pieces.tipo == "RIGORI") & (pieces.priorita == 1)]
        if not first_penalty.empty:
            goal += .12  # Expected penalty goals per 90 for the primary taker.
        conceded = per90("Gs") if player.R == "P" else 0.0
        bonus = goal * league.scoring_goal + assist * league.scoring_assist - malus + conceded * league.scoring_goalkeeper_conceded_goal
        historical = {}
        for season, frame in history_entries:
            rows = frame[frame.Id == player.Id]
            if not rows.empty:
                historical[season] = _clean_record(rows.iloc[0][["Pv", "Mv", "Fm", "Gf", "Gs", "Rp", "Rc", "R+", "R-", "Ass", "Amm", "Esp", "Au"]].to_dict())
        event_rates = {"gol": round(goal, 4), "assist": round(assist, 4), "ammonizioni": round(yellow, 4), "espulsioni": round(red, 4), "autogol": round(autogoal, 4), "gol_subiti": round(conceded, 4)}
        daily_play, daily_vote, daily_std, daily_bonus = fixture_projection_arrays(p_play, mv, std, bonus, team, fixtures_by_team.get(player.Squadra, {}), teams_by_key, config.season_days)
        players.append({"id": int(player.Id), "nome": player.Nome, "ruolo": player.R, "ruoli_mantra": player.RM, "squadra": player.Squadra, "team_id": normalize(player.Squadra), "quotazioni": {"attuale": int(player["Qt.A"]), "iniziale": int(player["Qt.I"]), "differenza": int(player["Diff."])}, "fvm_original": round(float(player.FVM), 2), "fvm_scaled": round(float(player.FVM) * .75, 2), "guida_asta_fascia": guide_entry.iloc[0].fascia if not guide_entry.empty else None, "disponibilita": {"status": status.iloc[0] if not status.empty else "NON_CLASSIFICATO", "nota": starter_entry.iloc[0].note if not starter_entry.empty else None}, "storico": historical, "proiezione": {"p_gioca": round(p_play, 4), "voto_puro": round(mv, 3), "deviazione": round(std, 3), "bonus": round(bonus, 3), "fantavoto": round(mv + bonus, 3)}, "event_rates": event_rates, "p_gioca_per_giornata": [round(value, 4) for value in daily_play], "voto_puro_mean_per_giornata": [round(value, 3) for value in daily_vote], "voto_puro_std_per_giornata": [round(value, 3) for value in daily_std], "bonus_atteso_per_giornata": [round(value, 3) for value in daily_bonus]})
    # Browser JSON parsing rejects Python's non-standard NaN spelling in blank score columns.
    calendar_records = calendar.astype(object).where(pd.notna(calendar), None).to_dict(orient="records")
    for match in calendar_records:
        match["home_team_id"] = normalize(match["home_team"])
        match["away_team_id"] = normalize(match["away_team"])
    team_records = []
    for _, team in teams.iterrows():
        record = _clean_record(team.drop(labels="team_key").to_dict())
        record["fixtures"] = [fixtures_by_team[team.squadra][day] for day in sorted(fixtures_by_team[team.squadra])]
        record["player_ids"] = [player["id"] for player in players if player["squadra"] == team.squadra]
        team_records.append(record)
    set_piece_records = []
    for team_name, group in pieces.dropna(subset=["id_matched"]).groupby("squadra"):
        for kind, kind_group in group.groupby("tipo"):
            takers = []
            for _, taker in kind_group.iterrows():
                player = next((item for item in players if item["id"] == int(taker.id_matched)), None)
                if player:
                    takers.append({"player_id": player["id"], "nome": player["nome"], "priorita": int(taker.priorita)})
            set_piece_records.append({"squadra": team_name, "team_id": normalize(team_name), "tipo": kind, "takers": sorted(takers, key=lambda item: item["priorita"])})
    league_rules = league_rules_payload(league)
    fingerprints = source_fingerprints(profile, raw) if profile else []
    profile_meta = {"profile_id": profile.profile_id, "profile_name": profile.name, "profile_hash": profile.configuration_hash, "dataset_input_hash": dataset_input_hash(profile, fingerprints), "source_fingerprints": fingerprints, "season": profile.season.season} if profile else None
    current_matchdays = [day["serie_a_matchday"] for day in league_calendar["matchdays"]] if league_calendar else list(range(profile.season.fantasy_start_matchday, profile.season.fantasy_end_matchday + 1)) if profile else []
    horizons = {
        "historical": {"matchdays": config.season_days, "label": f"storico {config.season_days}"},
        "current_league": {"serie_a_matchdays": current_matchdays, "label": f"lega corrente {len(current_matchdays)}"},
    }
    payload = {"schema_version": "1.0", "model_version": "1.5", "players": players, "teams": team_records, "set_pieces": set_piece_records, "league_rules": league_rules, "calendario_serie_a": calendar_records, "calendario_lega": league_calendar, "meta": {"generato_il": datetime.now(timezone.utc).isoformat(), "versione_modello": "1.5", "profile": profile_meta, "horizons": horizons, "assunzioni": "75 minuti per voto; disponibilita da status e storico; malus portieri incluso; lineup auto nel simulatore"}}
    with (output / "auction_data.json").open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, default=str, separators=(",", ":"), allow_nan=False)
    if web_export_dir is not None:
        web_export = web_export_dir / "auction_data.json"
        web_export.parent.mkdir(parents=True, exist_ok=True)
        with web_export.open("w", encoding="utf-8") as handle:
            public_payload = {**payload, "calendario_lega": anonymize_public_calendar(payload["calendario_lega"]) if payload["calendario_lega"] else None}
            json.dump(public_payload, handle, ensure_ascii=False, default=str, separators=(",", ":"), allow_nan=False)
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build canonical fantasy-league projection data.")
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--raw-dir", type=Path, default=RAW)
    parser.add_argument("--output-dir", type=Path, default=PROCESSED)
    parser.add_argument("--web-export-dir", type=Path)
    parser.add_argument("--iterations", type=int, default=None, help="Accepted for a shared CLI contract; use advisor.simulate to run simulations.")
    parser.add_argument("--seed", type=int, default=None, help="Accepted for a shared CLI contract; use advisor.simulate to run simulations.")
    args = parser.parse_args(argv)
    payload = build_projections(args.raw_dir, args.output_dir, profile=args.profile, web_export_dir=args.web_export_dir)
    print(f"Exported {len(payload['players'])} active players")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
