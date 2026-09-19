"""Authorized Fantacalcio Online P1/P2 snapshots and analytics inputs."""
from __future__ import annotations

import hashlib
import json
import re
import tempfile
from collections import defaultdict
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

from .player_identity import load_identity_overrides, normalize, resolve_player
from .player_list_updates import active_player_list_path, read_player_list, season_years
from .fixture_context import (
    OFFICIAL_2026_27_DIGEST, STRENGTH_LABEL, FixtureContextError,
    build_fixture_rows, merge_strengths, parse_match_context, read_calendar,
    validate_calendar,
)

PROVIDER = "fantacalcio-online"
BASE = "https://www.fantacalcio-online.com/it"
MAX_RESPONSE_BYTES = 5_000_000
TTL_SECONDS = 4 * 60 * 60
FetchPage = Callable[[str], str]


class FcoIntelligenceError(ValueError):
    """A remote page or stored P1 snapshot failed semantic validation."""


def _text(node: object) -> str:
    return re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip() if hasattr(node, "get_text") else ""


def _slug(season: str) -> str:
    start, end = season_years(season)
    return f"{start}-{end}"


def performance_url(season: str, matchday: int | str) -> str:
    return f"{BASE}/serie-a/{_slug(season)}/voti/{matchday}-giornata"


def lineup_url(season: str, matchday: int) -> str:
    return f"{BASE}/serie-a/{_slug(season)}/probabili-formazioni/{matchday}-giornata"


def match_url(season: str, matchday: int, home: str, away: str) -> str:
    slug = f"{normalize(home)}-{normalize(away)}".replace(" ", "-")
    return f"{performance_url(season, matchday)}/{slug}"


CUMULATIVE_URL = f"{BASE}/serie-a/{{season}}/statistiche-bonus-malus"
OWNERSHIP_URL = f"{BASE}/i-piu-comprati"
PRICE_URL = f"{BASE}/asta-fantacalcio-stima-prezzi"
FORECAST_URL = f"{BASE}/serie-a/{{season}}/quotazioni"


def fetch_page(url: str) -> str:
    request = Request(url, headers={"User-Agent": "Fishertiger/1.0", "Accept": "text/html,application/xhtml+xml"})
    try:
        with urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise FcoIntelligenceError(f"Fantacalcio Online returned HTTP {response.status}.")
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                raise FcoIntelligenceError("Fantacalcio Online returned an unexpectedly large response.")
            charset = response.headers.get_content_charset() or "utf-8"
        return payload.decode(charset)
    except FcoIntelligenceError:
        raise
    except Exception as error:
        raise FcoIntelligenceError("Fantacalcio Online could not be reached or returned invalid HTML.") from error


def _dataset(soup: BeautifulSoup, expected_name: str) -> dict[str, object]:
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            value = json.loads(script.string or "")
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("@type") == "Dataset" and expected_name.lower() in str(value.get("name", "")).lower():
            return value
    raise FcoIntelligenceError(f"Fantacalcio Online {expected_name} dataset metadata is missing.")


def _season_round(soup: BeautifulSoup, season: str, matchday: int, kind: str) -> dict[str, object]:
    try:
        data = _dataset(soup, kind)
    except FcoIntelligenceError:
        if kind != "Voti Fantacalcio":
            raise
        data = {"name": _text(soup.select_one("title"))}
    start, end = season_years(season)
    name = str(data.get("name", ""))
    found_round = re.search(r"(\d+)[ªa]? giornata", name, re.I)
    found_season = re.search(r"(\d{4})/(\d{4})", name)
    if not found_round or not found_season or int(found_round.group(1)) != matchday or (int(found_season.group(1)), int(found_season.group(2))) != (start, end):
        raise FcoIntelligenceError(f"Fantacalcio Online {kind} page season or matchday does not match the request.")
    return data


def _number(value: str, *, percentage: bool = False) -> float | None:
    clean = value.strip().replace("%", "").replace(",", ".")
    if not clean or clean in {"–", "-", "—"}:
        return None
    if not re.fullmatch(r"[+-]?\d+(?:\.\d+)?", clean):
        raise FcoIntelligenceError(f"Malformed {'percentage' if percentage else 'number'}: {value!r}.")
    result = float(clean)
    if percentage and not 0 <= result <= 100:
        raise FcoIntelligenceError(f"Percentage outside 0-100: {value!r}.")
    return result


def _vote(value: str) -> dict[str, object]:
    clean = value.strip().lower()
    if clean in {"s.v.", "s.v", "sv"}:
        return {"state": "sv", "value": None}
    if clean in {"–", "-", "—", ""}:
        return {"state": "unpublished", "value": None}
    number = _number(clean)
    if number is None or not 0 <= number <= 10:
        raise FcoIntelligenceError(f"Invalid editorial vote: {value!r}.")
    return {"state": "numeric", "value": number}


def _fixture(header: object) -> dict[str, object]:
    teams = [_text(item) for item in header.select(".prb-incontro__nome")]
    if len(teams) != 2 or teams[0] == teams[1]:
        raise FcoIntelligenceError("A matchday fixture has invalid teams.")
    score = _text(header.select_one(".prb-incontro__punteggio"))
    scores = re.fullmatch(r"(\d+)\s*:\s*(\d+)", score)
    kickoff = _text(header.select_one(".prb-incontro__data"))
    try:
        kickoff_iso = datetime.strptime(kickoff, "%d/%m/%Y %H:%M").isoformat()
    except ValueError as error:
        raise FcoIntelligenceError("A matchday fixture has an invalid kickoff.") from error
    return {
        "home_team": teams[0], "away_team": teams[1], "kickoff": kickoff_iso,
        "status": _text(header.select_one(".prb-incontro__stato")),
        "home_score": int(scores.group(1)) if scores else None,
        "away_score": int(scores.group(2)) if scores else None,
    }


EVENT_PATTERNS = {
    "goals": re.compile(r"(\d+) Goal Segnat", re.I),
    # FCO currently emits both the correct "Assist" and the typo "Assit".
    "assists": re.compile(r"(\d+) Assi?s?t", re.I),
    "yellow_cards": re.compile(r"Ammonizione", re.I),
    "red_cards": re.compile(r"Espulsione", re.I),
    "penalties_scored": re.compile(r"(\d+) (?:Rigore|Goal) Segnat[oi] su Rigore", re.I),
    "penalties_missed": re.compile(r"(\d+) Rigori? Sbagliat", re.I),
    "own_goals": re.compile(r"(\d+) Autogol", re.I),
    "goals_conceded": re.compile(r"(\d+) Goal Subit", re.I),
    "penalties_saved": re.compile(r"(\d+) Rigori? Parat", re.I),
}


def _fixture_state(status: str) -> str:
    value = normalize(status)
    if value == "terminata":
        return "completed"
    if value == "non iniziata":
        return "upcoming"
    if any(label in value for label in ("in corso", "intervallo", "primo tempo", "secondo tempo")):
        return "in_progress"
    return "other"


def _event_titles(node: object) -> list[str]:
    return [str(item.get("data-original-title") or item.get("title") or "").strip() for item in node.select("[data-original-title], [title]")]


def _event_value(titles: list[str], pattern: re.Pattern[str], supported: bool) -> int | None:
    if not supported:
        return None
    total = 0
    for title in titles:
        match = pattern.search(title)
        if match:
            total += int(match.group(1)) if match.lastindex else 1
    return total


def parse_performance(html: str, season: str, matchday: int) -> dict[str, object]:
    """Parse one round page without network or identity side effects."""
    soup = BeautifulSoup(html, "html.parser")
    _season_round(soup, season, matchday, "Voti Fantacalcio")
    panes = [pane for pane in soup.select(".tab-pane") if pane.select_one(".prb-incontro")]
    if len(panes) != 10:
        raise FcoIntelligenceError(f"Expected 10 fixtures, found {len(panes)}.")
    all_titles = _event_titles(soup)
    supported = {key: any(pattern.search(title) for title in all_titles) for key, pattern in EVENT_PATTERNS.items()}
    fixtures, records = [], []
    fixture_keys: set[tuple[str, str]] = set()
    for pane in panes:
        fixture = _fixture(pane.select_one(".prb-incontro"))
        key = (fixture["home_team"], fixture["away_team"])
        if key in fixture_keys:
            raise FcoIntelligenceError("Duplicate fixture in matchday page.")
        fixture_keys.add(key)
        fixtures.append(fixture)
        sections = pane.select(".prb-squadra")
        if not sections and fixture["status"].lower() == "non iniziata":
            continue
        if len(sections) != 2:
            raise FcoIntelligenceError("A fixture does not contain exactly two team sections.")
        for section in sections:
            team = _text(section.select_one(".prb-squadra__nome"))
            if team not in key:
                raise FcoIntelligenceError("A fixture player table has an unexpected team.")
            opponent = fixture["away_team"] if team == fixture["home_team"] else fixture["home_team"]
            venue = "HOME" if team == fixture["home_team"] else "AWAY"
            tables = section.select("table")
            captions = [normalize(_text(table.select_one("caption"))) for table in tables]
            if not any("scesi in campo" in value for value in captions) or not any("in panchina" in value for value in captions):
                raise FcoIntelligenceError("A performance team is missing a semantic player table.")
            for table, caption in zip(tables, captions):
                played_table = "scesi in campo" in caption
                bench_table = "in panchina" in caption
                if not (played_table or bench_table):
                    continue
                headers = [_text(item).upper() for item in table.select("thead th")]
                if headers[-3:] != ["FC", "ROM", "TOR"]:
                    raise FcoIntelligenceError("Performance editorial columns changed.")
                for row in table.select("tbody tr"):
                    name = _text(row.select_one(".prb-nome"))
                    cells = row.select("td")
                    if not name or len(cells) != 3:
                        raise FcoIntelligenceError("Malformed performance player row.")
                    titles = _event_titles(row)
                    did_not_enter = any("mai entrato" in title.lower() for title in titles) or "non entrato" in _text(row).lower()
                    entered = any("entrato dalla panchina" in title.lower() for title in titles) or "subentrato" in _text(row).lower()
                    sub = next((re.search(r"Sostituito dopo (\d+)", title, re.I) for title in titles if "sostituito" in title.lower()), None)
                    entry = next((re.search(r"Entrato dalla panchina.*?(\d+) minuti", title, re.I) for title in titles if "entrato dalla" in title.lower()), None)
                    record = {
                        "provider_name": name, "provider_team": team, "provider_role": _text(row.select_one(".role")), "matchday": matchday,
                        "opponent": opponent, "venue": venue, "started": played_table,
                        "entered_from_bench": bool(entered), "did_not_enter": bool(did_not_enter),
                        "substitution_minute": int(sub.group(1)) if sub else None,
                        "entry_minute": None,
                        "minutes_played": int(entry.group(1)) if entry else int(sub.group(1)) if sub else 90 if played_table else 0 if did_not_enter else None,
                        "vote_fc": _vote(_text(cells[0])), "vote_roma": _vote(_text(cells[1])), "vote_torino": _vote(_text(cells[2])),
                    }
                    record.update({event: _event_value(titles, pattern, supported[event]) for event, pattern in EVENT_PATTERNS.items()})
                    if record["provider_role"] != "P":
                        record["goals_conceded"] = None
                        record["penalties_saved"] = None
                    records.append(record)
    if len({(row["provider_team"], normalize(row["provider_name"])) for row in records}) != len(records):
        raise FcoIntelligenceError("Duplicate player in matchday page.")
    complete = all(fixture["status"].lower() == "terminata" for fixture in fixtures)
    published = all(row[key]["state"] != "unpublished" for row in records if not row["did_not_enter"] for key in ("vote_fc", "vote_roma", "vote_torino"))
    return {"fixtures": fixtures, "records": records, "state": "final" if complete and published else "provisional", "event_availability": supported}


def _market_table(soup: BeautifulSoup, table_id: str, headers: list[str]) -> object:
    table = soup.select_one(f"#{table_id}")
    actual = [_text(item) for item in table.select("thead th")] if table else []
    if table is None or actual != headers:
        raise FcoIntelligenceError("Fantacalcio Online market table semantics changed.")
    return table


OWNERSHIP_HEADERS = ["Ruolo", "Squadra", "Nome", "Kap.", "Comprato da", "Prezzo 350", "Prezzo 500", "Titolare", "7 gg"]


def parse_ownership(html: str, season: str, cohort: str) -> dict[str, object]:
    soup = BeautifulSoup(html, "html.parser")
    data = _dataset(soup, "giocatori più comprati")
    start, end = season_years(season)
    title = _text(soup.select_one("h1"))
    if f"{start}/{end}" not in title:
        raise FcoIntelligenceError("Ownership page season does not match the active profile.")
    expected = {"overall": "", "lte9": "piccole", "gte10": "grandi"}.get(cohort)
    role = soup.select_one('select[name="ruoli"] option[selected]')
    league = soup.select_one('select[name="leghe"] option[selected]')
    if expected is None or role is None or role.get("value") != "fcit" or (league.get("value") if league else "") != expected:
        raise FcoIntelligenceError("Ownership filter response does not match the verified cohort request.")
    intro = next((_text(item) for item in soup.select(".fco-tagli__intro") if "aggiornato al" in _text(item).lower()), "")
    found = re.search(r"aggiornato al (\d{2}/\d{2}/\d{4}): (\d+) calciatori", intro, re.I)
    if not found:
        raise FcoIntelligenceError("Ownership source date or row count is missing.")
    source_date = datetime.strptime(found.group(1), "%d/%m/%Y").date().isoformat()
    contract = normalize(_text(soup))
    if data.get("dateModified") != source_date or "piu di 10 giocatori" not in normalize(data.get("measurementTechnique", "")) or "da 30 squadre in su" not in contract or "ogni notte" not in contract:
        raise FcoIntelligenceError("Ownership eligibility or refresh semantics changed.")
    table = _market_table(soup, "piu_comprati", OWNERSHIP_HEADERS)
    rows = []
    for row in table.select("tbody tr"):
        cells = row.select("td")
        if len(cells) != 9:
            raise FcoIntelligenceError("Malformed ownership row.")
        ownership = _number(_text(cells[4]), percentage=True)
        delta = _number(_text(cells[8]))
        rows.append({"provider_name": _text(cells[2]), "provider_team": _text(cells[1]), "quotation": int(_number(_text(cells[3])) or 0), "ownership_pct": ownership, "ownership_delta_7d": delta})
    if len(rows) != int(found.group(2)) or len({(normalize(row["provider_name"]), normalize(row["provider_team"])) for row in rows}) != len(rows):
        raise FcoIntelligenceError("Ownership declared count or identities do not match the table.")
    return {"source_date": source_date, "cohort": cohort, "rows": rows}


PRICE_HEADERS = ["Ruolo", "Squadra", "Nome", "Kap.", "8 sq. / 350", "10 sq. / 350", "8 sq. / 500", "10 sq. / 500", "M.V.", "Pres."]
PRICE_FIELDS = ("price_8_350", "price_10_350", "price_8_500", "price_10_500")


def parse_prices(html: str, season: str) -> dict[str, object]:
    soup = BeautifulSoup(html, "html.parser")
    start, end = season_years(season)
    season_heading = [_text(item) for item in soup.select(".fco-occhiello")]
    if f"Asta {start}/{end}" not in season_heading:
        raise FcoIntelligenceError("Market price page season does not match the active profile.")
    data = _dataset(soup, "Prezzi medi d'asta")
    source_date = str(data.get("dateModified", ""))
    try:
        datetime.strptime(source_date, "%Y-%m-%d")
    except ValueError as error:
        raise FcoIntelligenceError("Market price source date is invalid.") from error
    technique = str(data.get("measurementTechnique", ""))
    if "soglia minima di 3 aste" not in technique.lower():
        raise FcoIntelligenceError("Market price page does not state the current three-auction threshold.")
    table = _market_table(soup, "players_list", PRICE_HEADERS)
    rows = []
    for row in table.select("tbody tr"):
        cells = row.select("td")
        if len(cells) != 10:
            raise FcoIntelligenceError("Malformed market price row.")
        badge = _text(cells[2].select_one(".fco-etichetta"))
        fallback = "2025/2026" in badge
        new = "nuovo" in badge.lower()
        values = [_number(_text(cell)) for cell in cells[4:8]]
        if new and any(value is not None for value in values):
            raise FcoIntelligenceError("A Nuovo market row unexpectedly contains historical prices.")
        prices = {}
        for field, value in zip(PRICE_FIELDS, values):
            prices[field] = {"value": value, "price_season": "2025/26" if fallback else season, "current_season": value is not None and not fallback, "fallback_previous_season": value is not None and fallback, "unavailable": value is None}
        rows.append({"provider_name": _text(cells[2].select_one(".text-bold")) + (f" {_text(cells[2].select_one('.text-muted'))}" if cells[2].select_one(".text-muted") else ""), "provider_team": _text(cells[1]), "quotation": int(_number(_text(cells[3])) or 0), "new_player": new, **prices})
    declared = int(data.get("size", {}).get("value", -1)) if isinstance(data.get("size"), dict) else -1
    if len(rows) != declared:
        raise FcoIntelligenceError("Market price declared count does not match the table.")
    return {"source_date": source_date, "minimum_auctions": 3, "rows": rows}


def parse_forecast(html: str, season: str) -> dict[str, object]:
    soup = BeautifulSoup(html, "html.parser")
    start, end = season_years(season)
    if f"Serie A {start}/{end}" not in _text(soup.select_one("h1")):
        raise FcoIntelligenceError("FCO forecast page season does not match the active profile.")
    intro = _text(soup.select_one(".fco-hero__sub"))
    found_date = re.search(r"aggiornata al (\d{2}/\d{2}/\d{4})", intro, re.I)
    try:
        source_date = datetime.strptime(found_date.group(1), "%d/%m/%Y").date().isoformat() if found_date else ""
    except ValueError as error:
        raise FcoIntelligenceError("FCO forecast source date is invalid.") from error
    semantics = normalize(_text(soup.select_one(".fco-nota")))
    if not source_date or "fantaindex rating" not in semantics or "prestazioni attese" not in semantics or "fantaindex titolarita" not in semantics or "probabilita di scendere in campo sul torneo" not in semantics:
        raise FcoIntelligenceError("FCO forecast field semantics cannot be established.")
    entries = soup.select("#quotations-dataset [data-entry]")
    if not entries:
        raise FcoIntelligenceError("FCO forecast player dataset is missing.")
    required = {"id", "firstName", "lastName", "kapitals", "overall", "pot", "lineupRating"}
    rows = []
    for entry in entries:
        player = entry.select_one('[data-prop-name="player"]')
        team = entry.select_one('[data-prop-name="realteam"] [data-prop-name="name"]')
        values = {item.get("data-prop-name"): _text(item) for item in player.select(":scope > [data-prop-name]")} if player else {}
        if team is None or not required <= values.keys():
            raise FcoIntelligenceError("FCO forecast player structure changed.")
        current, potential = _number(values["pot"]), _number(values["overall"])
        availability_scale, quotation = _number(values["lineupRating"]), _number(values["kapitals"])
        if current is None or potential is None or not 0 <= current <= 10 or not 0 <= potential <= 10:
            raise FcoIntelligenceError("FCO forecast rating is outside 0-10.")
        availability = availability_scale * 10 if availability_scale is not None else None
        if availability is None or not 0 <= availability <= 100:
            raise FcoIntelligenceError("FCO forecast titularity is outside 0-100.")
        if quotation is None or quotation < 0:
            raise FcoIntelligenceError("FCO forecast quotation is invalid.")
        rows.append({"provider_id": int(values["id"]), "provider_name": f"{values['lastName']} {values['firstName']}".strip(), "provider_team": _text(team), "quotation": int(quotation), "fantaindex_current": current, "fantaindex_potential": potential, "season_availability_pct": availability, "source_date": source_date})
    if len({row["provider_id"] for row in rows}) != len(rows) or len({(normalize(row["provider_name"]), normalize(row["provider_team"])) for row in rows}) != len(rows):
        raise FcoIntelligenceError("Duplicate player in FCO forecast source.")
    return {"source_date": source_date, "rows": rows}


def parse_lineups(html: str, season: str, matchday: int) -> dict[str, object]:
    soup = BeautifulSoup(html, "html.parser")
    data = _season_round(soup, season, matchday, "Probabili formazioni")
    page = _text(soup)
    observed = re.search(r"Ultima rilevazione:\s*(.+?)\.\s*Per questa giornata hanno pubblicato\s*(\d+) redazioni su 4.*?totale di\s*(\d+) calciatori", page, re.I)
    if not observed:
        raise FcoIntelligenceError("Probable-lineup observation summary is missing.")
    try:
        observation = datetime.fromisoformat(str(data.get("dateModified", ""))).isoformat()
    except ValueError as error:
        raise FcoIntelligenceError("Probable-lineup observation timestamp is invalid.") from error
    source_count, evaluated = int(observed.group(2)), int(observed.group(3))
    panes = [pane for pane in soup.select(".tab-pane") if pane.select_one(".prb-incontro")]
    if len(panes) != 10:
        raise FcoIntelligenceError(f"Expected 10 probable-lineup fixtures, found {len(panes)}.")
    fixtures, rows, teams = [], [], set()
    for pane in panes:
        fixture = _fixture(pane.select_one(".prb-incontro"))
        fixtures.append(fixture)
        for section in pane.select(".prb-squadra"):
            team = _text(section.select_one(".prb-squadra__nome"))
            teams.add(team)
            venue = "HOME" if team == fixture["home_team"] else "AWAY"
            opponent = fixture["away_team"] if venue == "HOME" else fixture["home_team"]
            fixture_context = {"fixture_state": _fixture_state(str(fixture["status"])), "fixture_status": fixture["status"]}
            for table in section.select("table"):
                caption = normalize(_text(table.select_one("caption")))
                if "probabili titolari" in caption:
                    group = "probable_starter"
                elif "probabile panchina" in caption:
                    group = "probable_bench"
                elif "indisponibili" in caption:
                    group = "unavailable"
                else:
                    continue
                headers = [_text(item) for item in table.select("thead th")]
                if headers[1:6] != ["Fc", "Gaz", "SOS", "Sky", "Media*"]:
                    raise FcoIntelligenceError("Probable-lineup source columns changed.")
                for row in table.select("tbody tr"):
                    name = _text(row.select_one(".prb-nome"))
                    cells = row.select("td")
                    if not name or len(cells) < 5:
                        raise FcoIntelligenceError("Malformed probable-lineup player row.")
                    values = [_number(_text(cell), percentage=True) for cell in cells[:5]]
                    rows.append({"provider_name": name, "provider_team": team, "matchday": matchday, "opponent": opponent, "venue": venue, **fixture_context, "section": group, "fc_pct": values[0], "gaz_pct": values[1], "sos_pct": values[2], "sky_pct": values[3], "weighted_pct": values[4], "source_count": sum(value is not None for value in values[:4]), "observation_at": observation, "official_confirmed": "confermato" in _text(cells[5]).lower() if len(cells) > 5 else None})
            unavailable = section.select_one(".prb-fuori")
            if unavailable is not None and "indisponibili" not in normalize(_text(unavailable.select_one(".prb-fuori__titolo"))):
                raise FcoIntelligenceError("Probable-lineup unavailable section changed.")
            for row in unavailable.select(".prb-fuori__riga") if unavailable else ():
                name = _text(row.select_one(".prb-nome"))
                if not name:
                    raise FcoIntelligenceError("Malformed unavailable player row.")
                rows.append({"provider_name": name, "provider_team": team, "matchday": matchday, "opponent": opponent, "venue": venue, **fixture_context, "section": "unavailable", "fc_pct": None, "gaz_pct": None, "sos_pct": None, "sky_pct": None, "weighted_pct": None, "source_count": 0, "observation_at": observation, "official_confirmed": None})
    if len({(normalize(row["provider_name"]), normalize(row["provider_team"])) for row in rows}) != len(rows) or len(teams) != 20 or len(rows) != evaluated:
        raise FcoIntelligenceError("Probable-lineup teams, identities or evaluated count do not match the page.")
    if source_count == 0 and rows:
        raise FcoIntelligenceError("A zero-source probable-lineup page unexpectedly contains probabilities.")
    return {"matchday": matchday, "observation_at": observation, "active_source_count": source_count, "evaluated_players": evaluated, "source_state": "awaiting_sources" if source_count == 0 else "published", "fixtures": fixtures, "rows": rows}


def parse_cumulative(html: str, season: str) -> list[dict[str, object]]:
    soup = BeautifulSoup(html, "html.parser")
    start, end = season_years(season)
    if f"{start}/{end}" not in " ".join(_text(item) for item in soup.select("h1, .fco-occhiello")):
        raise FcoIntelligenceError("Cumulative bonus/malus season does not match the active profile.")
    headers = ["RT", "Squadra", "Nome", "Kap.", "PR", "MV5", "FM5", "", "GR+", "GR-", "RG+", "A+", "AF+", "PD+", "P/T", "EG-", "ET-", "RC-"]
    table = next((item for item in soup.select("table") if [_text(cell) for cell in item.select("thead th")] == headers), None)
    if table is None:
        raise FcoIntelligenceError("Cumulative bonus/malus semantic table is missing.")
    result = []
    for row in table.select("tbody tr"):
        cells = row.select("td")
        if len(cells) != len(headers):
            raise FcoIntelligenceError("Malformed cumulative bonus/malus row.")
        result.append({"provider_name": _text(cells[2]), "provider_team": _text(cells[1]), "penalties_scored": _number(_text(cells[8])), "penalties_missed": _number(_text(cells[9])), "assists": sum(_number(_text(cells[index])) or 0 for index in (11, 12))})
    return result


def _active_players(profile: object) -> list[dict[str, object]]:
    players, departed = read_player_list(active_player_list_path(profile))
    active = players.loc[~players["Id"].isin(set(departed["Id"]))]
    return [{"Id": int(row.Id), "R": str(row.R), "Nome": str(row.Nome), "Squadra": str(row.Squadra)} for row in active.itertuples()]


def _resolve(rows: list[dict[str, object]], players: list[dict[str, object]]) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    resolved, unresolved = [], []
    overrides = load_identity_overrides()
    for row in rows:
        match = resolve_player(row["provider_name"], row["provider_team"], players, source=PROVIDER, overrides=overrides)
        identity = {"source": PROVIDER, "raw_source_player_name": row["provider_name"], "raw_source_team": row["provider_team"]}
        if not match["matched"] or match.get("method") == "fuzzy_unique":
            reason = "fuzzy_only_not_accepted" if match.get("method") == "fuzzy_unique" else match["reason"]
            classification = "fuzzy_requires_confirmation" if reason == "fuzzy_only_not_accepted" else "ambiguous" if reason == "ambiguous" else "team_not_in_active_listone" if reason == "team_not_in_active_listone" else "outside_active_listone" if reason in {"player_not_in_active_listone", "invalid_existing_id", "invalid_override_id"} else "other"
            unresolved.append({**row, **identity, "unresolved_diagnostic": reason, "unresolved_classification": classification, "matching_method": match.get("method"), "details": {key: value for key, value in match.items() if key not in {"matched", "player"}}})
            continue
        player = match["player"]
        resolved.append({**row, "fantacalcio_id": int(player["Id"]), "canonical_name": str(player["Nome"]), "canonical_team": str(player["Squadra"]), "canonical_role": str(player["R"]), "matching_method": match["method"], **identity})
    return resolved, unresolved


UNRESOLVED_CLASSES = ("outside_active_listone", "fuzzy_requires_confirmation", "ambiguous", "team_not_in_active_listone", "other")


def _unresolved_summary(rows: list[dict[str, object]]) -> dict[str, int]:
    return {key: sum(row.get("unresolved_classification") == key for row in rows) for key in UNRESOLVED_CLASSES}


def _require_unique_canonical(rows: list[dict[str, object]], source: str) -> None:
    grouped: dict[int, list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        grouped[int(row["fantacalcio_id"])].append(row)
    duplicates = [{"fantacalcio_id": player_id, "source_rows": [{"provider_name": row.get("provider_name"), "provider_team": row.get("provider_team")} for row in matches]} for player_id, matches in grouped.items() if len(matches) > 1]
    if duplicates:
        raise FcoIntelligenceError(f"Duplicate canonical player in {source}: {json.dumps(duplicates, ensure_ascii=False)}")


def _price_cohort(participants: int, credits: int) -> tuple[dict[str, object] | None, str | None]:
    teams = 8 if 7 <= participants <= 8 else 10 if 9 <= participants <= 11 else None
    budget = 350 if 300 <= credits <= 400 else 500 if 440 <= credits <= 560 else None
    reasons = []
    if teams is None:
        reasons.append(f"{participants} participants are outside the supported 7-11 range")
    if budget is None:
        reasons.append(f"{credits} credits are outside the supported 300-400 and 440-560 ranges")
    return ({"teams": teams, "credits": budget, "field": f"price_{teams}_{budget}"}, None) if not reasons else (None, "; ".join(reasons))


def _benchmark_cohort(participants: int) -> dict[str, object] | None:
    teams = 8 if 7 <= participants <= 8 else 10 if 9 <= participants <= 11 else None
    return {"teams": teams, "credits": 500, "field": f"price_{teams}_500"} if teams else None


def _store_market(directory: Path, snapshot: dict[str, object]) -> None:
    historical = {key: value for key, value in snapshot.items() if key != "checked_at"}
    history_hash = _hash(historical)[:12]
    name = f"ownership-{snapshot['market_source_date']}__prices-{snapshot['price_source_date']}__{history_hash}.json"
    _write(directory / "history" / name, historical, immutable=True)
    _write(directory / "latest.json", snapshot)


def _directory(root: Path, profile: object, name: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", profile.profile_id):
        raise FcoIntelligenceError("The profile ID is invalid.")
    start, end = season_years(profile.season.season)
    return root / profile.profile_id / f"{start}-{str(end)[-2:]}" / name


def _write(path: Path, value: object, *, immutable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if immutable and path.exists():
        if path.read_text(encoding="utf-8") != encoded:
            raise FcoIntelligenceError(f"Immutable snapshot {path.name} already exists with different content.")
        return
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(encoded)
        temporary = Path(handle.name)
    temporary.replace(path)


def _read(path: Path) -> dict[str, object] | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FcoIntelligenceError(f"Stored P1 snapshot {path.name} is invalid.") from error
    if not isinstance(value, dict):
        raise FcoIntelligenceError(f"Stored P1 snapshot {path.name} is invalid.")
    return value


def _hash(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _status(root: Path, profile: object) -> dict[str, object]:
    performance = _read(_directory(root, profile, "performance-v1") / "index.json")
    market = _read(_directory(root, profile, "market-v1") / "latest.json")
    lineups = _read(_directory(root, profile, "lineup-probability-v1") / "latest.json")
    forecast = _read(_directory(root, profile, "forecast-v1") / "latest.json")
    fixture_context = _read(_directory(root, profile, "fixture-context-v1") / "latest.json")
    return {"schema_version": "1.0", "provider": PROVIDER, "season": profile.season.season, "performance": performance, "market": market, "lineups": lineups, "forecast": forecast, "fixture_context": fixture_context}


def stored_status(root: Path, profile: object) -> dict[str, object]:
    return _status(root, profile)


def _fresh(snapshot: object, now: datetime) -> bool:
    if not isinstance(snapshot, dict):
        return False
    try:
        checked = datetime.fromisoformat(str(snapshot["checked_at"]).replace("Z", "+00:00"))
        if checked.tzinfo is None:
            checked = checked.replace(tzinfo=timezone.utc)
        return (now - checked.astimezone(timezone.utc)).total_seconds() < TTL_SECONDS
    except (KeyError, TypeError, ValueError):
        return False


def _store_performance(root: Path, profile: object, parsed: dict[str, object], matchday: int, checked_at: str, players: list[dict[str, object]]) -> dict[str, object]:
    directory = _directory(root, profile, "performance-v1")
    path = directory / "matchdays" / f"{matchday:02}.json"
    previous = _read(path)
    resolved, unresolved = _resolve(parsed["records"], players)
    _require_unique_canonical(resolved, f"performance matchday {matchday}")
    content = {"fixtures": parsed["fixtures"], "players": resolved, "unresolved": unresolved, "event_availability": parsed["event_availability"]}
    source_hash = _hash(content)
    revisions = list(previous.get("revisions", [])) if previous else []
    if previous and previous.get("state") == "final" and previous.get("source_hash") != source_hash:
        revision_path = directory / "revisions" / f"{matchday:02}" / f"{previous['source_hash']}.json"
        _write(revision_path, previous, immutable=True)
        revisions.append({"detected_at": checked_at, "previous_hash": previous["source_hash"], "new_hash": source_hash})
    snapshot = {"schema_version": "1.0", "provider": PROVIDER, "season": profile.season.season, "matchday": matchday, "checked_at": checked_at, "source_url": performance_url(profile.season.season, matchday), "source_hash": source_hash, "state": parsed["state"], "event_provenance": {"source": "round_page_player_metadata_tooltips", "match_detail_ingested": False}, **content, "revisions": revisions, "validation": {"fixture_count": len(parsed["fixtures"]), "resolved": len(resolved), "unresolved": len(unresolved), "unresolved_classifications": _unresolved_summary(unresolved), "votes_coverage": sum(row["vote_fc"]["state"] != "unpublished" for row in resolved)}}
    _write(path, snapshot)
    return snapshot


def _audit_performance(directory: Path, cumulative: list[dict[str, object]], players: list[dict[str, object]]) -> dict[str, object]:
    resolved, unresolved = _resolve(cumulative, players)
    final_totals: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    provisional_totals: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    provisional_rounds: dict[tuple[int, str], list[int]] = defaultdict(list)
    coverage: dict[str, bool] = defaultdict(bool)
    for path in sorted((directory / "matchdays").glob("*.json")):
        snapshot = _read(path) or {}
        for event, available in snapshot.get("event_availability", {}).items():
            coverage[event] = coverage[event] or bool(available)
        for row in snapshot.get("players", []):
            for event in ("assists", "penalties_scored", "penalties_missed"):
                if row.get(event) is not None:
                    player_id = int(row["fantacalcio_id"])
                    target = final_totals if snapshot.get("state") == "final" else provisional_totals
                    target[player_id][event] += int(row[event])
                    if snapshot.get("state") != "final" and int(row[event]):
                        provisional_rounds[(player_id, event)].append(int(snapshot["matchday"]))
    discrepancies, pending_sync = [], []
    for row in resolved:
        for event in ("assists", "penalties_scored", "penalties_missed"):
            player_id = int(row["fantacalcio_id"])
            final = int(final_totals[player_id][event])
            provisional = int(provisional_totals[player_id][event])
            current = int(row.get(event) or 0)
            base = {"fantacalcio_id": player_id, "canonical_name": row["canonical_name"], "canonical_team": row["canonical_team"], "metric": event, "final_matchday_total": final, "cumulative": current}
            if coverage[event] and (current < final or current > final + provisional):
                discrepancies.append({**base, "matchdays": final})
            elif coverage[event] and provisional and current < final + provisional:
                pending_sync.append({**base, "provisional_addition": provisional, "provisional_matchdays": sorted(set(provisional_rounds[(player_id, event)]))})
    return {"cumulative_rows": len(resolved), "unresolved": len(unresolved), "unresolved_classifications": _unresolved_summary(unresolved), "coverage": dict(coverage), "discrepancies": discrepancies, "pending_sync": pending_sync}


def form_analytics(snapshots: list[dict[str, object]]) -> list[dict[str, object]]:
    grouped: dict[int, dict[str, object]] = {}
    for snapshot in snapshots:
        for row in snapshot.get("players", []):
            player_id = int(row["fantacalcio_id"])
            target = grouped.setdefault(player_id, {"fantacalcio_id": player_id, "canonical_name": row["canonical_name"], "canonical_team": row["canonical_team"], "canonical_role": row.get("canonical_role"), "final_rows": [], "provisional_matchdays": []})
            if snapshot.get("state") == "final":
                target["final_rows"].append(row)
            else:
                target["provisional_matchdays"].append(int(snapshot["matchday"]))
    result = []
    for target in grouped.values():
        rows = sorted(target.pop("final_rows"), key=lambda row: int(row["matchday"]))
        appearances = [row for row in rows if row.get("started") or row.get("entered_from_bench")]
        votes = [float(row["vote_fc"]["value"]) for row in rows if row.get("vote_fc", {}).get("state") == "numeric"]
        def mean(values: list[float]) -> float | None:
            return round(sum(values) / len(values), 2) if values else None
        result.append({**target, "provisional_matchdays": sorted(set(target["provisional_matchdays"])), "final_appearances": len(appearances), "starts": sum(bool(row.get("started")) for row in appearances), "substitute_appearances": sum(bool(row.get("entered_from_bench")) for row in appearances), "minutes": sum(int(row["minutes_played"]) for row in appearances if isinstance(row.get("minutes_played"), (int, float))), "numeric_fc_votes": len(votes), "mean_fc_vote": mean(votes), "last_3_mean": mean(votes[-3:]), "last_3_sample_size": len(votes[-3:]), "last_5_mean": mean(votes[-5:]), "last_5_sample_size": len(votes[-5:]), **{event: sum(int(row[event]) for row in rows if isinstance(row.get(event), (int, float))) for event in ("goals", "assists", "yellow_cards", "red_cards")}})
    return sorted(result, key=lambda row: row["fantacalcio_id"])


def _check_performance(root: Path, profile: object, fetcher: FetchPage, players: list[dict[str, object]], checked_at: str, force: bool) -> dict[str, object]:
    latest_html = fetcher(performance_url(profile.season.season, "ultima"))
    soup = BeautifulSoup(latest_html, "html.parser")
    heading = _text(soup.select_one("h1"))
    found = re.search(r"(\d+)[ªa]? giornata", heading, re.I)
    if not found:
        raise FcoIntelligenceError("Latest played matchday could not be identified.")
    latest = int(found.group(1))
    directory = _directory(root, profile, "performance-v1")
    candidates = []
    for matchday in range(1, latest + 1):
        existing = _read(directory / "matchdays" / f"{matchday:02}.json")
        if existing and existing.get("state") == "final" and not force:
            candidates.append((matchday, existing, None))
            continue
        html = latest_html if matchday == latest else fetcher(performance_url(profile.season.season, matchday))
        candidates.append((matchday, None, parse_performance(html, profile.season.season, matchday)))
    cumulative = parse_cumulative(fetcher(CUMULATIVE_URL.format(season=_slug(profile.season.season))), profile.season.season)
    snapshots = [existing or _store_performance(root, profile, parsed, matchday, checked_at, players) for matchday, existing, parsed in candidates]
    audit = _audit_performance(directory, cumulative, players)
    unresolved_rows = [item for row in snapshots for item in row["unresolved"]]
    index = {"schema_version": "1.0", "provider": PROVIDER, "season": profile.season.season, "checked_at": checked_at, "latest_played_matchday": latest, "available_matchdays": len(snapshots), "final_matchdays": sum(row["state"] == "final" for row in snapshots), "provisional_matchdays": sum(row["state"] == "provisional" for row in snapshots), "resolved": sum(len(row["players"]) for row in snapshots), "unresolved": len(unresolved_rows), "unresolved_classifications": _unresolved_summary(unresolved_rows), "event_provenance": {"source": "round_page_player_metadata_tooltips", "match_detail_ingested": False}, "cumulative_audit": audit, "matchdays": [{"matchday": row["matchday"], "state": row["state"], "source_hash": row["source_hash"], "revision_count": len(row["revisions"])} for row in snapshots], "players": [player for row in snapshots for player in row["players"]], "form_analytics": form_analytics(snapshots)}
    _write(directory / "index.json", index)
    return index


def _check_market(root: Path, profile: object, fetcher: FetchPage, players: list[dict[str, object]], checked_at: str) -> dict[str, object]:
    ownership = {}
    for cohort, query in (("overall", {"ruoli": "fcit"}), ("lte9", {"ruoli": "fcit", "leghe": "piccole"}), ("gte10", {"ruoli": "fcit", "leghe": "grandi"})):
        ownership[cohort] = parse_ownership(fetcher(f"{OWNERSHIP_URL}?{urlencode(query)}"), profile.season.season, cohort)
    if len({value["source_date"] for value in ownership.values()}) != 1:
        raise FcoIntelligenceError("Ownership cohorts report different source dates.")
    prices = parse_prices(fetcher(PRICE_URL), profile.season.season)
    by_key: dict[tuple[str, str], dict[str, object]] = {}
    for cohort, parsed in ownership.items():
        for row in parsed["rows"]:
            key = (normalize(row["provider_name"]), normalize(row["provider_team"]))
            target = by_key.setdefault(key, {"provider_name": row["provider_name"], "provider_team": row["provider_team"], "quotation": row["quotation"], "ownership": {}})
            target["ownership"][cohort] = {"pct": row["ownership_pct"], "delta_7d": row["ownership_delta_7d"]}
    for row in prices["rows"]:
        key = (normalize(row["provider_name"]), normalize(row["provider_team"]))
        target = by_key.setdefault(key, {"provider_name": row["provider_name"], "provider_team": row["provider_team"], "quotation": row["quotation"], "ownership": {}})
        target.update({field: row[field] for field in (*PRICE_FIELDS, "new_player")})
    resolved, unresolved = _resolve(list(by_key.values()), players)
    _require_unique_canonical(resolved, "market snapshot")
    participant_count = len(profile.participants.team_names)
    active_ownership = "lte9" if participant_count <= 9 else "gte10"
    active_price_cohort, incompatibility = _price_cohort(participant_count, profile.credits.starting)
    price_field = active_price_cohort["field"] if active_price_cohort else None
    benchmark = _benchmark_cohort(participant_count)
    for row in resolved:
        selected = row["ownership"].get(active_ownership, {})
        row.update({"ownership_pct": selected.get("pct"), "ownership_delta_7d": selected.get("delta_7d"), "ownership_cohort": active_ownership, "market_source_date": ownership["overall"]["source_date"], "price_source_date": prices["source_date"], "price_cohort_compatible": active_price_cohort is not None, "price_cohort_reason": incompatibility, "active_league": {"participants": participant_count, "credits": profile.credits.starting}, "market_price": row.get(price_field) if price_field else None, "market_price_cohort": active_price_cohort, "benchmark_market_price": row.get(benchmark["field"]) if benchmark else None, "benchmark_market_price_cohort": benchmark})
    source_date = ownership["overall"]["source_date"]
    snapshot = {"schema_version": "1.0", "provider": PROVIDER, "season": profile.season.season, "checked_at": checked_at, "market_source_date": source_date, "price_source_date": prices["source_date"], "minimum_auctions": 3, "ownership_source": "observed FCO league ownership percentage", "ownership_cohorts": ["overall", "lte9", "gte10"], "active_ownership_cohort": active_ownership, "active_league": {"participants": participant_count, "credits": profile.credits.starting}, "price_cohort_compatible": active_price_cohort is not None, "price_cohort_reason": incompatibility, "active_price_cohort": active_price_cohort, "benchmark_price_cohort": benchmark, "players": resolved, "unresolved": unresolved, "summary": {"ownership_rows": len(ownership["overall"]["rows"]), "price_rows": len(prices["rows"]), "players": len(resolved), "current_season_prices": sum(any(row.get(field, {}).get("current_season") for field in PRICE_FIELDS) for row in resolved), "fallback_prices": sum(any(row.get(field, {}).get("fallback_previous_season") for field in PRICE_FIELDS) for row in resolved), "new_players": sum(bool(row.get("new_player")) for row in resolved), "unresolved": len(unresolved), "unresolved_classifications": _unresolved_summary(unresolved)}}
    directory = _directory(root, profile, "market-v1")
    _store_market(directory, snapshot)
    return snapshot


def _check_forecast(root: Path, profile: object, fetcher: FetchPage, players: list[dict[str, object]], checked_at: str) -> dict[str, object]:
    source_url = FORECAST_URL.format(season=_slug(profile.season.season))
    parsed = parse_forecast(fetcher(source_url), profile.season.season)
    resolved, unresolved = _resolve(parsed["rows"], players)
    _require_unique_canonical(resolved, "forecast snapshot")
    snapshot = {"schema_version": "1.0", "provider": PROVIDER, "season": profile.season.season, "checked_at": checked_at, "source_url": source_url, "source_date": parsed["source_date"], "source_rows": len(parsed["rows"]), "resolved": len(resolved), "unresolved_classifications": _unresolved_summary(unresolved), "players": resolved, "unresolved": unresolved}
    _write(_directory(root, profile, "forecast-v1") / "latest.json", snapshot)
    return snapshot


def _check_lineups(root: Path, profile: object, fetcher: FetchPage, players: list[dict[str, object]], checked_at: str, performance: dict[str, object]) -> dict[str, object]:
    latest = int(performance.get("latest_played_matchday", 0))
    current = next((row for row in performance.get("matchdays", []) if row.get("matchday") == latest), {})
    matchday = latest if current.get("state") == "provisional" else min(38, latest + 1)
    parsed = parse_lineups(fetcher(lineup_url(profile.season.season, matchday)), profile.season.season, matchday)
    resolved, unresolved = _resolve(parsed["rows"], players)
    _require_unique_canonical(resolved, "lineup probability snapshot")
    snapshot = {"schema_version": "1.0", "provider": PROVIDER, "season": profile.season.season, "checked_at": checked_at, "source_url": lineup_url(profile.season.season, matchday), "matchday": matchday, "observation_at": parsed["observation_at"], "active_source_count": parsed["active_source_count"], "evaluated_players": parsed["evaluated_players"], "source_state": parsed["source_state"], "fixtures": parsed["fixtures"], "players": resolved, "unresolved": unresolved, "unresolved_classifications": _unresolved_summary(unresolved), "content_hash": _hash({"fixtures": parsed["fixtures"], "players": resolved, "unresolved": unresolved})}
    directory = _directory(root, profile, "lineup-probability-v1")
    stamp = re.sub(r"[^0-9]", "", parsed["observation_at"])
    history = directory / "history" / f"{matchday:02}-{stamp}.json"
    if not history.exists():
        _write(history, {key: value for key, value in snapshot.items() if key != "checked_at"}, immutable=True)
    _write(directory / "latest.json", snapshot)
    return snapshot


def _calendar_source(profile: object) -> Path:
    source = next((item for item in profile.current_sources if item.name == "serie_a_calendar"), None)
    if source is None:
        raise FixtureContextError("The active profile does not declare a Serie A calendar.")
    return Path(source.path)


def _check_fixture_context(root: Path, profile: object, fetcher: FetchPage, checked_at: str, performance: dict[str, object], lineups: dict[str, object] | None) -> dict[str, object]:
    calendar = read_calendar(_calendar_source(profile))
    expected = OFFICIAL_2026_27_DIGEST if profile.season.season == "2026/27" else None
    calendar_validation = validate_calendar(calendar, expected_digest=expected)
    current_matchday = int((lineups or {}).get("matchday") or performance.get("latest_played_matchday") or 1)
    round_snapshot = _read(_directory(root, profile, "performance-v1") / "matchdays" / f"{current_matchday:02}.json") or {}
    current_fixtures = round_snapshot.get("fixtures") or (lineups or {}).get("fixtures") or []
    if len(current_fixtures) != 10:
        raise FixtureContextError("Current fixture state is unavailable.")
    state_by_pair = {(normalize(row["home_team"]), normalize(row["away_team"])): _fixture_state(str(row.get("status", ""))) for row in current_fixtures}
    directory = _directory(root, profile, "fixture-context-v1")
    stored_strength = _read(directory / "team-strength.json")
    contexts = []
    for fixture in current_fixtures:
        state = state_by_pair[(normalize(fixture["home_team"]), normalize(fixture["away_team"]))]
        if stored_strength and state != "upcoming":
            continue
        url = match_url(profile.season.season, current_matchday, fixture["home_team"], fixture["away_team"])
        contexts.append(parse_match_context(fetcher(url), profile.season.season, current_matchday, fixture["home_team"], fixture["away_team"]))
    if stored_strength:
        teams = stored_strength.get("teams", [])
        if len(teams) != 20:
            raise FixtureContextError("Stored FCO team-strength snapshot is incomplete.")
        known = {row["normalized_team"]: row["strength"] for row in teams}
        for row in merge_strengths(contexts, require_all=False):
            if known.get(row["normalized_team"]) != row["strength"]:
                raise FixtureContextError(f"Conflicting antepost strength for {row['team']}.")
    else:
        teams = merge_strengths(contexts)
        stored_strength = {"schema_version": "1.0", "provider": PROVIDER, "season": profile.season.season, "checked_at": checked_at, "semantic_label": STRENGTH_LABEL, "scale_min": 0, "scale_max": 10, "teams": teams}
        _write(directory / "team-strength.json", stored_strength)
    markets, states = {}, {}
    by_fixture = {(normalize(row["home_team"]), normalize(row["away_team"])): row for row in contexts}
    for fixture in current_fixtures:
        pair = (normalize(fixture["home_team"]), normalize(fixture["away_team"]))
        key = f"{current_matchday}:{pair[0]}:{pair[1]}"
        states[key] = state_by_pair[pair]
        context = by_fixture.get(pair)
        if context and context.get("market") and state_by_pair[pair] == "upcoming":
            markets[key] = context["market"]
    fixture_rows = build_fixture_rows(calendar, teams, states, markets)
    observations = sorted({row["observation_at"] for row in markets.values()})
    snapshot = {"schema_version": "1.0", "provider": PROVIDER, "season": profile.season.season, "checked_at": checked_at, "calendar": calendar_validation, "team_strength": {**stored_strength, "team_count": len(teams)}, "current_matchday": current_matchday, "near_term_markets": {"fixture_count": len(markets), "observation_at": observations[-1] if observations else None}, "fixtures": fixture_rows}
    _write(directory / "latest.json", snapshot)
    return snapshot


def check_updates(root: Path, profile: object, fetcher: FetchPage = fetch_page, *, force: bool = False, now: datetime | None = None) -> dict[str, object]:
    """Refresh P1 sources; any failed source keeps its last valid snapshot."""
    moment = now or datetime.now(timezone.utc)
    checked_at = moment.isoformat()
    players = _active_players(profile)
    result = _status(root, profile)
    errors = {}
    for name, action in (
        ("performance", lambda: _check_performance(root, profile, fetcher, players, checked_at, force)),
        ("market", lambda: _check_market(root, profile, fetcher, players, checked_at)),
        ("forecast", lambda: _check_forecast(root, profile, fetcher, players, checked_at)),
    ):
        if not force and _fresh(result.get(name), moment):
            continue
        try:
            result[name] = action()
        except Exception as error:
            errors[name] = str(error)
    try:
        performance = result.get("performance") or {}
        if not force and _fresh(result.get("lineups"), moment):
            pass
        elif performance:
            result["lineups"] = _check_lineups(root, profile, fetcher, players, checked_at, performance)
        else:
            raise FcoIntelligenceError("Performance matchday is unavailable, so the upcoming round is unknown.")
    except Exception as error:
        errors["lineups"] = str(error)
    try:
        if not force and _fresh(result.get("fixture_context"), moment):
            pass
        elif result.get("performance"):
            result["fixture_context"] = _check_fixture_context(root, profile, fetcher, checked_at, result["performance"], result.get("lineups"))
        else:
            raise FixtureContextError("Performance fixture state is unavailable.")
    except Exception as error:
        errors["fixture_context"] = str(error)
    result["errors"] = errors
    result["state"] = "error" if errors else "fresh"
    return result
