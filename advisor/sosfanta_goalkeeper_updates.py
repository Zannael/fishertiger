"""Deterministic SOS Fanta goalkeeper hierarchy updates."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import tempfile
import threading
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from bs4 import BeautifulSoup, Tag
from .player_identity import load_identity_overrides, normalize, resolve_player
from .sosfanta_updates import MAX_PAGE_BYTES, SosFantaError, fetch_page

FetchPage = Callable[[str], str]
GOALKEEPER_URL = "https://www.sosfanta.com/consigli-fantacalcio/portieri/fantacalcio-asta-tutti-portieri-gerarchie-seriea-venti-squadre-campionato/"
TEAMS = ["Atalanta", "Bologna", "Cagliari", "Como", "Fiorentina", "Frosinone", "Genoa", "Inter", "Juventus", "Lazio", "Lecce", "Milan", "Monza", "Napoli", "Parma", "Roma", "Sassuolo", "Torino", "Udinese", "Venezia"]
FIELDS = ("Primo", "Secondo", "Terzo", "Note")
_LOCKS: dict[Path, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _text(tag: Tag) -> str:
    return re.sub(r"\s+", " ", tag.get_text(" ", strip=True)).strip()


def _season_in_title(season: str, title: str) -> bool:
    match = re.fullmatch(r"(\d{4})/(\d{2}|\d{4})", str(season).strip())
    if not match:
        raise SosFantaError("The selected season must use YYYY/YY or YYYY/YYYY format.")
    start = int(match.group(1))
    raw_end = match.group(2)
    end = int(str(start)[:2] + raw_end) if len(raw_end) == 2 else int(raw_end)
    if end != start + 1 or not any(value in title for value in (f"{start}/{str(end)[-2:]}", f"{start}/{end}", f"{start}-{str(end)[-2:]}", f"{start}-{end}")):
        return False
    return True


def extract_goalkeeper_hierarchies(html: str, season: str) -> list[dict[str, object]]:
    if not isinstance(html, str) or len(html.encode("utf-8")) > MAX_PAGE_BYTES:
        raise SosFantaError("SOS Fanta returned an invalid or unexpectedly large page.")
    soup = BeautifulSoup(html, "html.parser")
    article = soup.select_one("#article-content")
    title = soup.select_one("h1")
    title_text = _text(title) if title else ""
    if article is None or not _season_in_title(season, title_text) or "portier" not in title_text.lower():
        raise SosFantaError("The SOS Fanta page does not contain the requested goalkeeper article.")

    result: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    expected = "team"
    for child in article.find_all(recursive=False):
        if not isinstance(child, Tag) or child.name != "p":
            continue
        text = _text(child)
        if not text:
            continue
        emphasized = child.find(["strong", "b"])
        team_text = _text(emphasized) if emphasized else ""
        if text.startswith("🧤") and team_text and normalize(text.removeprefix("🧤").strip()) == normalize(team_text):
            if current is not None and expected != "team":
                raise SosFantaError(f"The {current['team']} goalkeeper hierarchy is incomplete.")
            if team_text.title() not in TEAMS:
                raise SosFantaError(f"Unknown team in goalkeeper article: {team_text}.")
            current = {"team": team_text.title()}
            result.append(current)
            expected = "Primo"
            continue
        if current is None:
            continue
        if expected == "team" and (text.startswith(("📝", "📲", "📌")) or (child.find("a") and text.lower().startswith(("qui ", "scarica ")))):
            continue
        emphasis = child.find(["em", "i"])
        label = _text(emphasis).strip(" :") if emphasis else ""
        if label != expected or ":" not in text:
            raise SosFantaError(f"The {current['team']} goalkeeper hierarchy is unexpected or reordered.")
        value = text.split(":", 1)[1].strip()
        if not value:
            raise SosFantaError(f"The {current['team']} {label} value is empty.")
        current[label.lower()] = value
        expected = FIELDS[FIELDS.index(label) + 1] if label != "Note" else "team"
    if current is not None and expected != "team":
        raise SosFantaError(f"The {current['team']} goalkeeper hierarchy is incomplete.")
    if [item["team"] for item in result] != TEAMS:
        raise SosFantaError("The SOS Fanta goalkeeper article must contain the 20 Serie A teams in order.")
    return result


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fetch_snapshot(season: str, fetcher: FetchPage = fetch_page) -> dict[str, object]:
    teams = extract_goalkeeper_hierarchies(fetcher(GOALKEEPER_URL), season)
    return {"schema_version": "1.0", "source": "SOS Fanta Portieri", "season": season, "fetched_at": datetime.now(timezone.utc).isoformat(), "urls": [GOALKEEPER_URL], "content_hash": hashlib.sha256(_canonical(teams).encode()).hexdigest(), "teams": teams}


def snapshot_directory(root: Path, profile_id: str, season: str) -> Path:
    return root / profile_id / season.replace("/", "-") / "sosfanta-goalkeepers-v1"


def _transaction(directory: Path):
    with _LOCKS_GUARD:
        lock = _LOCKS.setdefault(directory.resolve(), threading.Lock())
    return lock


def _read(path: Path, season: str) -> dict[str, object] | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SosFantaError("The stored goalkeeper snapshot is invalid.") from error
    if value.get("schema_version") != "1.0" or value.get("source") != "SOS Fanta Portieri" or value.get("season") != season or value.get("urls") != [GOALKEEPER_URL] or not isinstance(value.get("teams"), list) or value.get("content_hash") != hashlib.sha256(_canonical(value["teams"]).encode()).hexdigest():
        raise SosFantaError("The stored goalkeeper snapshot is invalid or failed its integrity check.")
    return value


def _write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
        temporary = Path(handle.name)
    temporary.replace(path)


def _diff(old: dict[str, object] | None, new: dict[str, object]) -> list[dict[str, object]]:
    if old is None:
        return []
    before = {item["team"]: item for item in old["teams"]}
    return [{"team": team, "change": "modified", "old": before[team], "new": item} for item in new["teams"] if before.get(team) != item]


def check_updates(root: Path, profile_id: str, season: str, fetcher: FetchPage = fetch_page) -> dict[str, object]:
    directory = snapshot_directory(root, profile_id, season)
    with _transaction(directory):
        accepted = _read(directory / "accepted.json", season)
        latest = fetch_snapshot(season, fetcher)
        _write(directory / "latest.json", latest)
    state = "baseline_missing" if accepted is None else ("unchanged" if accepted["content_hash"] == latest["content_hash"] else "changed")
    return {"source": "sosfanta-goalkeepers", "season": season, "state": state, "source_url": GOALKEEPER_URL, "checked_at": latest["fetched_at"], "content_hash": latest["content_hash"], "changes": _diff(accepted, latest), "change_count": len(_diff(accepted, latest))}


def stored_status(root: Path, profile_id: str, season: str) -> dict[str, object]:
    directory = snapshot_directory(root, profile_id, season)
    with _transaction(directory):
        accepted = _read(directory / "accepted.json", season)
        latest = _read(directory / "latest.json", season)
    if latest is None:
        return {"source": "sosfanta-goalkeepers", "season": season, "state": "never_checked", "changes": [], "change_count": 0}
    changes = _diff(accepted, latest)
    return {"source": "sosfanta-goalkeepers", "season": season, "state": "baseline_missing" if accepted is None else ("unchanged" if accepted["content_hash"] == latest["content_hash"] else "changed"), "source_url": GOALKEEPER_URL, "checked_at": latest["fetched_at"], "content_hash": latest["content_hash"], "changes": changes, "change_count": len(changes)}


def _resolve(name: str, team: str, listone: pd.DataFrame) -> list[dict[str, object]]:
    result = resolve_player(name.split(",", 1)[0], team, listone.to_dict("records"), source="sosfanta-goalkeepers", overrides=load_identity_overrides())
    if not result["matched"]:
        return []
    row = result["player"]
    return [{"id": int(row["Id"]), "name": str(row["Nome"]), "team": str(row["Squadra"])}]


def _hierarchy_candidates(value: str, team: str, listone: pd.DataFrame) -> list[dict[str, object]]:
    candidates = []
    for part in value.split("/"):
        candidates.extend(_resolve(part.strip(), team, listone))
    unique = {candidate["id"]: candidate for candidate in candidates}
    return list(unique.values())


def _load_sources(starters_path: Path, listone_path: Path) -> tuple[list[dict[str, str]], list[str], pd.DataFrame, str]:
    try:
        csv_text = starters_path.read_text(encoding="utf-8-sig")
        reader = csv.DictReader(io.StringIO(csv_text))
        rows = list(reader)
        fieldnames = list(reader.fieldnames or [])
        listone = pd.read_excel(listone_path, sheet_name="Tutti", header=1)
        ceduti = pd.read_excel(listone_path, sheet_name="Ceduti", header=1)
    except (OSError, ValueError, pd.errors.ParserError) as error:
        raise SosFantaError("The titolari CSV or listone is unavailable or invalid.") from error
    if not rows or not {"squadra", "nome", "id_fantacalcio", "status", "note"}.issubset(fieldnames):
        raise SosFantaError("The titolari CSV does not have the expected columns.")
    active = listone[listone["R"].eq("P") & ~listone["Id"].isin(set(ceduti["Id"].dropna()))].copy()
    return rows, fieldnames, active, csv_text


def _reviewed(root: Path, profile_id: str, season: str, expected_hash: str) -> dict[str, object]:
    latest = _read(snapshot_directory(root, profile_id, season) / "latest.json", season)
    if latest is None or latest["content_hash"] != expected_hash:
        raise SosFantaError("Run a goalkeeper update check and review the latest snapshot before applying it.")
    return latest


def apply_update(root: Path, profile_id: str, season: str, starters_path: Path, listone_path: Path, expected_hash: str, regenerate: Callable[[], object]) -> dict[str, object]:
    directory = snapshot_directory(root, profile_id, season)
    with _transaction(directory):
        snapshot = _reviewed(root, profile_id, season, expected_hash)
        rows, fieldnames, listone, original = _load_sources(starters_path, listone_path)
        resolved = []
        skipped = []
        for team_record in snapshot["teams"]:
            first = _hierarchy_candidates(team_record["primo"], team_record["team"], listone)
            second = _hierarchy_candidates(team_record["secondo"], team_record["team"], listone)
            third = _hierarchy_candidates(team_record["terzo"], team_record["team"], listone)
            if "/" in str(team_record["primo"]):
                choices = _hierarchy_candidates(team_record["primo"], team_record["team"], listone) + _hierarchy_candidates(team_record["secondo"], team_record["team"], listone)
                choices = list({candidate["id"]: candidate for candidate in choices}.values())
                first = second = choices
            for rank, candidates in ((1, first), (2, second), (3, third)):
                if "/" in str(team_record["primo"]) and rank == 2:
                    continue
                if not candidates:
                    skipped.append({"team": team_record["team"], "rank": rank, "value": team_record[{1: "primo", 2: "secondo", 3: "terzo"}[rank]], "reason": "not present in active listone"})
                elif "/" in str(team_record["primo"]) and rank == 1:
                    resolved.extend((team_record, rank, candidate) for candidate in candidates)
                elif len(candidates) == 1:
                    resolved.append((team_record, rank, candidates[0]))
                else:
                    raise SosFantaError(f"Cannot apply goalkeeper hierarchy; ambiguous {team_record['team']} rank {rank}: {team_record[{1: 'primo', 2: 'secondo', 3: 'terzo'}[rank]]}.")
        ids = [row.get("id_fantacalcio", "") for row in rows if row.get("id_fantacalcio", "")]
        identities = [(normalize(row["squadra"]), normalize(row["nome"])) for row in rows]
        if len(ids) != len(set(ids)) or len(identities) != len(set(identities)):
            raise SosFantaError("Cannot apply goalkeeper hierarchy while titolari.csv contains duplicate IDs or player identities.")
        by_id = {str(row.get("id_fantacalcio", "")): row for row in rows if row.get("id_fantacalcio", "")}
        by_identity = {(normalize(row["squadra"]), normalize(row["nome"])): row for row in rows}
        for team_record, rank, player in resolved:
            key = str(player["id"])
            row = by_id.get(key) or by_identity.get((normalize(player["team"]), normalize(player["name"])))
            if row is None:
                row = {"squadra": player["team"], "nome": player["name"], "id_fantacalcio": key, "status": "", "note": ""}
                rows.append(row)
            row["squadra"], row["nome"], row["id_fantacalcio"] = player["team"], player["name"], key
            first_value = str(team_record["primo"])
            row["status"] = "BALLOTTAGGIO" if "/" in first_value and rank in (1, 2) else ("TITOLARE" if rank == 1 else "RISERVA")
            row["gerarchia_portiere"] = "PRIMO/SECONDO" if "/" in first_value and rank in (1, 2) else {1: "PRIMO", 2: "SECONDO", 3: "TERZO"}[rank]
            rank_note = "primo/secondo" if "/" in first_value and rank in (1, 2) else ["", "primo", "secondo", "terzo"][rank]
            row["note"] = f"SOS Fanta gerarchia portieri {season}: {rank_note}. {team_record['note']}"
        if "gerarchia_portiere" not in fieldnames:
            fieldnames.append("gerarchia_portiere")
        for row in rows:
            row.setdefault("gerarchia_portiere", "")
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=starters_path.parent, delete=False) as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)
            temporary = Path(handle.name)
        try:
            temporary.replace(starters_path)
            written = starters_path.read_bytes()
            verified = list(csv.DictReader(io.StringIO(written.decode("utf-8-sig"))))
            applied_ids = {str(player["id"]) for _, _, player in resolved}
            verified_by_id = {row.get("id_fantacalcio", ""): row for row in verified}
            if any(not verified_by_id.get(player_id, {}).get("gerarchia_portiere") for player_id in applied_ids):
                raise OSError("The goalkeeper hierarchy was not persisted to titolari.csv.")
            regenerate()
            _write(directory / "accepted.json", snapshot)
        except Exception:
            starters_path.write_text(original, encoding="utf-8")
            raise
    return {"source": "sosfanta-goalkeepers", "season": season, "state": "unchanged", "content_hash": expected_hash, "updated_rows": len(resolved), "added_rows": sum(1 for team, rank, player in resolved if not (str(player["id"]) in by_id or (normalize(player["team"]), normalize(player["name"])) in by_identity)), "skipped": skipped, "starters_path": str(starters_path.resolve()), "starters_hash": hashlib.sha256(written).hexdigest()}


def accept_latest(root: Path, profile_id: str, season: str, expected_hash: str) -> dict[str, object]:
    directory = snapshot_directory(root, profile_id, season)
    with _transaction(directory):
        latest = _reviewed(root, profile_id, season, expected_hash)
        _write(directory / "accepted.json", latest)
    return {"source": "sosfanta-goalkeepers", "season": season, "state": "unchanged", "content_hash": expected_hash}
