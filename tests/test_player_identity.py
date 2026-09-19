import json

import pandas as pd

from advisor.player_identity import (
    apply_safe_id_repairs, audit_titolari_identities, backfill_titolari_ids,
    load_identity_overrides, normalize_team, resolve_player,
)


PLAYERS = [
    {"Id": 1, "Nome": "Rossi M.", "Squadra": "Milan"},
    {"Id": 2, "Nome": "Martínez José", "Squadra": "Inter"},
    {"Id": 3, "Nome": "De Ketelaere C.", "Squadra": "Atalanta"},
    {"Id": 4, "Nome": "Rossi A.", "Squadra": "Milan"},
    {"Id": 5, "Nome": "Ceduto C.", "Squadra": "Roma"},
]


def resolve(name, team, **kwargs):
    return resolve_player(name, team, PLAYERS, source="test", **kwargs)


def test_exact_accents_hyphens_and_surname_initial_variants():
    assert resolve("Martinez Jose", "Inter")["method"] == "exact"
    assert resolve("C. De Ketelaere", "Atalanta")["method"] == "safe_variant"
    assert resolve("Rossi", "Milan")["reason"] == "ambiguous"
    roma = [{"Id": 6, "Nome": "De Marzi", "Squadra": "Roma"}]
    assert not resolve_player("De Roon Marten", "Roma", roma, source="test")["matched"]
    milan = [{"Id": 7, "Nome": "Terracciano", "Squadra": "Milan"}, {"Id": 8, "Nome": "Terracciano F.", "Squadra": "Milan"}]
    assert resolve_player("Terracciano Filippo", "Milan", milan, source="test")["player"]["Id"] == 8


def test_fuzzy_margin_threshold_and_below_threshold_are_conservative():
    close = [{"Id": 10, "Nome": "Bianchi Marco", "Squadra": "Roma"}, {"Id": 11, "Nome": "Bianchi Mario", "Squadra": "Roma"}]
    result = resolve_player("Bianchi Mar", "Roma", close, source="test")
    assert not result["matched"] and result["reason"] == "ambiguous"
    result = resolve("Rossi Zzzzzzz", "Milan")
    assert not result["matched"] and result["reason"] == "below_threshold"


def test_global_source_alias_invalid_alias_team_and_inactive_diagnostics(tmp_path):
    archive = tmp_path / "aliases.json"
    archive.write_text(json.dumps({"overrides": [
        {"source": "*", "name": "Global", "team": "Inter", "id_fantacalcio": 2, "confirmed": True},
        {"source": "test", "name": "Local", "team": "Milan", "id_fantacalcio": 1, "confirmed": True},
        {"source": "test", "name": "Bad", "team": "Milan", "id_fantacalcio": 999, "confirmed": True},
    ]}))
    aliases = load_identity_overrides(archive)
    assert resolve_player("Global", "Inter", PLAYERS, source="other", overrides=aliases)["method"] == "override"
    assert resolve("Local", "Milan", overrides=aliases)["method"] == "override"
    assert resolve("Bad", "Milan", overrides=aliases)["reason"] == "invalid_override_id"
    assert resolve("Any", "Unknown")["reason"] == "team_not_in_active_listone"
    assert resolve("Ceduto C.", "Roma", active_ids={1, 2, 3, 4})["reason"] == "player_not_in_active_listone"


def test_existing_id_validation_and_conflict():
    assert resolve("Rossi M.", "Milan", existing_id="1")["method"] == "existing_id"
    assert resolve("Rossi M.", "Milan", existing_id="999")["reason"] == "invalid_existing_id"
    assert resolve("Someone", "Inter", existing_id="1")["reason"] == "canonical_identity_conflict"


def test_titolari_backfill_is_safe_atomic_and_preserves_other_fields(tmp_path):
    path = tmp_path / "titolari.csv"
    pd.DataFrame([
        {"squadra": "Inter", "nome": "Martinez Jose", "id_fantacalcio": "", "status": "TITOLARE", "note": "keep", "gerarchia_portiere": ""},
        {"squadra": "Milan", "nome": "Rossi", "id_fantacalcio": "", "status": "RISERVA", "note": "fuzzy", "gerarchia_portiere": ""},
        {"squadra": "Inter", "nome": "Wrong", "id_fantacalcio": "1", "status": "BALLOTTAGGIO", "note": "conflict", "gerarchia_portiere": "PRIMO"},
    ]).to_csv(path, index=False)
    result = backfill_titolari_ids(path, pd.DataFrame(PLAYERS))
    rows = pd.read_csv(path, dtype=str, keep_default_na=False)
    assert rows.loc[0, "id_fantacalcio"] == "2"
    assert rows.loc[1, "id_fantacalcio"] == ""
    assert rows.loc[2, "id_fantacalcio"] == "1"
    assert rows.loc[2, "gerarchia_portiere"] == "PRIMO"
    assert rows.loc[0, "note"] == "keep"
    assert result["conflicts"] == 1 and not list(tmp_path.glob("tmp*"))


def test_provider_team_aliases_are_a_conservative_superset():
    assert [normalize_team(value) for value in (
        "Bologna FC", "Cagliari Calcio", "Como 1907", "Genoa CFC", "Juventus FC",
        "Parma Calcio 1913", "Torino FC", "US Sassuolo Calcio",
    )] == ["bologna", "cagliari", "como", "genoa", "juventus", "parma", "torino", "sassuolo"]


def test_identity_cleanup_proposes_and_atomically_applies_only_safe_repairs(tmp_path):
    path = tmp_path / "titolari.csv"
    pd.DataFrame([
        {"squadra": "Inter", "nome": "Martinez Jose", "id_fantacalcio": "1", "status": "TITOLARE", "note": "keep"},
        {"squadra": "Roma", "nome": "Ceduto C.", "id_fantacalcio": "", "status": "RISERVA", "note": "gone"},
        {"squadra": "Milan", "nome": "Rossi", "id_fantacalcio": "", "status": "BALLOTTAGGIO", "note": "review"},
    ]).to_csv(path, index=False)
    active = pd.DataFrame(PLAYERS[:4])
    ceduti = pd.DataFrame([PLAYERS[4]])
    audit = audit_titolari_identities(path, active, ceduti)
    assert audit["safe_repair_count"] == 1
    assert audit["unresolved"][0]["classification"] == "confirmed_ceduto"
    assert audit["unresolved"][1]["classification"] == "ambiguous"
    result = apply_safe_id_repairs(path, active, ceduti, audit["source_hash"])
    rows = pd.read_csv(path, dtype=str, keep_default_na=False)
    assert result["applied"] == 1 and rows.loc[0, "id_fantacalcio"] == "2"
    assert rows.loc[0, "note"] == "keep" and rows.loc[2, "id_fantacalcio"] == ""
    try:
        apply_safe_id_repairs(path, active, ceduti, audit["source_hash"])
    except ValueError as error:
        assert "changed after review" in str(error)
    else:
        raise AssertionError("stale source hash was accepted")
