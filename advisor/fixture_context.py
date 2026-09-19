"""Validated Serie A calendar and FCO fixture context for P3."""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
from bs4 import BeautifulSoup

from .player_identity import normalize

OFFICIAL_CALENDAR_URL = "https://images.legaseriea.it/image/private/fl_attachment/prd/blpfycdm1ozusg4otblb.pdf"
OFFICIAL_2026_27_DIGEST = "6b650ff4a952d92872f276867e3b1171d0d27bdad1c2ec75ae3e20b60df44604"
STRENGTH_LABEL = "mercati antepost di inizio stagione"


class FixtureContextError(ValueError):
    pass


def _fixtures(rows):
    return [{"matchday": int(row["matchday"]), "home_team": str(row["home_team"]).strip(), "away_team": str(row["away_team"]).strip()} for row in rows]


def _canonical(rows):
    return sorted((row["matchday"], normalize(row["home_team"]), normalize(row["away_team"])) for row in rows)


def calendar_digest(rows) -> str:
    return hashlib.sha256(json.dumps(_canonical(rows), ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def compare_calendars(local, official):
    local_set, official_set = set(_canonical(local)), set(_canonical(official))
    inversions = sorted(row for row in local_set - official_set if (row[0], row[2], row[1]) in official_set)
    inverted_official = {(day, away, home) for day, home, away in inversions}
    missing = sorted(official_set - local_set - inverted_official)
    unexpected = sorted(local_set - official_set - set(inversions))
    return {"exact_matches": len(local_set & official_set), "mismatches": unexpected, "missing_fixtures": missing, "home_away_inversions": inversions}


def validate_calendar(rows, official=None, *, expected_digest=None):
    fixtures = _fixtures(rows)
    teams = sorted({normalize(row[key]) for row in fixtures for key in ("home_team", "away_team")})
    if len(fixtures) != 380 or len(teams) != 20:
        raise FixtureContextError("Serie A calendar must contain 380 fixtures and 20 teams.")
    rounds = defaultdict(list)
    pairs = Counter()
    directions = Counter()
    seen = set()
    for row in fixtures:
        day, home, away = row["matchday"], normalize(row["home_team"]), normalize(row["away_team"])
        key = (day, home, away)
        if day not in range(1, 39) or home == away or key in seen:
            raise FixtureContextError("Serie A calendar contains an invalid or duplicate fixture.")
        seen.add(key); rounds[day].extend((home, away)); pairs[tuple(sorted((home, away)))] += 1; directions[(home, away)] += 1
    if set(rounds) != set(range(1, 39)) or any(len(values) != 20 or len(set(values)) != 20 for values in rounds.values()):
        raise FixtureContextError("Every Serie A team must appear exactly once in every matchday.")
    if len(pairs) != 190 or any(count != 2 for count in pairs.values()) or any(directions[(a, b)] != 1 or directions[(b, a)] != 1 for a, b in pairs):
        raise FixtureContextError("Every Serie A pair must play exactly once home and away.")
    digest = calendar_digest(fixtures)
    if expected_digest and digest != expected_digest:
        raise FixtureContextError("Local Serie A calendar does not match the authoritative schedule digest.")
    comparison = compare_calendars(fixtures, official) if official is not None else {"exact_matches": 380, "mismatches": [], "missing_fixtures": [], "home_away_inversions": []}
    if any(comparison[key] for key in ("mismatches", "missing_fixtures", "home_away_inversions")):
        raise FixtureContextError(f"Authoritative calendar mismatch: {json.dumps(comparison, ensure_ascii=False)}")
    return {"teams": 20, "rounds": 38, "fixtures": 380, "digest": digest, "authority": "Lega Serie A", "source_url": OFFICIAL_CALENDAR_URL, "state": "validated", **comparison}


def read_calendar(path: Path):
    try:
        frame = pd.read_excel(path, sheet_name="matches")
    except Exception as error:
        raise FixtureContextError("Serie A calendar workbook could not be read.") from error
    required = {"matchday", "home_team", "away_team"}
    if not required <= set(frame.columns):
        raise FixtureContextError("Serie A calendar workbook columns changed.")
    return _fixtures(frame.to_dict(orient="records"))


def _number(text: str) -> float:
    try:
        return float(text.strip().replace("%", "").replace(",", "."))
    except ValueError as error:
        raise FixtureContextError(f"Malformed fixture-context number: {text!r}.") from error


def _sports_event(soup):
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            value = json.loads(script.string or "")
        except json.JSONDecodeError:
            continue
        values = value.get("@graph", []) if isinstance(value, dict) and isinstance(value.get("@graph"), list) else [value]
        event = next((item for item in values if isinstance(item, dict) and item.get("@type") == "SportsEvent"), None)
        if event:
            return event
    raise FixtureContextError("FCO match-detail SportsEvent metadata is missing.")


MONTHS = {"gennaio": 1, "febbraio": 2, "marzo": 3, "aprile": 4, "maggio": 5, "giugno": 6, "luglio": 7, "agosto": 8, "settembre": 9, "ottobre": 10, "novembre": 11, "dicembre": 12}


def parse_match_context(html: str, season: str, matchday: int, home: str, away: str):
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    if f"{matchday}ª Giornata" not in title or season.replace("/", "/20") not in title:
        raise FixtureContextError("FCO match-detail season, round or fixture does not match the request.")
    event = _sports_event(soup)
    event_teams = {normalize((event.get(key) or {}).get("name", "")) for key in ("homeTeam", "awayTeam")}
    if event_teams != {normalize(home), normalize(away)}:
        raise FixtureContextError("FCO match-detail season, round or fixture does not match the request.")
    clubs = []
    for node in soup.select(".stp-club"):
        if STRENGTH_LABEL not in normalize(node.select_one(".stp-flab").get_text(" ", strip=True) if node.select_one(".stp-flab") else ""):
            continue
        name = node.select_one(".stp-club__nome")
        value = node.select_one(".stp-fnum")
        if name is None or value is None:
            raise FixtureContextError("FCO antepost strength structure changed.")
        strength = _number(value.get_text(" ", strip=True).split("/")[0])
        if not 0 <= strength <= 10:
            raise FixtureContextError("FCO antepost strength is outside 0-10.")
        team = next(name.stripped_strings, "")
        clubs.append({"team": team, "normalized_team": normalize(team), "strength": strength})
    if len(clubs) != 2 or {row["normalized_team"] for row in clubs} != {normalize(home), normalize(away)}:
        raise FixtureContextError("FCO match-detail does not expose two expected antepost strengths.")
    market = None
    quote = soup.select_one(".stp-quote")
    scheduled = str(event.get("eventStatus", "")).endswith("EventScheduled")
    if quote is not None and scheduled:
        boxes = quote.select(".stp-qbox")
        if len(boxes) != 3:
            raise FixtureContextError("FCO 1/X/2 bookmaker structure changed.")
        labels = [node.select_one(".stp-qlab").get_text(" ", strip=True) for node in boxes]
        if not labels[0].startswith("1 ·") or not labels[1].startswith("X ·") or not labels[2].startswith("2 ·"):
            raise FixtureContextError("FCO 1/X/2 bookmaker labels changed.")
        odds = [_number(node.select_one(".stp-qval").get_text(" ", strip=True)) for node in boxes]
        probabilities = [_number(node.select_one(".stp-qperc").get_text(" ", strip=True)) for node in boxes]
        if abs(sum(probabilities) - 100) > 1.5:
            raise FixtureContextError("FCO 1/X/2 probabilities do not sum to approximately 100%.")
        less = quote.select_one(".stp-gol__meno"); more = quote.select_one(".stp-gol__piu")
        if less is None or more is None or "meno di 3" not in normalize(less.get_text(" ", strip=True)) or "3 o piu" not in normalize(more.get_text(" ", strip=True)):
            raise FixtureContextError("FCO goals-market semantics changed.")
        timestamp = quote.select_one(".stp-aggiorn")
        found = re.search(r"(\d{1,2})\s+(\w+)\s+alle\s+(\d{2}):(\d{2})", timestamp.get_text(" ", strip=True) if timestamp else "", re.I)
        if not found or normalize(found.group(2)) not in MONTHS:
            raise FixtureContextError("FCO bookmaker observation timestamp is invalid.")
        year = int(season[:4]) if MONTHS[normalize(found.group(2))] >= 7 else int(season[:4]) + 1
        observed = datetime(year, MONTHS[normalize(found.group(2))], int(found.group(1)), int(found.group(3)), int(found.group(4)), tzinfo=ZoneInfo("Europe/Rome")).isoformat()
        market = {"home_win_pct": probabilities[0], "draw_pct": probabilities[1], "away_win_pct": probabilities[2], "home_odds": odds[0], "draw_odds": odds[1], "away_odds": odds[2], "less_than_3_goals_pct": _number(less.get_text(" ", strip=True).split()[-1]), "three_plus_goals_pct": _number(more.get_text(" ", strip=True).split()[-1]), "observation_at": observed}
    return {"home_team": home, "away_team": away, "event_status": str(event.get("eventStatus", "")).rsplit("/", 1)[-1], "strengths": clubs, "market": market}


def strength_percentiles(teams):
    values = sorted(float(row["strength"]) for row in teams)
    result = {}
    for row in teams:
        value = float(row["strength"]); positions = [index for index, item in enumerate(values) if item == value]
        result[row["normalized_team"]] = round(sum(positions) / len(positions) / (len(values) - 1) * 100, 1)
    return result


def merge_strengths(contexts, *, require_all=True):
    teams = {}
    for context in contexts:
        for row in context["strengths"]:
            previous = teams.get(row["normalized_team"])
            if previous and previous["strength"] != row["strength"]:
                raise FixtureContextError(f"Conflicting antepost strength for {row['team']}: {previous['strength']} vs {row['strength']}.")
            teams[row["normalized_team"]] = row
    if require_all and len(teams) != 20:
        raise FixtureContextError(f"Expected 20 unique FCO team strengths, found {len(teams)}.")
    return sorted(teams.values(), key=lambda row: row["normalized_team"])


def build_fixture_rows(calendar, teams, states=None, markets=None):
    by_team = {row["normalized_team"]: row for row in teams}; percentiles = strength_percentiles(teams)
    if len(by_team) != 20:
        raise FixtureContextError("Exactly 20 unique team strengths are required.")
    states, markets, result = states or {}, markets or {}, []
    for fixture in calendar:
        home, away, day = fixture["home_team"], fixture["away_team"], fixture["matchday"]
        key = f"{day}:{normalize(home)}:{normalize(away)}"
        for team, opponent, venue in ((home, away, "HOME"), (away, home, "AWAY")):
            opponent_key = normalize(opponent)
            if opponent_key not in by_team:
                raise FixtureContextError(f"Missing strength for {opponent}.")
            result.append({"team": team, "normalized_team": normalize(team), "matchday": day, "opponent": opponent, "venue": venue, "fixture_state": states.get(key), "opponent_strength": by_team[opponent_key]["strength"], "opponent_strength_percentile": percentiles[opponent_key], "market": markets.get(key) if venue == "HOME" else markets.get(key)})
    return result
