"""Runtime Serie A injury snapshots from Fantacalcio Online."""
from __future__ import annotations

import hashlib
import json
import re
import tempfile
import threading
from collections.abc import Callable
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup
from .player_identity import load_identity_overrides, normalize, resolve_player
from .player_list_updates import active_player_list_path, read_player_list, season_years

SOURCE_URL = "https://www.fantacalcio-online.com/it/infortunati-serie-a"
TTL_SECONDS = 4 * 60 * 60
SOURCE_STALE_SECONDS = 48 * 60 * 60
MAX_RESPONSE_BYTES = 5_000_000
FetchPage = Callable[[str], str]
HEADERS = ("Squadra", "Calciatore", "Perché è fuori", "Rientro previsto", "La data arriva da")
_LOCKS: dict[Path, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()

class InjuryUpdateError(ValueError):
    """The remote page, player source, or stored snapshot is invalid."""


def _clean_text(value: object, limit: int = 500) -> str:
    return re.sub(r"\s+", " ", value).strip()[:limit] if isinstance(value, str) else ""


def fetch_page(url: str) -> str:
    request = Request(url, headers={"User-Agent": "Fishertiger/1.0", "Accept": "text/html,application/xhtml+xml"})
    try:
        with urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise InjuryUpdateError(f"Fantacalcio Online returned HTTP {response.status}.")
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                raise InjuryUpdateError("Fantacalcio Online returned an unexpectedly large response.")
            charset = response.headers.get_content_charset() or "utf-8"
    except InjuryUpdateError:
        raise
    except Exception as error:
        raise InjuryUpdateError("Fantacalcio Online could not be reached.") from error
    try:
        return payload.decode(charset)
    except (LookupError, UnicodeDecodeError) as error:
        raise InjuryUpdateError("Fantacalcio Online returned invalid HTML encoding.") from error


def parse_fantacalcio_online_injuries(html: str, season: str) -> dict[str, object]:
    """Strictly parse the authorized FCO injury page without doing I/O."""
    start, end = season_years(season)
    soup = BeautifulSoup(html, "html.parser")
    page_text = _clean_text(soup.get_text(" "), 2_000_000)
    season_markers = [
        match.groups()
        for text in soup.find_all(string=True)
        if (match := re.fullmatch(r"\s*Serie A\s+(\d{4})-(\d{4})\s*", str(text), re.IGNORECASE))
    ]
    if season_markers != [(str(start), str(end))]:
        raise InjuryUpdateError("Fantacalcio Online page season does not match the active profile.")
    summary = re.search(
        r"Al\s+(\d{2}/\d{2}/\d{4})\s+i calciatori di Serie A ufficialmente infortunati\s+sono\s+(\d+)",
        page_text, re.IGNORECASE,
    )
    if not summary:
        raise InjuryUpdateError("Fantacalcio Online injury summary is missing or changed.")
    try:
        source_date = datetime.strptime(summary.group(1), "%d/%m/%Y").date().isoformat()
    except ValueError as error:
        raise InjuryUpdateError("Fantacalcio Online source date is invalid.") from error
    source_count = int(summary.group(2))
    if source_count <= 0:
        raise InjuryUpdateError("Fantacalcio Online declared an empty injury list.")

    wanted = tuple(normalize(value) for value in HEADERS)
    tables = []
    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        if rows and tuple(normalize(cell.get_text(" ", strip=True)) for cell in rows[0].find_all(["th", "td"])) == wanted:
            tables.append(rows)
    if len(tables) != 1:
        raise InjuryUpdateError("Fantacalcio Online did not expose exactly one expected injury table.")

    records: list[dict[str, object]] = []
    identities: set[tuple[str, str]] = set()
    for row in tables[0][1:]:
        cells = row.find_all("td")
        if not cells and not _clean_text(row.get_text(" ")):
            continue
        if len(cells) != 5:
            raise InjuryUpdateError("Fantacalcio Online injury table row does not have exactly five cells.")
        team, player, reason, return_date, provenance = (_clean_text(cell.get_text(" ", strip=True)) for cell in cells)
        if not team or not player or not return_date or not provenance:
            raise InjuryUpdateError("Fantacalcio Online injury row is missing a required value.")
        try:
            expected_return = datetime.strptime(return_date, "%d/%m/%Y").date().isoformat()
        except ValueError as error:
            raise InjuryUpdateError("Fantacalcio Online returned an invalid expected return date.") from error
        identity = (normalize(team), normalize(player))
        if identity in identities:
            raise InjuryUpdateError("Fantacalcio Online returned a duplicate team/player row.")
        identities.add(identity)
        records.append({
            "provider_player_name": player, "provider_team_name": team, "reason": reason,
            "expected_return": expected_return, "return_date_source": provenance,
            "availability": "OUT", "cause": "INJURY", "source": "fantacalcio-online",
        })
    if not records or len(records) != source_count:
        raise InjuryUpdateError("Fantacalcio Online parsed row count does not match its declared injury count.")
    return {"source_date": source_date, "source_count": source_count, "records": records}


def match_player(provider_name: str, provider_team: str, players: list[dict[str, object]]) -> dict[str, object]:
    result = resolve_player(provider_name, provider_team, players, source="fantacalcio-online", overrides=load_identity_overrides())
    if result.get("method") == "safe_variant":
        result["method"] = "fuzzy_unique"
    result["reason"] = {"ambiguous": "player_ambiguous", "team_not_in_active_listone": "team_unmatched", "below_threshold": "player_unmatched", "player_not_in_active_listone": "player_unmatched"}.get(result.get("reason"), result.get("reason"))
    return result


def match_injuries(records: list[dict[str, object]], players: list[dict[str, object]]) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    resolved, unresolved = [], []
    for record in records:
        match = resolve_player(str(record["provider_player_name"]), str(record["provider_team_name"]), players, source="fantacalcio-online", overrides=load_identity_overrides())
        if not match["matched"]:
            legacy = {"ambiguous": "player_ambiguous", "team_not_in_active_listone": "team_unmatched", "below_threshold": "player_unmatched"}.get(match["reason"], match["reason"])
            unresolved.append({**record, "match_failure": legacy, "reason_code": match["reason"], **{key: value for key, value in match.items() if key not in {"matched", "reason"}}})
            continue
        candidate = match["player"]
        resolved.append({**record, "fantacalcio_id": int(candidate["Id"]), "fantacalcio_name": str(candidate["Nome"]), "fantacalcio_team": str(candidate["Squadra"]), "role": str(candidate["R"]), "match_method": match["method"], "match_score": match["score"]})
    return sorted(resolved, key=lambda item: (item["fantacalcio_team"], item["fantacalcio_name"])), unresolved


def snapshot_directory(root: Path, profile_id: str, season: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", profile_id):
        raise InjuryUpdateError("The profile ID is invalid.")
    start, end = season_years(season)
    return root / profile_id / f"{start}-{str(end)[-2:]}" / "injuries-v2"


@contextmanager
def _snapshot_transaction(directory: Path):
    with _LOCKS_GUARD:
        lock = _LOCKS.setdefault(directory.resolve(), threading.Lock())
    with lock:
        yield


def _snapshot_path(root: Path, profile_id: str, season: str) -> Path:
    return snapshot_directory(root, profile_id, season) / "latest.json"


def _read_snapshot(path: Path, season: str) -> dict[str, object] | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InjuryUpdateError("The stored injury snapshot is invalid.") from error
    if (not isinstance(value, dict) or value.get("schema_version") != "2.0" or value.get("provider") != "fantacalcio-online" or value.get("season") != season or value.get("source_url") != SOURCE_URL or not isinstance(value.get("source_date"), str) or not isinstance(value.get("checked_at"), str) or not isinstance(value.get("source_count"), int) or not isinstance(value.get("players"), list) or not isinstance(value.get("unresolved"), list) or not isinstance(value.get("summary"), dict)):
        raise InjuryUpdateError("The stored injury snapshot is invalid.")
    canonical = json.dumps({"players": value["players"], "unresolved": value["unresolved"]}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if value.get("content_hash") != hashlib.sha256(canonical.encode()).hexdigest():
        raise InjuryUpdateError("The stored injury snapshot failed its integrity check.")
    return value


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            temporary = Path(handle.name)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _age(snapshot: dict[str, object] | None, now: datetime) -> float | None:
    if snapshot is None:
        return None
    try:
        checked = datetime.fromisoformat(str(snapshot["checked_at"]).replace("Z", "+00:00"))
        if checked.tzinfo is None:
            checked = checked.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError) as error:
        raise InjuryUpdateError("The stored injury snapshot has an invalid timestamp.") from error
    return max(0.0, (now - checked.astimezone(timezone.utc)).total_seconds())


def _status(snapshot: dict[str, object] | None, now: datetime, state: str, warning: str | None = None) -> dict[str, object]:
    age = _age(snapshot, now)
    source_age = None
    if snapshot is not None:
        try:
            source_date = datetime.strptime(str(snapshot["source_date"]), "%Y-%m-%d").replace(tzinfo=timezone.utc)
            source_age = max(0.0, (now - source_date).total_seconds())
        except (KeyError, TypeError, ValueError) as error:
            raise InjuryUpdateError("The stored injury snapshot has an invalid source date.") from error
    stale_source = source_age is not None and source_age > SOURCE_STALE_SECONDS
    if state == "fresh" and stale_source:
        state = "stale_source"
        warning = warning or "Fantacalcio Online source date is older than 48 hours."
    return {"state": state, "configured": True, "fresh": state in {"fresh", "stale_source"}, "cache_age_seconds": round(age) if age is not None else None, "source_age_seconds": round(source_age) if source_age is not None else None, "source_fresh": not stale_source if source_age is not None else None, "ttl_seconds": TTL_SECONDS, "snapshot": snapshot, "warning": warning}


def stored_status(root: Path, profile_id: str, season: str, *, now: datetime | None = None) -> dict[str, object]:
    moment = now or datetime.now(timezone.utc)
    path = _snapshot_path(root, profile_id, season)
    with _snapshot_transaction(path.parent):
        snapshot = _read_snapshot(path, season)
    age = _age(snapshot, moment)
    return _status(snapshot, moment, "never_checked" if snapshot is None else "fresh" if age <= TTL_SECONDS else "stale")


def _active_players(profile: object) -> list[dict[str, object]]:
    frame, ceduti = read_player_list(active_player_list_path(profile))
    active = frame.loc[~frame["Id"].isin(set(ceduti["Id"]))]
    return [{"Id": int(row.Id), "R": str(row.R), "Nome": str(row.Nome), "Squadra": str(row.Squadra)} for row in active.itertuples()]


def check_updates(root: Path, profile: object, fetcher: FetchPage = fetch_page, *, force: bool = False, now: datetime | None = None) -> dict[str, object]:
    season = profile.season.season
    moment = now or datetime.now(timezone.utc)
    path = _snapshot_path(root, profile.profile_id, season)
    with _snapshot_transaction(path.parent):
        previous = _read_snapshot(path, season)
        if previous is not None and not force and (_age(previous, moment) or 0) <= TTL_SECONDS:
            return _status(previous, moment, "fresh")
        try:
            parsed = parse_fantacalcio_online_injuries(fetcher(SOURCE_URL), season)
            players, unresolved = match_injuries(parsed["records"], _active_players(profile))
            canonical = json.dumps({"players": players, "unresolved": unresolved}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            snapshot = {
                "schema_version": "2.0", "provider": "fantacalcio-online", "season": season,
                "source_url": SOURCE_URL, "source_date": parsed["source_date"], "checked_at": moment.isoformat(),
                "source_count": parsed["source_count"], "content_hash": hashlib.sha256(canonical.encode()).hexdigest(),
                "players": players, "unresolved": unresolved,
                "summary": {"out": len(players), "questionable": 0, "unresolved": len(unresolved)},
            }
            _write_json(path, snapshot)
        except Exception as error:
            return _status(previous, moment, "error", str(error))
    return _status(snapshot, moment, "fresh")
