import http.client
import json
import threading
from pathlib import Path

import pytest

from advisor.league_profile import LeagueProfile
from advisor.server import create_server


PROJECT_ROOT = Path(__file__).parents[1]
DEFAULT_PROFILE_PATH = PROJECT_ROOT / "config" / "default_profile.json"


class ApiClient:
    def __init__(self, server):
        self.server = server

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection(*self.server.server_address)
        connection.request(method, path, body=body, headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, json.loads(payload) if payload else None


@pytest.fixture
def api(tmp_path):
    generated = []

    def generator(profile, datasets_dir):
        generated.append(profile)
        dataset_path = datasets_dir / profile.profile_id / profile.season.season.replace("/", "-") / "auction_data.json"
        dataset_path.parent.mkdir(parents=True)
        dataset_path.write_text(json.dumps({
            "schema_version": "1.0",
            "meta": {"profile": {"profile_id": profile.profile_id}},
            "players": [],
        }), encoding="utf-8")

    server = create_server(
        ("127.0.0.1", 0),
        profiles_dir=tmp_path / "profiles",
        datasets_dir=tmp_path / "datasets",
        generator=generator,
    )
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield ApiClient(server), generated
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def test_default_profile_posts_to_generator_and_serves_a_scoped_frontend_dataset(api):
    client, generated = api
    profile = json.loads(DEFAULT_PROFILE_PATH.read_text(encoding="utf-8"))
    profile["profile_id"] = "profile-flow"
    next(source for source in profile["current_sources"] if source["name"] == "league_calendar")["path"] = "/missing-calendar.xlsx"
    expected_profile = LeagueProfile.from_dict(profile)

    status, saved = client.request("PUT", "/api/profiles/profile-flow", json.dumps(profile).encode())
    assert status == 200
    assert saved == {**json.loads(expected_profile.canonical_json()), "configuration_hash": expected_profile.configuration_hash}

    status, result = client.request("POST", "/api/generate", b'{"profile_id":"profile-flow"}')
    assert status == 200
    assert generated == [expected_profile]
    assert result["profile_id"] == expected_profile.profile_id
    assert result["profile_hash"] == expected_profile.configuration_hash
    assert result["dataset_path"] == "profile-flow/2026-27/auction_data.json"
    assert result["dataset_manifest"]["datasets"][0]["path"] == result["dataset_path"]

    status, dataset = client.request("GET", f"/api/datasets/{result['dataset_path']}")
    assert status == 200
    assert dataset["schema_version"] == "1.0"
    assert dataset["meta"]["profile"]["profile_id"] == result["profile_id"]
    assert isinstance(dataset["players"], list)


def test_server_rejects_profile_name_mismatches_and_invalid_setting_types(api):
    client, generated = api
    profile = json.loads(DEFAULT_PROFILE_PATH.read_text(encoding="utf-8"))
    profile["profile_id"] = "different-name"

    status, payload = client.request("PUT", "/api/profiles/saved-name", json.dumps(profile).encode())
    assert status == 400
    assert payload["error"]["code"] == "invalid_profile"

    profile["profile_id"] = "invalid-settings"
    profile["formations"]["allowed"] = None
    status, payload = client.request("PUT", "/api/profiles/invalid-settings", json.dumps(profile).encode())
    assert status == 400
    assert payload["error"]["code"] == "invalid_profile"
    assert generated == []

    status, payload = client.request("POST", "/api/generate", json.dumps({"profile": profile}).encode())
    assert status == 400
    assert payload["error"]["code"] == "invalid_profile"
    assert generated == []
