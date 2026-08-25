import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from advisor.league_profile import LeagueProfile
from advisor.server import create_server


class LocalApiServerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.calls = []
        self.profile = json.loads((Path(__file__).parents[1] / "config/default_profile.json").read_text(encoding="utf-8"))
        self.profile["profile_id"] = "my-team"
        calendar_source = next(source for source in self.profile["current_sources"] if source["name"] == "league_calendar")
        calendar_source["path"] = str(root / "missing-calendar.xlsx")
        self.profile = json.loads(LeagueProfile.from_dict(self.profile).canonical_json())

        def generator(profile, datasets_dir):
            self.calls.append(profile)
            path = datasets_dir / profile.profile_id / profile.season.season.replace("/", "-") / "auction_data.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{"generated":true}', encoding="utf-8")

        def simulator(profile, output_dir, iterations, seed):
            self.calls.append((profile, output_dir, iterations, seed))
            return {"iterations": iterations, "diagnostics": {"seed": seed}, "teams": {}, "scenarios": {}, "rosters": {}}

        self.server = create_server(
            ("127.0.0.1", 0),
            profiles_dir=root / "config/profiles",
            datasets_dir=root / "data/processed",
            uploads_dir=root / "data/uploads",
            generator=generator,
            simulator=simulator,
        )
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        self.temp_dir.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response, json.loads(payload) if payload else None

    def test_profiles_round_trip_and_index(self):
        body = json.dumps(self.profile).encode("utf-8")
        response, payload = self.request("PUT", "/api/profiles/my-team", body, {"Content-Type": "application/json"})
        self.assertEqual(response.status, 200)
        self.assertEqual(payload, self.profile)

        response, payload = self.request("GET", "/api/profiles")
        self.assertEqual(response.status, 200)
        self.assertEqual(payload, {"profiles": ["my-team"]})

        response, payload = self.request("GET", "/api/profiles/my-team")
        self.assertEqual(response.status, 200)
        self.assertEqual(payload, self.profile)

    def test_rejects_unsafe_names_and_invalid_json_boundaries(self):
        response, payload = self.request("PUT", "/api/profiles/%2E%2E", b'{}', {"Content-Type": "application/json"})
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_profile_name")

        response, payload = self.request("PUT", "/api/profiles/team", b'[]', {"Content-Type": "application/json"})
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_json")

        response, payload = self.request("PUT", "/api/profiles/team", b'{"value":NaN}', {"Content-Type": "application/json"})
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_json")

        response, payload = self.request("PUT", "/api/profiles/team", b'{}')
        self.assertEqual(response.status, 415)
        self.assertEqual(payload["error"]["code"], "invalid_content_type")

        response, payload = self.request("PUT", "/api/profiles/team", b'{}', {"Content-Type": "application/json"})
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_profile")

    def test_manifest_generation_and_vite_cors(self):
        dataset = Path(self.temp_dir.name) / "data/processed/auction_data.json"
        dataset.parent.mkdir(parents=True)
        dataset.write_text("{}", encoding="utf-8")

        response, payload = self.request("GET", "/api/datasets/manifest", headers={"Origin": "http://localhost:5173"})
        self.assertEqual(response.status, 200)
        self.assertEqual(payload["datasets"][0]["path"], "auction_data.json")
        self.assertEqual(response.getheader("Access-Control-Allow-Origin"), "http://localhost:5173")

        response, _ = self.request("PUT", "/api/profiles/my-team", json.dumps(self.profile).encode("utf-8"), {"Content-Type": "application/json"})
        self.assertEqual(response.status, 200)

        response, payload = self.request("POST", "/api/generate", b'{"profile_id":"my-team"}', {"Content-Type": "application/json"})
        self.assertEqual(response.status, 200)
        self.assertEqual(payload["profile_id"], "my-team")
        self.assertEqual(payload["profile_hash"], LeagueProfile.from_dict(self.profile).configuration_hash)
        self.assertEqual(payload["dataset_path"], "my-team/2026-27/auction_data.json")
        self.assertEqual(payload["dataset_manifest"]["datasets"][1]["path"], "my-team/2026-27/auction_data.json")
        self.assertEqual(self.calls[0].profile_id, "my-team")

        response, dataset_payload = self.request("GET", f"/api/datasets/{payload['dataset_path']}", headers={"Origin": "http://localhost:5173"})
        self.assertEqual(response.status, 200)
        self.assertEqual(dataset_payload, {"generated": True})
        self.assertEqual(response.getheader("Access-Control-Allow-Origin"), "http://localhost:5173")

        inline = self.profile.copy()
        inline["profile_id"] = "inline-team"
        response, payload = self.request("POST", "/api/generate", json.dumps({"profile": inline}).encode("utf-8"), {"Content-Type": "application/json"})
        self.assertEqual(response.status, 200)
        self.assertEqual(payload["profile_id"], "inline-team")
        self.assertEqual(self.calls[1].profile_id, "inline-team")

    def test_options_and_invalid_generation_profile_are_structured(self):
        response, payload = self.request("OPTIONS", "/api/generate", headers={"Origin": "http://127.0.0.1:5173"})
        self.assertEqual(response.status, 204)
        self.assertIsNone(payload)
        self.assertEqual(response.getheader("Access-Control-Allow-Methods"), "GET, PUT, POST, DELETE, OPTIONS")

        response, payload = self.request("POST", "/api/generate", b'{}', {"Content-Type": "application/json"})
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_profile")

    def test_profiles_can_be_deleted_and_report_missing_names(self):
        profile = {**self.profile, "profile_id": "throwaway"}
        response, _ = self.request("PUT", "/api/profiles/throwaway", json.dumps(profile).encode("utf-8"), {"Content-Type": "application/json"})
        self.assertEqual(response.status, 200)

        response, payload = self.request("GET", "/api/profiles")
        self.assertIn("throwaway", payload["profiles"])

        response, payload = self.request("DELETE", "/api/profiles/throwaway")
        self.assertEqual(response.status, 200)
        self.assertEqual(payload, {"profile_id": "throwaway", "deleted": True})

        response, payload = self.request("GET", "/api/profiles")
        self.assertNotIn("throwaway", payload["profiles"])

        response, payload = self.request("DELETE", "/api/profiles/throwaway")
        self.assertEqual(response.status, 404)
        self.assertEqual(payload["error"]["code"], "profile_not_found")

        response, payload = self.request("DELETE", "/api/profiles/not%20a%20name")
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_profile_name")

        response, payload = self.request("DELETE", "/api/datasets/anything.json")
        self.assertEqual(response.status, 404)
        self.assertEqual(payload["error"]["code"], "not_found")

    def test_generation_reports_invalid_source_data(self):
        def invalid_generator(profile, datasets_dir):
            raise ValueError("league calendar teams must match profile participants")

        self.server.generator = invalid_generator
        response, payload = self.request(
            "POST",
            "/api/generate",
            json.dumps({"profile": self.profile}).encode("utf-8"),
            {"Content-Type": "application/json"},
        )

        self.assertEqual(response.status, 422)
        self.assertEqual(payload["error"]["code"], "invalid_source_data")
        self.assertEqual(
            payload["error"]["message"],
            "league calendar teams must match profile participants",
        )

    def test_generation_derives_participants_from_calendar(self):
        calendar = {
            "schema_version": "1.0",
            "league_id": "my-team",
            "teams": ["Alpha", "Beta", "Gamma"],
            "participants_count": 3,
            "matchdays": [
                {
                    "number": 1,
                    "serie_a_matchday": 1,
                    "fixtures": [{"home": "Alpha", "away": "Beta"}],
                }
            ],
        }
        calendar_path = Path(self.temp_dir.name) / "calendar.json"
        calendar_path.write_text(json.dumps(calendar), encoding="utf-8")
        source = next(source for source in self.profile["current_sources"] if source["name"] == "league_calendar")
        source.update(path=str(calendar_path), format="json")

        response, payload = self.request(
            "POST",
            "/api/generate",
            json.dumps({"profile": self.profile}).encode("utf-8"),
            {"Content-Type": "application/json"},
        )

        self.assertEqual(response.status, 200)
        self.assertEqual(self.calls[-1].participants.team_names, ("Alpha", "Beta", "Gamma"))
        self.assertEqual(self.calls[-1].participants.user_team, "Alpha")
        self.assertEqual(payload["profile_hash"], self.calls[-1].configuration_hash)

        response, payload = self.request("POST", "/api/generate", b'{"profile":{}}', {"Content-Type": "application/json"})
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_profile")

    def test_simulation_overwrites_the_current_report(self):
        response, payload = self.request("POST", "/api/simulate", json.dumps({"profile": self.profile, "iterations": 2000, "seed": 42}).encode("utf-8"), {"Content-Type": "application/json"})

        self.assertEqual(response.status, 200)
        self.assertEqual(payload["iterations"], 2000)
        self.assertEqual(payload["diagnostics"]["seed"], 42)
        self.assertEqual(self.calls[-1][2:], (2000, 42))

        response, payload = self.request("POST", "/api/simulate", json.dumps({"profile": self.profile, "iterations": 99}).encode("utf-8"), {"Content-Type": "application/json"})
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_iterations")

    def test_dataset_read_rejects_unsafe_or_missing_paths(self):
        response, payload = self.request("GET", "/api/datasets/%2E%2E/secret.json")
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_dataset_path")

        response, payload = self.request("GET", "/api/datasets/auction_data.csv")
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_dataset_path")

        response, payload = self.request("GET", "/api/datasets/missing.json")
        self.assertEqual(response.status, 404)
        self.assertEqual(payload["error"]["code"], "dataset_not_found")

    def test_uploads_fixed_sources_and_reports_missing_files(self):
        self.profile["current_sources"][0]["path"] = str(
            Path(self.temp_dir.name) / "missing.xlsx"
        )
        response, payload = self.request(
            "POST",
            "/api/sources/status",
            json.dumps(self.profile).encode("utf-8"),
            {"Content-Type": "application/json"},
        )
        self.assertEqual(response.status, 200)
        player_list = next(
            source for source in payload["sources"] if source["name"] == "player_list"
        )
        self.assertFalse(player_list["exists"])

        response, payload = self.request(
            "PUT",
            "/api/uploads/my-team/current_sources/player_list",
            b"workbook contents",
            {
                "Content-Type": "application/octet-stream",
                "X-Filename": "listone.xlsx",
            },
        )
        self.assertEqual(response.status, 200)
        self.assertTrue(Path(payload["path"]).is_file())
        self.profile["current_sources"][0]["path"] = payload["path"]

        response, payload = self.request(
            "POST",
            "/api/sources/status",
            json.dumps(self.profile).encode("utf-8"),
            {"Content-Type": "application/json"},
        )
        player_list = next(
            source for source in payload["sources"] if source["name"] == "player_list"
        )
        self.assertTrue(player_list["exists"])

    def test_upload_rejects_unsafe_paths_and_file_types(self):
        response, payload = self.request(
            "PUT",
            "/api/uploads/my-team/current_sources/%2E%2E",
            b"value",
            {"X-Filename": "file.xlsx"},
        )
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_upload_path")

        response, payload = self.request(
            "PUT",
            "/api/uploads/my-team/current_sources/player_list",
            b"value",
            {"X-Filename": "script.exe"},
        )
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_upload_type")

if __name__ == "__main__":
    unittest.main()
