import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

from advisor.sosfanta_formations_updates import (
    accept_latest,
    apply_safe_updates,
    audit_starters,
    build_bundle,
    check_updates,
    extract_formations,
    formations_url,
    semantic_diff,
    snapshot_directory,
    stored_status,
)
from advisor.sosfanta_updates import MAX_PAGE_BYTES, SosFantaError


TEAMS = [
    "ATALANTA", "BOLOGNA", "CAGLIARI", "COMO", "FIORENTINA", "GENOA", "INTER",
    "JUVENTUS", "LAZIO", "LECCE", "MILAN", "NAPOLI", "PARMA", "PISA", "ROMA",
    "SASSUOLO", "TORINO", "UDINESE", "VERONA", "VENEZIA",
]


def article(first_slot="Player 0A", first_ballot="Player 0B insidia Player 0A."):
    sections = ["<p>Introduzione promozionale.</p>", "<div class='ad'>advertisement</div>"]
    for index, team in enumerate(TEAMS):
        goalkeeper = first_slot if index == 0 else f"Player {index}A"
        if index == 0:
            defense = "Player 0B/Player 0C/Player 0D, Player 0E, Player 0F"
        else:
            defense = f"Player {index}B, Player {index}C, Player {index}D"
        formation = (
            f"{goalkeeper}; {defense}; Player {index}G, Player {index}H, Player {index}I, Player {index}J; "
            f"Player {index}K, Player {index}L, Player {index}M"
        )
        ballot = first_ballot if index == 0 else f"Nessun dubbio per {team}."
        sections.append(
            f"<p><strong>{team}</strong></p>"
            f"<p><em>Formazione-tipo</em>: {formation}.</p>"
            f"<div class='ad'>ad {index}</div><p><b>I ballottaggi:</b> {ballot}</p>"
        )
    return "<html><h1>Formazioni-tipo Serie A 2026/27</h1><div id='article-content'>" + "".join(sections) + "</div></html>"


def write_sources(root: Path, teams, statuses=None, unresolved=False):
    players = []
    rows = []
    player_id = 1
    statuses = statuses or {}
    for team in teams:
        for slot in team["slots"]:
            for name in slot["candidates"]:
                canonical_name = "Unknown" if unresolved and player_id == 1 else name
                players.append({"Id": player_id, "Nome": canonical_name, "Squadra": team["team"]})
                rows.append({
                    "squadra": team["team"], "nome": name, "id_fantacalcio": player_id,
                    "status": statuses.get(player_id, "TITOLARE" if len(slot["candidates"]) == 1 else "BALLOTTAGGIO"),
                    "note": "",
                })
                player_id += 1
    starters = root / "titolari.csv"
    listone = root / "listone.xlsx"
    pd.DataFrame(rows).to_csv(starters, index=False)
    with pd.ExcelWriter(listone) as writer:
        pd.DataFrame(players).to_excel(writer, sheet_name="Tutti", index=False, startrow=1)
        pd.DataFrame(columns=["Id", "Nome", "Squadra"]).to_excel(writer, sheet_name="Ceduti", index=False, startrow=1)
    return starters, listone


class SosFantaFormationsUpdatesTests(unittest.TestCase):
    def test_url_and_realistic_parser(self):
        self.assertEqual(
            formations_url("2026/27"),
            "https://www.sosfanta.com/asta-fantacalcio/seriea-tutte-formazioni-tipo-fantacalcio-2026-2027-asta-consigli-chi-prendere/",
        )
        self.assertEqual(formations_url("2026/2027"), formations_url("2026/27"))
        teams = extract_formations(article(), "2026/27")
        self.assertEqual(len(teams), 20)
        self.assertEqual(teams[0]["team"], "Atalanta")
        self.assertEqual(teams[0]["slots"][1]["candidates"], ["Player 0B", "Player 0C", "Player 0D"])
        self.assertEqual(len(teams[0]["slots"]), 11)
        self.assertEqual(teams[0]["diagnostics"], [])
        self.assertFalse(teams[0]["formation_text"].endswith("."))

        ten_player = extract_formations(article().replace(", Player 0M", "", 1), "2026/27")
        self.assertEqual(len(ten_player[0]["slots"]), 10)
        self.assertIn("10 slots", ten_player[0]["diagnostics"][0])

    def test_parser_rejects_invalid_inputs(self):
        with self.assertRaises(SosFantaError):
            formations_url("2026/28")
        with self.assertRaises(SosFantaError):
            extract_formations(article().replace("2026/27", "2025/26", 1), "2026/27")
        with self.assertRaises(SosFantaError):
            extract_formations(article().replace("<p><b>I ballottaggi:</b> Player 0B insidia Player 0A.</p>", "<p>Unexpected.</p><p><b>I ballottaggi:</b> Player 0B insidia Player 0A.</p>"), "2026/27")
        with self.assertRaises(SosFantaError):
            extract_formations(article().replace("<p><strong>VENEZIA</strong></p>", ""), "2026/27")
        with self.assertRaises(SosFantaError):
            extract_formations(article().replace(", Player 0L, Player 0M", "", 1), "2026/27")
        with self.assertRaises(SosFantaError):
            extract_formations("x" * (MAX_PAGE_BYTES + 1), "2026/27")

    def test_semantic_diff_is_team_focused(self):
        old = {"teams": extract_formations(article(), "2026/27")}
        new = {"teams": extract_formations(article("Replacement/Player 0A", "Replacement is preferred."), "2026/27")}
        changes = semantic_diff(old, new)
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["team"], "Atalanta")
        self.assertEqual(changes[0]["old_text"], ["Player 0B insidia Player 0A"])
        self.assertEqual(changes[0]["new_text"], ["Replacement is preferred"])
        same_prose = {"teams": extract_formations(article("Replacement/Player 0A"), "2026/27")}
        self.assertEqual(semantic_diff(old, same_prose)[0]["old_text"], [])

    def test_audit_statuses_and_unresolved_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            teams = extract_formations(article(), "2026/27")
            starters, listone = write_sources(root, teams, {1: "RISERVA", 2: "INVALID"})
            snapshot = {
                "schema_version": "1.0", "source": "SOS Fanta Formazioni", "season": "2026/27",
                "fetched_at": "2026-08-31T12:00:00+00:00", "urls": [formations_url("2026/27")],
                "content_hash": "", "teams": teams,
            }
            from advisor.sosfanta_formations_updates import _canonical_hash
            snapshot["content_hash"] = _canonical_hash(teams)
            audit = audit_starters(snapshot, starters, listone)
            self.assertEqual(audit["summary"]["status_mismatch"], 1)
            self.assertEqual(audit["summary"]["invalid_status"], 1)
            self.assertTrue(audit["audit_hash"])
            self.assertEqual(audit["sources"]["starters"]["path"], str(starters.resolve()))
            self.assertEqual(len(audit["sources"]["player_list"]["sha256"]), 64)
            self.assertIn("formation_text", audit["findings"][0])

            rows = pd.read_csv(starters, dtype=str)
            rows.loc[0, "id_fantacalcio"] = ""
            rows.loc[0, "nome"] = "Nobody"
            rows.to_csv(starters, index=False)
            unresolved = audit_starters(snapshot, starters, listone)
            self.assertGreaterEqual(unresolved["summary"]["unresolved_identity"], 1)

            players = pd.read_excel(listone, sheet_name="Tutti", header=1)
            players.loc[1, "Nome"] = players.loc[0, "Nome"]
            players.loc[1, "Squadra"] = players.loc[0, "Squadra"]
            with pd.ExcelWriter(listone) as writer:
                players.to_excel(writer, sheet_name="Tutti", index=False, startrow=1)
                pd.DataFrame(columns=["Id", "Nome", "Squadra"]).to_excel(writer, sheet_name="Ceduti", index=False, startrow=1)
            ambiguous = audit_starters(snapshot, starters, listone)
            self.assertTrue(any(
                finding["diagnostic"] == "multiple equally scored candidates"
                for finding in ambiguous["findings"]
                if finding["issue"] == "unresolved_identity"
            ))

    def test_initial_bundle_accept_status_stale_audit_and_noop(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            teams = extract_formations(article(), "2026/27")
            starters, listone = write_sources(root, teams)
            initial = check_updates(root, "profile", "2026/27", starters, listone, lambda _: article())
            self.assertEqual(initial["state"], "baseline_missing")
            self.assertTrue(initial["bundle_available"])
            bundle = build_bundle(root, "profile", "2026/27", starters, listone, initial["content_hash"], initial["audit_hash"])
            self.assertIn('"formations": [', bundle)
            self.assertIn("Slash order is not a hierarchy", bundle)
            with self.assertRaises(SosFantaError):
                build_bundle(root, "profile", "2026/27", starters, listone, initial["content_hash"], "stale")

            rows = pd.read_csv(starters, dtype=str, keep_default_na=False)
            rows.loc[0, "note"] = "Changed after review"
            rows.to_csv(starters, index=False)
            with self.assertRaises(SosFantaError):
                build_bundle(root, "profile", "2026/27", starters, listone, initial["content_hash"], initial["audit_hash"])
            rows.loc[0, "note"] = ""
            rows.to_csv(starters, index=False)

            accept_latest(root, "profile", "2026/27", initial["content_hash"])
            status = stored_status(root, "profile", "2026/27", starters, listone)
            self.assertEqual(status["state"], "unchanged")
            self.assertFalse(status["bundle_available"])
            with self.assertRaises(SosFantaError):
                build_bundle(root, "profile", "2026/27", starters, listone, status["content_hash"], status["audit_hash"])

            changed = check_updates(root, "profile", "2026/27", starters, listone, lambda _: article("Replacement/Player 0A"))
            self.assertEqual(changed["state"], "changed")
            self.assertTrue(changed["bundle_available"])
            self.assertNotEqual(initial["audit_hash"], changed["audit_hash"])

    def test_never_checked_and_namespace(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            status = stored_status(root, "profile", "2026/27", root / "missing.csv", root / "missing.xlsx")
            self.assertEqual(status["state"], "never_checked")
            self.assertIsNone(status["audit"])
            self.assertFalse(status["bundle_available"])
            self.assertEqual(snapshot_directory(root, "profile", "2026/27").name, "sosfanta-formations-v1")

            snapshot = snapshot_directory(root, "profile", "2026/27") / "latest.json"
            snapshot.parent.mkdir(parents=True)
            snapshot.write_text("{}", encoding="utf-8")
            with self.assertRaises(SosFantaError):
                stored_status(root, "profile", "2026/27", root / "missing.csv", root / "missing.xlsx")

    def test_check_and_accept_share_a_snapshot_transaction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            teams = extract_formations(article(), "2026/27")
            starters, listone = write_sources(root, teams)
            baseline = check_updates(root, "profile", "2026/27", starters, listone, lambda _: article())
            accept_latest(root, "profile", "2026/27", baseline["content_hash"])
            fetching = threading.Event()
            release = threading.Event()

            def changed_fetcher(_url):
                fetching.set()
                release.wait(timeout=2)
                return article(first_ballot="Changed hierarchy.")

            with ThreadPoolExecutor(max_workers=2) as pool:
                checking = pool.submit(
                    check_updates, root, "profile", "2026/27", starters, listone, changed_fetcher,
                )
                self.assertTrue(fetching.wait(timeout=2))
                accepting = pool.submit(
                    accept_latest, root, "profile", "2026/27", baseline["content_hash"],
                )
                self.assertFalse(accepting.done())
                release.set()
                checking.result(timeout=5)
                with self.assertRaises(SosFantaError):
                    accepting.result(timeout=5)

    def test_safe_apply_updates_structural_status_adds_missing_and_preserves_omissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            teams = extract_formations(article(), "2026/27")
            starters, listone = write_sources(root, teams)
            rows = pd.read_csv(starters, dtype=str)
            rows.loc[0, "status"] = "RISERVA"
            rows.loc[0, "id_fantacalcio"] = ""
            missing_id = rows.loc[1, "id_fantacalcio"]
            rows = rows.drop(index=1)
            rows.loc[len(rows)] = {"squadra": "Atalanta", "nome": "Omitted", "id_fantacalcio": "9999", "status": "RISERVA", "note": "keep"}
            rows.to_csv(starters, index=False)
            initial = check_updates(root, "profile", "2026/27", starters, listone, lambda _: article())
            before = initial["audit"]["summary"]["issue_count"]
            applied = apply_safe_updates(root, "profile", "2026/27", starters, listone, initial["content_hash"], initial["audit_hash"], lambda: None)
            after = pd.read_csv(starters, dtype=str, keep_default_na=False)
            self.assertEqual(after.loc[after.nome == "Player 0A", "status"].iloc[0], "TITOLARE")
            self.assertEqual(after.loc[after.nome == "Player 0A", "id_fantacalcio"].iloc[0], "")
            self.assertEqual(after.loc[after.id_fantacalcio == missing_id, "status"].iloc[0], "BALLOTTAGGIO")
            self.assertEqual(after.loc[after.id_fantacalcio == "9999", "note"].iloc[0], "keep")
            self.assertLess(applied["audit"]["summary"]["issue_count"], before)
            with self.assertRaises(SosFantaError):
                apply_safe_updates(root, "profile", "2026/27", starters, listone, initial["content_hash"], initial["audit_hash"], lambda: None)


if __name__ == "__main__":
    unittest.main()
