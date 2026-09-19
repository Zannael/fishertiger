import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import pytest

from advisor.generate import load_profile
from advisor.injury_updates import (
    TTL_SECONDS,
    InjuryUpdateError,
    check_updates,
    fetch_page,
    match_injuries,
    match_player,
    parse_fantacalcio_online_injuries,
    stored_status,
)
from advisor.pipeline import LISTONE_COLUMNS

NOW = datetime(2026, 9, 18, 12, tzinfo=timezone.utc)
FIXTURES = Path(__file__).parent / "fixtures/injuries"


def fixture(name="valid.html"):
    return (FIXTURES / name).read_text(encoding="utf-8")


def players():
    return [
        {"Id": 1, "R": "A", "Nome": "Rossi Mario", "Squadra": "Milan"},
        {"Id": 2, "R": "C", "Nome": "Martinez Jo.", "Squadra": "Inter"},
        {"Id": 3, "R": "D", "Nome": "Patric", "Squadra": "Lazio"},
    ]


def profile_with_list(tmp_path: Path):
    value = json.loads((Path(__file__).parents[1] / "config/default_profile.json").read_text())
    value["profile_id"] = "injury-test"
    list_path = tmp_path / "listone.xlsx"
    defaults = {column: 0 for column in LISTONE_COLUMNS}
    rows = [{**defaults, "Id": item["Id"], "R": item["R"], "RM": item["R"], "Nome": item["Nome"], "Squadra": item["Squadra"]} for item in players()]
    with pd.ExcelWriter(list_path, engine="openpyxl") as workbook:
        pd.DataFrame([["Quotazioni Fantacalcio Stagione 2026 27"]]).to_excel(workbook, sheet_name="Tutti", index=False, header=False)
        pd.DataFrame(rows, columns=sorted(LISTONE_COLUMNS)).to_excel(workbook, sheet_name="Tutti", index=False, startrow=1)
        pd.DataFrame([["Quotazioni Fantacalcio Stagione 2026 27"]]).to_excel(workbook, sheet_name="Ceduti", index=False, header=False)
        pd.DataFrame({"Id": []}).to_excel(workbook, sheet_name="Ceduti", index=False, startrow=1)
    next(source for source in value["current_sources"] if source["name"] == "player_list")["path"] = str(list_path)
    return load_profile(value)


def test_valid_parser_preserves_unicode_placeholder_and_dates():
    parsed = parse_fantacalcio_online_injuries(fixture(), "2026/27")
    assert parsed["source_date"] == "2026-09-18"
    assert parsed["source_count"] == 3
    assert parsed["records"][1]["provider_player_name"] == "MARTÍNEZ José"
    assert parsed["records"][2]["reason"] == "—"
    assert parsed["records"][0]["expected_return"] == "2026-09-22"
    assert all(item["availability"] == "OUT" and item["cause"] == "INJURY" for item in parsed["records"])


@pytest.mark.parametrize("name", [
    "count_mismatch.html", "missing_table.html", "changed_heading.html", "invalid_date.html",
    "duplicate.html", "wrong_season.html", "empty.html",
])
def test_parser_rejects_structural_drift(name):
    with pytest.raises(InjuryUpdateError):
        parse_fantacalcio_online_injuries(fixture(name), "2026/27")


def test_fetch_page_has_bounded_authorized_http_headers(monkeypatch):
    seen = {}
    class Headers:
        def get_content_charset(self): return "utf-8"
    class Response:
        status, headers = 200, Headers()
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def read(self, limit): seen["limit"] = limit; return fixture().encode()
    def open_url(request, timeout):
        seen.update(timeout=timeout, agent=request.get_header("User-agent"), accept=request.get_header("Accept"))
        return Response()
    monkeypatch.setattr("advisor.injury_updates.urlopen", open_url)
    assert "Serie A" in fetch_page("https://example.invalid")
    assert seen == {"timeout": 20, "agent": "Fishertiger/1.0", "accept": "text/html,application/xhtml+xml", "limit": 5_000_001}


def test_exact_fuzzy_and_terminal_dash_matching_are_conservative():
    assert match_player("ROSSI Mario", "Milan", players())["method"] == "exact"
    assert match_player("MARTÍNEZ José", "Inter", players())["method"] == "fuzzy_unique"
    assert match_player("PATRIC -", "Lazio", players())["method"] == "exact"


def test_ambiguous_and_unmatched_identities_are_never_guessed():
    candidates = players() + [
        {"Id": 4, "R": "A", "Nome": "Rossi M.", "Squadra": "Milan"},
        {"Id": 5, "R": "A", "Nome": "Rossi Ma.", "Squadra": "Milan"},
    ]
    assert match_player("Marco Rossi", "Milan", candidates)["reason"] == "player_ambiguous"
    assert match_player("Nobody", "Unknown", candidates)["reason"] == "team_unmatched"
    assert match_player("Nobody", "Milan", candidates)["reason"] == "player_unmatched"


def test_matching_preserves_unresolved_diagnostics():
    parsed = parse_fantacalcio_online_injuries(fixture(), "2026/27")
    resolved, unresolved = match_injuries(parsed["records"], players()[:1])
    assert [item["fantacalcio_id"] for item in resolved] == [1]
    assert {item["match_failure"] for item in unresolved} == {"team_unmatched"}


def test_check_persists_v2_atomically_and_status_obeys_ttl(tmp_path):
    profile = profile_with_list(tmp_path)
    root = tmp_path / "updates"
    result = check_updates(root, profile, lambda _url: fixture(), now=NOW)
    assert result["state"] == "fresh"
    assert result["snapshot"]["summary"] == {"out": 3, "questionable": 0, "unresolved": 0}
    directory = root / "injury-test/2026-27/injuries-v2"
    saved = json.loads((directory / "latest.json").read_text())
    assert saved["provider"] == "fantacalcio-online"
    assert saved["source_count"] == 3
    assert list(directory.iterdir()) == [directory / "latest.json"]
    assert stored_status(root, "injury-test", "2026/27", now=NOW + timedelta(seconds=TTL_SECONDS))["state"] == "fresh"
    assert stored_status(root, "injury-test", "2026/27", now=NOW + timedelta(seconds=TTL_SECONDS + 1))["state"] == "stale"


def test_fresh_cache_with_old_declared_source_date_is_warned(tmp_path):
    profile = profile_with_list(tmp_path)
    root = tmp_path / "updates"
    result = check_updates(root, profile, lambda _url: fixture(), now=NOW + timedelta(days=3))
    assert result["state"] == "stale_source"
    assert result["fresh"] is True
    assert result["source_fresh"] is False
    assert result["source_age_seconds"] > 48 * 60 * 60


def test_fresh_cache_skips_network_and_manual_force_fetches(tmp_path):
    profile = profile_with_list(tmp_path)
    root = tmp_path / "updates"
    check_updates(root, profile, lambda _url: fixture(), now=NOW)
    calls = []
    check_updates(root, profile, lambda url: calls.append(url) or fixture(), now=NOW + timedelta(hours=1))
    assert calls == []
    check_updates(root, profile, lambda url: calls.append(url) or fixture(), force=True, now=NOW + timedelta(hours=1))
    assert len(calls) == 1


def test_network_and_parser_failures_preserve_stale_cache(tmp_path):
    profile = profile_with_list(tmp_path)
    root = tmp_path / "updates"
    previous = check_updates(root, profile, lambda _url: fixture(), now=NOW)["snapshot"]
    network = check_updates(root, profile, lambda _url: (_ for _ in ()).throw(OSError("offline")), now=NOW + timedelta(hours=5))
    assert network["state"] == "error" and network["snapshot"] == previous
    broken = check_updates(root, profile, lambda _url: fixture("count_mismatch.html"), now=NOW + timedelta(hours=6))
    assert broken["state"] == "error" and broken["snapshot"] == previous
    assert json.loads(next(root.rglob("latest.json")).read_text()) == previous
