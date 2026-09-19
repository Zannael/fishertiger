"""Canonical, team-scoped identity resolution against the active Fantacalcio listone."""
from __future__ import annotations

import json
import hashlib
import re
import tempfile
import unicodedata
from pathlib import Path

import pandas as pd
from rapidfuzz import fuzz

FUZZY_THRESHOLD = 90.0
FUZZY_MARGIN = 7.0
TEAM_ALIASES = {
    "ac milan": "milan", "ac monza": "monza", "acf fiorentina": "fiorentina",
    "as roma": "roma", "bologna fc": "bologna", "cagliari calcio": "cagliari",
    "como 1907": "como", "genoa cfc": "genoa", "hellas verona": "verona", "inter milan": "inter",
    "internazionale": "inter", "internazionale milano": "inter", "ss lazio": "lazio",
    "juventus fc": "juventus", "parma calcio 1913": "parma", "ssc napoli": "napoli",
    "torino fc": "torino", "udinese calcio": "udinese", "us lecce": "lecce",
    "us sassuolo calcio": "sassuolo",
}


def normalize(value: object) -> str:
    value = unicodedata.normalize("NFKD", str(value).lower())
    value = "".join(char for char in value if not unicodedata.combining(char))
    value = re.sub(r"[^a-z0-9\s-]", "", value)
    return " ".join(value.split())


def normalize_team(value: object) -> str:
    key = normalize(value)
    return TEAM_ALIASES.get(key, key)


def load_identity_overrides(path: Path | None = None) -> dict[tuple[str, str, str], dict[str, object]]:
    path = path or Path(__file__).resolve().parents[1] / "config/identity_overrides.json"
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


def _safe_names(value: object) -> set[str]:
    name = normalize(re.sub(r"\s+-\s*$", "", str(value)).strip())
    variants = {name}
    parts = name.replace("-", " ").split()
    if len(parts) > 1:
        variants.add(" ".join(reversed(parts)))
        if len(parts[-1]) == 1:
            variants.add(f"{parts[-1]} {' '.join(parts[:-1])}")
        if len(parts[0]) == 1:
            variants.add(f"{' '.join(parts[1:])} {parts[0]}")
    return {item for item in variants if item}


def _diagnostic(reason: str, name: object, team: object, candidates: list[dict[str, object]], scored=()) -> dict[str, object]:
    ranked = list(scored)
    best = ranked[0] if ranked else (0.0, None)
    second = ranked[1] if len(ranked) > 1 else (0.0, None)
    return {
        "matched": False,
        "reason": reason,
        "normalized_source_name": normalize(name),
        "normalized_source_team": normalize(team),
        "best_candidate": str(best[1]["Nome"]) if best[1] else None,
        "best_score": round(float(best[0]), 1),
        "second_candidate": str(second[1]["Nome"]) if second[1] else None,
        "second_score": round(float(second[0]), 1),
        "candidate_ids": [int(item["Id"]) for item in candidates],
    }


def resolve_player(
    name: object,
    team: object,
    players: list[dict[str, object]],
    *,
    source: str,
    existing_id: object = None,
    overrides: dict[tuple[str, str, str], dict[str, object]] | None = None,
    active_ids: set[int] | None = None,
) -> dict[str, object]:
    active_ids = active_ids if active_ids is not None else {int(player["Id"]) for player in players}
    by_id = {int(player["Id"]): player for player in players}
    raw_id = pd.to_numeric(pd.Series([existing_id]), errors="coerce").iloc[0]
    if pd.notna(raw_id):
        player_id = int(raw_id)
        candidate = by_id.get(player_id)
        if candidate is None or player_id not in active_ids:
            return _diagnostic("invalid_existing_id", name, team, [])
        if normalize_team(candidate["Squadra"]) != normalize_team(team) or not (_safe_names(name) & _safe_names(candidate["Nome"])):
            return _diagnostic("canonical_identity_conflict", name, team, [candidate])
        return {"matched": True, "player": candidate, "method": "existing_id", "score": 100.0}

    team_candidates = [player for player in players if int(player["Id"]) in active_ids and normalize_team(player["Squadra"]) == normalize_team(team)]
    if not team_candidates:
        known_team = any(normalize_team(player["Squadra"]) == normalize_team(team) for player in players)
        return _diagnostic("player_not_in_active_listone" if known_team else "team_not_in_active_listone", name, team, [])
    clean_name = re.sub(r"\s+-\s*$", "", str(name)).strip()
    exact = [player for player in team_candidates if normalize(clean_name) == normalize(player["Nome"])]
    if len(exact) == 1:
        return {"matched": True, "player": exact[0], "method": "exact", "score": 100.0}
    variants = [player for player in team_candidates if _safe_names(name) & _safe_names(player["Nome"])]
    if len(variants) == 1:
        return {"matched": True, "player": variants[0], "method": "safe_variant", "score": 100.0}
    if len(variants) > 1:
        return _diagnostic("ambiguous", name, team, variants)
    source_tokens = set(normalize(clean_name).replace("-", " ").split())
    initial_variants = []
    for player in team_candidates:
        candidate_tokens = normalize(player["Nome"]).replace("-", " ").split()
        abbreviation = candidate_tokens[-1] if candidate_tokens and len(candidate_tokens[-1]) <= 2 else None
        words = candidate_tokens[:-1] if abbreviation else candidate_tokens
        if abbreviation and set(words) <= source_tokens and any(len(token) > len(abbreviation) and token.startswith(abbreviation) for token in source_tokens - set(words)):
            initial_variants.append(player)
    if len(initial_variants) == 1:
        return {"matched": True, "player": initial_variants[0], "method": "safe_variant", "score": 100.0}
    if len(initial_variants) > 1:
        return _diagnostic("ambiguous", name, team, initial_variants)
    surname_only = [player for player in team_candidates if set(normalize(player["Nome"]).replace("-", " ").split()) <= source_tokens]
    if len(surname_only) == 1:
        return {"matched": True, "player": surname_only[0], "method": "safe_variant", "score": 100.0}

    overrides = overrides or {}
    override = overrides.get((source, normalize(name), normalize(team))) or overrides.get(("*", normalize(name), normalize(team)))
    if override:
        candidate = by_id.get(int(override["id_fantacalcio"]))
        if candidate is None or int(candidate["Id"]) not in active_ids:
            return _diagnostic("invalid_override_id", name, team, [])
        if normalize_team(candidate["Squadra"]) != normalize_team(team):
            return _diagnostic("canonical_identity_conflict", name, team, [candidate])
        if not override.get("confirmed") and not (_safe_names(name) & _safe_names(candidate["Nome"])):
            return _diagnostic("canonical_identity_conflict", name, team, [candidate])
        return {"matched": True, "player": candidate, "method": "override", "score": 100.0}

    scored = sorted(
        ((max(fuzz.WRatio(left, right) for left in _safe_names(name) for right in _safe_names(player["Nome"])), player) for player in team_candidates),
        key=lambda item: (-item[0], int(item[1]["Id"])),
    )
    best_score = scored[0][0] if scored else 0.0
    second_score = scored[1][0] if len(scored) > 1 else 0.0
    if scored and best_score >= FUZZY_THRESHOLD and best_score - second_score >= FUZZY_MARGIN:
        return {"matched": True, "player": scored[0][1], "method": "fuzzy_unique", "score": round(float(best_score), 1)}
    candidate_tokens = {token for player in team_candidates for token in normalize(player["Nome"]).replace("-", " ").split()}
    reason = "ambiguous" if best_score >= FUZZY_THRESHOLD else "player_not_in_active_listone" if source_tokens.isdisjoint(candidate_tokens) else "below_threshold" if best_score else "no_candidate"
    return _diagnostic(reason, name, team, team_candidates, scored)


def match_manual(manual: pd.DataFrame, listone: pd.DataFrame, source: str, overrides=None) -> pd.DataFrame:
    players = listone.to_dict("records")
    rows = []
    for _, entry in manual.iterrows():
        explicit_override = (overrides or {}).get((source, normalize(entry.nome), normalize(entry.squadra))) or (overrides or {}).get(("*", normalize(entry.nome), normalize(entry.squadra)))
        if explicit_override and not explicit_override.get("confirmed"):
            candidate = listone[listone.Id == int(explicit_override["id_fantacalcio"])]
            if candidate.empty or not (_safe_names(entry.nome) & _safe_names(candidate.iloc[0].Nome)):
                raise ValueError(f"identity override for {source}:{entry.nome} / {entry.squadra} does not match canonical ID {explicit_override['id_fantacalcio']}; set confirmed=true to acknowledge it")
        result = resolve_player(entry.nome, entry.squadra, players, source=source, existing_id=entry.get("id_fantacalcio"), overrides=overrides)
        player_id = int(result["player"]["Id"]) if result["matched"] else None
        if result["matched"]:
            legacy_method = {"existing_id": "manuale", "fuzzy_unique": "auto"}.get(result["method"], result["method"])
        else:
            legacy_method = "ambiguo" if result["reason"] == "ambiguous" else "nessuno"
        rows.append([
            entry.nome, entry.squadra, player_id, result.get("score", result.get("best_score", 0.0)),
            legacy_method, source, None if result["matched"] else ("multiple equally scored candidates" if result["reason"] == "ambiguous" else "no confident candidate"),
            None if result["matched"] else result["reason"],
            result.get("best_candidate"), result.get("second_candidate"), result.get("second_score", 0.0),
        ])
    return pd.DataFrame(rows, columns=["nome_originale", "squadra", "id_matched", "score", "metodo", "source", "diagnostic", "failure_reason", "best_candidate", "second_candidate", "second_score"])


def backfill_titolari_ids(path: Path, listone: pd.DataFrame, *, overrides=None, report_path: Path | None = None) -> dict[str, object]:
    frame = pd.read_csv(path, dtype=str, keep_default_na=False)
    required = {"squadra", "nome", "id_fantacalcio"}
    if not required.issubset(frame.columns):
        raise ValueError("titolari.csv is missing identity columns")
    players = listone.to_dict("records")
    before = int(frame.id_fantacalcio.astype(bool).sum())
    exact = override_count = conflicts = 0
    unresolved = []
    for index, row in frame.iterrows():
        result = resolve_player(row.nome, row.squadra, players, source="titolari", existing_id=row.id_fantacalcio, overrides=overrides)
        if row.id_fantacalcio:
            if not result["matched"]:
                conflicts += 1
                unresolved.append({"row": int(index) + 2, "name": row.nome, "team": row.squadra, **result})
            continue
        if result["matched"] and result["method"] in {"exact", "safe_variant", "override"}:
            frame.at[index, "id_fantacalcio"] = str(int(result["player"]["Id"]))
            if result["method"] == "override": override_count += 1
            else: exact += 1
        else:
            if result["matched"]:
                result = {**result, "matched": False, "reason": "fuzzy_only_not_persisted", "best_candidate": result["player"]["Nome"], "candidate_ids": [int(result["player"]["Id"])]}
                result.pop("player", None)
            unresolved.append({"row": int(index) + 2, "name": row.nome, "team": row.squadra, **result})
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=path.parent, delete=False) as handle:
        frame.to_csv(handle, index=False, lineterminator="\n")
        temporary = Path(handle.name)
    temporary.replace(path)
    result = {"total": len(frame), "ids_before": before, "ids_after": int(frame.id_fantacalcio.astype(bool).sum()), "exact_backfilled": exact, "override_backfilled": override_count, "unresolved": unresolved, "conflicts": conflicts}
    if report_path is not None:
        report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def _file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit_titolari_identities(path: Path, listone: pd.DataFrame, ceduti: pd.DataFrame, *, overrides=None) -> dict[str, object]:
    frame = pd.read_csv(path, dtype=str, keep_default_na=False)
    active = listone.to_dict("records")
    departed = ceduti.to_dict("records")
    active_ids = {int(player["Id"]) for player in active}
    ceduti_ids = {int(player["Id"]) for player in departed}
    repairs, unresolved = [], []
    valid = conflicts = confirmed_ceduti = 0
    for index, row in frame.iterrows():
        row_number = int(index) + 2
        old_id = int(row.id_fantacalcio) if str(row.id_fantacalcio).isdigit() else None
        result = resolve_player(row.nome, row.squadra, active, source="titolari", existing_id=row.id_fantacalcio, overrides=overrides)
        if row.id_fantacalcio and result["matched"]:
            valid += 1
            continue
        if old_id in ceduti_ids:
            departed_result = resolve_player(row.nome, row.squadra, departed, source="titolari-ceduti", existing_id=old_id)
            if departed_result["matched"]:
                confirmed_ceduti += 1
                repairs.append({
                    "row": row_number, "source_name": row.nome, "team": row.squadra, "old_id": old_id,
                    "proposed_canonical_id": None, "canonical_player_name": departed_result["player"]["Nome"],
                    "resolution_method": "ceduti_existing_id", "confidence": 100.0,
                    "reason": "confirmed_ceduto", "safe": False,
                })
                unresolved.append({"row": row_number, "source_name": row.nome, "team": row.squadra, "old_id": old_id, "classification": "confirmed_ceduto", "canonical_player_name": departed_result["player"]["Nome"]})
                continue
        if row.id_fantacalcio:
            conflicts += 1
            proposed = resolve_player(row.nome, row.squadra, active, source="titolari", overrides=overrides)
            repair = {
                "row": row_number, "source_name": row.nome, "team": row.squadra, "old_id": old_id,
                "proposed_canonical_id": int(proposed["player"]["Id"]) if proposed["matched"] else None,
                "canonical_player_name": proposed["player"]["Nome"] if proposed["matched"] else proposed.get("best_candidate"),
                "resolution_method": proposed.get("method"), "confidence": proposed.get("score", proposed.get("best_score", 0.0)),
                "reason": "replacement_candidate" if proposed["matched"] else proposed["reason"],
                "safe": proposed.get("method") in {"exact", "safe_variant"},
            }
            repairs.append(repair)
            continue
        departed_result = resolve_player(row.nome, row.squadra, departed, source="titolari-ceduti")
        if departed_result["matched"] and departed_result.get("method") in {"exact", "safe_variant"}:
            confirmed_ceduti += 1
            classification = "confirmed_ceduto"
            details = {"canonical_player_name": departed_result["player"]["Nome"], "ceduto_id": int(departed_result["player"]["Id"])}
        elif result["matched"] or departed_result["matched"]:
            candidate = result if result["matched"] else departed_result
            classification = "fuzzy_candidate_requires_confirmation"
            details = {"best_candidate": candidate["player"]["Nome"], "best_score": candidate.get("score", 0.0), "candidate_id": int(candidate["player"]["Id"])}
        elif result["reason"] == "ambiguous":
            classification, details = "ambiguous", result
        elif result.get("best_candidate"):
            classification, details = "fuzzy_candidate_requires_confirmation", result
        elif result["reason"] == "player_not_in_active_listone":
            classification, details = "player_not_in_active_listone", result
        else:
            classification, details = "no_candidate", result
        unresolved.append({"row": row_number, "source_name": row.nome, "team": row.squadra, "old_id": None, "classification": classification, **details})
    return {
        "source_hash": _file_hash(path), "total": len(frame), "valid_ids": valid, "missing_ids": int((frame.id_fantacalcio == "").sum()),
        "conflicting_ids": conflicts, "confirmed_ceduti": confirmed_ceduti,
        "fuzzy_requiring_confirmation": sum(item["classification"] == "fuzzy_candidate_requires_confirmation" for item in unresolved),
        "safe_repair_count": sum(item["safe"] for item in repairs), "repairs": repairs, "unresolved": unresolved,
        "active_id_count": len(active_ids),
    }


def apply_safe_id_repairs(path: Path, listone: pd.DataFrame, ceduti: pd.DataFrame, expected_hash: str, *, overrides=None) -> dict[str, object]:
    audit = audit_titolari_identities(path, listone, ceduti, overrides=overrides)
    if not expected_hash or audit["source_hash"] != expected_hash:
        raise ValueError("titolari.csv changed after review")
    safe = {item["row"] - 2: item for item in audit["repairs"] if item["safe"]}
    if not safe:
        raise ValueError("the reviewed audit contains no safe ID repairs")
    frame = pd.read_csv(path, dtype=str, keep_default_na=False)
    for index, repair in safe.items():
        if frame.at[index, "id_fantacalcio"] != str(repair["old_id"]):
            raise ValueError("titolari.csv changed after review")
        frame.at[index, "id_fantacalcio"] = str(repair["proposed_canonical_id"])
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=path.parent, delete=False) as handle:
        frame.to_csv(handle, index=False, lineterminator="\n")
        temporary = Path(handle.name)
    temporary.replace(path)
    return {"applied": len(safe), "audit": audit_titolari_identities(path, listone, ceduti, overrides=overrides)}
