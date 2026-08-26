"""Small local HTTP API for editing profiles and triggering data generation.

Generator integration is deliberately injected: this module has no dependency on
the data pipeline and does not select a generator implementation itself.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import traceback
from collections.abc import Callable
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from .generate import (
    PipelineGenerator,
    ProfileRequestError,
    dataset_manifest,
    generate_dataset,
    load_profile,
    resolve_profile,
)


MAX_BODY_BYTES = 1_000_000
MAX_UPLOAD_BYTES = 50_000_000
PROFILE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
SOURCE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
SOURCE_GROUPS = {"current_sources", "history_sources"}
FIXED_SOURCE_SUFFIXES = {
    "current_sources": {
        "player_list": ".xlsx",
        "serie_a_calendar": ".xlsx",
        "teams": ".csv",
        "starters": ".csv",
        "set_pieces": ".csv",
        "auction_guide": ".csv",
        "league_calendar": ".xlsx",
    },
    "history_sources": {
        "stats_2025_26": ".xlsx",
        "stats_2024_25": ".xlsx",
        "stats_2023_24": ".xlsx",
    },
}
VITE_ORIGIN = re.compile(r"https?://(?:localhost|127\.0\.0\.1)(?::\d+)?\Z")
ProfileLoader = Callable[[dict[str, Any]], Any]
SimulationRunner = Callable[[Any, Path, int, int], dict[str, Any]]


class LocalApiServer(ThreadingHTTPServer):
    """HTTP server state with filesystem locations and an optional generator."""

    def __init__(
        self,
        address: tuple[str, int] = ("127.0.0.1", 8000),
        *,
        profiles_dir: Path | str = Path("config/profiles"),
        datasets_dir: Path | str = Path("data/processed"),
        uploads_dir: Path | str = Path("data/uploads"),
        default_profile_path: Path | str = Path("config/default_profile.json"),
        generator: PipelineGenerator | None = None,
        simulator: SimulationRunner | None = None,
        profile_loader: ProfileLoader = load_profile,
    ) -> None:
        self.profiles_dir = Path(profiles_dir)
        self.datasets_dir = Path(datasets_dir)
        self.uploads_dir = Path(uploads_dir)
        self.default_profile_path = Path(default_profile_path)
        self.generator = generator
        self.simulator = simulator or _simulate_current_dataset
        self.profile_loader = profile_loader
        super().__init__(address, LocalApiHandler)

    def handle_error(self, request: Any, client_address: Any) -> None:
        """Stay quiet when a client drops the connection mid-response."""
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


class LocalApiHandler(BaseHTTPRequestHandler):
    server: LocalApiServer

    def do_OPTIONS(self) -> None:
        self._send_json(HTTPStatus.NO_CONTENT, None)

    def do_GET(self) -> None:
        path = self._path()
        if path == "/api/profiles":
            self._profile_index()
        elif path == "/api/default-profile":
            self._default_profile()
        elif path.startswith("/api/profiles/"):
            self._get_profile(path.removeprefix("/api/profiles/"))
        elif path == "/api/datasets/manifest":
            self._dataset_manifest()
        elif path.startswith("/api/datasets/"):
            self._get_dataset(path.removeprefix("/api/datasets/"))
        else:
            self._error(HTTPStatus.NOT_FOUND, "not_found", "The requested endpoint does not exist.")

    def do_PUT(self) -> None:
        path = self._path()
        if path.startswith("/api/uploads/"):
            self._put_upload(path.removeprefix("/api/uploads/"))
        elif path.startswith("/api/profiles/"):
            self._put_profile(path.removeprefix("/api/profiles/"))
        else:
            self._error(HTTPStatus.NOT_FOUND, "not_found", "The requested endpoint does not exist.")

    def do_DELETE(self) -> None:
        path = self._path()
        if path.startswith("/api/profiles/"):
            self._delete_profile(path.removeprefix("/api/profiles/"))
        else:
            self._error(HTTPStatus.NOT_FOUND, "not_found", "The requested endpoint does not exist.")

    def do_POST(self) -> None:
        if self._path() == "/api/sources/status":
            self._source_status()
            return
        if self._path() == "/api/simulate":
            self._simulate()
            return
        if self._path() != "/api/generate":
            self._error(HTTPStatus.NOT_FOUND, "not_found", "The requested endpoint does not exist.")
            return
        request = self._read_json_object()
        if request is None:
            return
        try:
            profile = resolve_profile(request, self.server.profiles_dir, profile_loader=self.server.profile_loader)
            profile = self._derive_calendar_participants(profile)
        except ProfileRequestError as error:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_profile", str(error))
            return
        except (OSError, ValueError) as error:
            self._error(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_source_data", str(error))
            return
        try:
            result = generate_dataset(profile, self.server.datasets_dir, generator=self.server.generator)
        except (FileNotFoundError, ValueError) as error:
            self._error(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_source_data", str(error))
            return
        except Exception:
            traceback.print_exc(file=sys.stderr)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "generation_failed", "Generation failed.")
            return
        else:
            self._send_json(HTTPStatus.OK, result)

    def _simulate(self) -> None:
        request = self._read_json_object()
        if request is None:
            return
        try:
            profile = resolve_profile(request, self.server.profiles_dir, profile_loader=self.server.profile_loader)
            profile = self._derive_calendar_participants(profile)
        except ProfileRequestError as error:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_profile", str(error))
            return
        except (OSError, ValueError) as error:
            self._error(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_source_data", str(error))
            return
        iterations = request.get("iterations", 1000)
        seed = request.get("seed", 202627)
        if isinstance(iterations, bool) or not isinstance(iterations, int) or not 100 <= iterations <= 50000:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_iterations", "Iterations must be an integer between 100 and 50000.")
            return
        if isinstance(seed, bool) or not isinstance(seed, int):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_seed", "Seed must be an integer.")
            return
        try:
            output_dir = self.server.datasets_dir / profile.profile_id / profile.season.season.replace("/", "-")
            result = self.server.simulator(profile, output_dir, iterations, seed)
        except (FileNotFoundError, ValueError) as error:
            self._error(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_source_data", str(error))
            return
        except Exception:
            traceback.print_exc(file=sys.stderr)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "simulation_failed", "Simulation failed.")
            return
        self._send_json(HTTPStatus.OK, result)

    def _default_profile(self) -> None:
        try:
            value = json.loads(self.server.default_profile_path.read_text(encoding="utf-8"))
            profile = self.server.profile_loader(value)
            profile = self._derive_calendar_participants(profile)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "default_profile_unavailable", "The default profile is unavailable.")
            return
        self._send_json(HTTPStatus.OK, profile.to_dict())

    def _profile_index(self) -> None:
        directory = self.server.profiles_dir
        if not directory.exists():
            self._send_json(HTTPStatus.OK, {"profiles": []})
            return
        if not directory.is_dir():
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "Profile storage is unavailable.")
            return
        profiles = sorted(path.stem for path in directory.glob("*.json") if path.is_file() and PROFILE_NAME.fullmatch(path.stem))
        self._send_json(HTTPStatus.OK, {"profiles": profiles})

    def _get_profile(self, name: str) -> None:
        profile_path = self._profile_path(name)
        if profile_path is None:
            return
        try:
            profile = resolve_profile({"profile_id": name}, self.server.profiles_dir, profile_loader=self.server.profile_loader)
        except ProfileRequestError as error:
            if not profile_path.exists():
                self._error(HTTPStatus.NOT_FOUND, "profile_not_found", "The profile does not exist.")
            else:
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", str(error))
            return
        except OSError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "The stored profile is invalid or unreadable.")
            return
        try:
            self._send_json(HTTPStatus.OK, self._derive_calendar_participants(profile).to_dict())
        except (OSError, ValueError) as error:
            self._error(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_source_data", str(error))

    def _put_profile(self, name: str) -> None:
        profile_path = self._profile_path(name)
        if profile_path is None:
            return
        value = self._read_json_object()
        if value is None:
            return
        try:
            profile = self.server.profile_loader(value)
            if profile.profile_id != name:
                raise ValueError("profile_id must match the saved profile name")
        except (AttributeError, TypeError, ValueError, KeyError) as error:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_profile", str(error))
            return
        try:
            profile_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=profile_path.parent, delete=False) as handle:
                json.dump(profile.to_dict(), handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                temporary_path = Path(handle.name)
            temporary_path.replace(profile_path)
        except (OSError, TypeError, ValueError):
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "The profile could not be saved.")
            return
        self._send_json(HTTPStatus.OK, profile.to_dict())

    def _put_upload(self, relative_path: str) -> None:
        parts = relative_path.split("/")
        if (
            len(parts) != 3
            or not PROFILE_NAME.fullmatch(parts[0])
            or parts[1] not in SOURCE_GROUPS
            or not SOURCE_NAME.fullmatch(parts[2])
            or parts[2] not in FIXED_SOURCE_SUFFIXES.get(parts[1], {})
        ):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_upload_path", "Upload paths must identify a profile, source group, and source name.")
            return
        filename = self.headers.get("X-Filename", "")
        suffix = Path(filename).suffix.lower()
        expected_suffix = FIXED_SOURCE_SUFFIXES[parts[1]][parts[2]]
        if suffix != expected_suffix:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_upload_type", f"This source requires a {expected_suffix} file.")
            return
        try:
            content_length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            content_length = -1
        if content_length < 1 or content_length > MAX_UPLOAD_BYTES:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "invalid_upload_size", "Upload size must be between 1 byte and 50 MB.")
            return
        profile_id, group, source_name = parts
        target = self.server.uploads_dir / profile_id / group / f"{source_name}{suffix}"
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile("wb", dir=target.parent, delete=False) as handle:
                handle.write(self.rfile.read(content_length))
                temporary_path = Path(handle.name)
            temporary_path.replace(target)
        except OSError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "upload_failed", "The source file could not be stored.")
            return
        self._send_json(HTTPStatus.OK, {"path": target.as_posix(), "filename": Path(filename).name, "size": content_length})

    def _source_status(self) -> None:
        value = self._read_json_object()
        if value is None:
            return
        try:
            profile = self.server.profile_loader(value)
        except (AttributeError, TypeError, ValueError, KeyError) as error:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_profile", str(error))
            return
        statuses = []
        for group in SOURCE_GROUPS:
            for source in getattr(profile, group):
                declared = Path(source.path)
                candidates = [declared] if declared.is_absolute() else [declared, Path.cwd() / declared, Path(__file__).resolve().parents[1] / declared]
                existing_path = next((candidate for candidate in candidates if candidate.is_file()), None)
                statuses.append({
                    "group": group,
                    "name": source.name,
                    "path": source.path,
                    "exists": existing_path is not None,
                })
        self._send_json(HTTPStatus.OK, {"sources": statuses})

    def _derive_calendar_participants(self, profile: Any) -> Any:
        """Use the league calendar as the authoritative participant roster when available."""
        source = next((item for item in profile.current_sources if item.name == "league_calendar"), None)
        if source is None:
            return profile
        declared = Path(source.path)
        candidates = [declared] if declared.is_absolute() else [declared, Path.cwd() / declared, Path(__file__).resolve().parents[1] / declared]
        calendar_path = next((candidate for candidate in candidates if candidate.is_file()), None)
        if calendar_path is None:
            return profile
        if calendar_path.suffix.lower() == ".json":
            from .league_calendar import validate_calendar

            calendar = json.loads(calendar_path.read_text(encoding="utf-8"))
            validate_calendar(calendar)
        else:
            from .league_calendar import preprocess_legacy_calendar

            calendar = preprocess_legacy_calendar(calendar_path, profile.profile_id)
        value = profile.to_dict()
        teams = calendar["teams"]
        value["participants"] = {
            "team_names": teams,
            "user_team": profile.participants.user_team if profile.participants.user_team in teams else teams[0],
        }
        return self.server.profile_loader(value)

    def _dataset_manifest(self) -> None:
        try:
            self._send_json(HTTPStatus.OK, dataset_manifest(self.server.datasets_dir))
        except OSError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "Dataset storage is unavailable.")

    def _get_dataset(self, relative_path: str) -> None:
        dataset_path = self._safe_dataset_path(relative_path)
        if dataset_path is None:
            return
        try:
            with dataset_path.open(encoding="utf-8") as handle:
                value = json.load(handle)
        except FileNotFoundError:
            self._error(HTTPStatus.NOT_FOUND, "dataset_not_found", "The dataset does not exist.")
            return
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "The dataset is invalid or unreadable.")
            return
        self._send_json(HTTPStatus.OK, value)

    def _safe_dataset_path(self, relative_path: str) -> Path | None:
        if not relative_path or "\\" in relative_path or not relative_path.endswith(".json"):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_dataset_path", "Dataset paths must be relative JSON paths.")
            return None
        root = self.server.datasets_dir.resolve()
        candidate = (root / relative_path).resolve()
        if not candidate.is_relative_to(root):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_dataset_path", "Dataset paths must stay within dataset storage.")
            return None
        return candidate

    def _delete_profile(self, name: str) -> None:
        """Remove a stored profile; generated datasets are deliberately left in place."""
        profile_path = self._profile_path(name)
        if profile_path is None:
            return
        try:
            profile_path.unlink()
        except FileNotFoundError:
            self._error(HTTPStatus.NOT_FOUND, "profile_not_found", "The profile does not exist.")
            return
        except OSError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "The profile could not be deleted.")
            return
        self._send_json(HTTPStatus.OK, {"profile_id": name, "deleted": True})

    def _profile_path(self, name: str) -> Path | None:
        if not PROFILE_NAME.fullmatch(name):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_profile_name", "Profile names must use letters, numbers, underscores, or hyphens.")
            return None
        return self.server.profiles_dir / f"{name}.json"

    def _read_json_object(self) -> dict[str, Any] | None:
        try:
            content_length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_request", "Content-Length must be an integer.")
            return None
        if content_length < 0 or content_length > MAX_BODY_BYTES:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request_too_large", "Request body exceeds the size limit.")
            return None
        if self.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json":
            self._error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_content_type", "Content-Type must be application/json.")
            return None
        try:
            value = json.loads(
                self.rfile.read(content_length).decode("utf-8"),
                parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_json", "Request body must be valid UTF-8 JSON.")
            return None
        if not isinstance(value, dict):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_json", "Request body must be a JSON object.")
            return None
        return value

    def _path(self) -> str:
        return unquote(urlparse(self.path).path)

    def _error(self, status: HTTPStatus, code: str, message: str) -> None:
        self._send_json(status, {"error": {"code": code, "message": message}})

    def _send_json(self, status: HTTPStatus, value: Any) -> None:
        body = b"" if value is None else json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        origin = self.headers.get("Origin")
        if origin and VITE_ORIGIN.fullmatch(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            try:
                self.wfile.write(body)
            except ConnectionError:
                self.close_connection = True

    def log_message(self, format: str, *args: Any) -> None:
        """Keep the local API quiet; callers receive structured HTTP errors."""


def create_server(
    address: tuple[str, int] = ("127.0.0.1", 8000),
    *,
    profiles_dir: Path | str = Path("config/profiles"),
    datasets_dir: Path | str = Path("data/processed"),
    uploads_dir: Path | str = Path("data/uploads"),
    default_profile_path: Path | str = Path("config/default_profile.json"),
    generator: PipelineGenerator | None = None,
    simulator: SimulationRunner | None = None,
    profile_loader: ProfileLoader = load_profile,
) -> LocalApiServer:
    """Create a local API server; inject a pipeline generator for tests or embedding."""
    return LocalApiServer(address, profiles_dir=profiles_dir, datasets_dir=datasets_dir, uploads_dir=uploads_dir, default_profile_path=default_profile_path, generator=generator, simulator=simulator, profile_loader=profile_loader)


def _simulate_current_dataset(profile: Any, output_dir: Path, iterations: int, seed: int) -> dict[str, Any]:
    from .simulate import run_simulation
    from .config import LeagueConfig

    return run_simulation(output_dir, iterations=iterations, seed=seed, league=LeagueConfig.from_profile(profile), profile=profile)


def main(argv: list[str] | None = None) -> None:
    """Run the local API without creating a server during module import."""
    parser = argparse.ArgumentParser(description="Run the local fantasy advisor API.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--profiles-dir", type=Path, default=Path("config/profiles"))
    parser.add_argument("--datasets-dir", type=Path, default=Path("data/processed"))
    parser.add_argument("--uploads-dir", type=Path, default=Path("data/uploads"))
    args = parser.parse_args(argv)
    server = create_server((args.host, args.port), profiles_dir=args.profiles_dir, datasets_dir=args.datasets_dir, uploads_dir=args.uploads_dir)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
