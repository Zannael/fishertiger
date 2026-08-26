"""Profile-aware dataset generation, isolated from the HTTP transport."""
from __future__ import annotations

import json
import re
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROFILE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
ProfileLoader = Callable[[dict[str, Any]], Any]
PipelineGenerator = Callable[[Any, Path], Any]


class ProfileRequestError(ValueError):
    """The profile supplied to a generation request is invalid or unavailable."""


def load_profile(value: dict[str, Any]) -> Any:
    """Load a profile lazily so serving the API does not import the pipeline."""
    from .league_profile import LeagueProfile

    return LeagueProfile.from_dict(value)


def resolve_profile(
    request: dict[str, Any],
    profiles_dir: Path,
    *,
    profile_loader: ProfileLoader = load_profile,
) -> Any:
    """Resolve exactly one inline profile or persisted profile ID."""
    inline = request.get("profile")
    saved_id = request.get("profile_id")
    if inline is not None and saved_id is not None:
        raise ProfileRequestError("Specify either profile or profile_id, not both.")
    if isinstance(inline, dict):
        return _validate_profile(inline, profile_loader)
    if isinstance(inline, str):
        saved_id = inline
    if not isinstance(saved_id, str) or not PROFILE_ID.fullmatch(saved_id):
        raise ProfileRequestError("A profile object or valid saved profile_id is required.")

    path = profiles_dir / f"{saved_id}.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ProfileRequestError("The saved profile does not exist.") from error
    except (OSError, json.JSONDecodeError) as error:
        raise ProfileRequestError("The saved profile is invalid or unreadable.") from error
    if not isinstance(value, dict):
        raise ProfileRequestError("The saved profile must be a JSON object.")
    profile = _validate_profile(value, profile_loader)
    if profile.profile_id != saved_id:
        raise ProfileRequestError("The saved profile ID does not match its file name.")
    return profile


def generate_dataset(
    profile: Any,
    datasets_dir: Path,
    *,
    generator: PipelineGenerator | None = None,
) -> dict[str, Any]:
    """Run a generator and return serializable profile and output metadata."""
    generator = generator or _pipeline_generator
    generator(profile, datasets_dir)
    manifest = dataset_manifest(datasets_dir)
    path = auction_dataset_path(profile)
    if not (datasets_dir / path).is_file():
        path = None
    return {
        "profile_id": profile.profile_id,
        "profile_hash": profile.configuration_hash,
        "profile": profile.to_dict() if hasattr(profile, "to_dict") else None,
        "dataset_path": path,
        "dataset_manifest": manifest,
    }


def auction_dataset_path(profile: Any) -> str:
    """Return the profile- and season-scoped path used by the pipeline."""
    return (Path(profile.profile_id) / profile.season.season.replace("/", "-") / "auction_data.json").as_posix()


def dataset_manifest(directory: Path) -> dict[str, list[dict[str, Any]]]:
    """List JSON datasets relative to the configured output directory."""
    if not directory.exists():
        return {"datasets": []}
    if not directory.is_dir():
        raise OSError("Dataset storage is unavailable.")
    datasets = []
    for path in sorted(directory.rglob("*.json")):
        if path.is_file():
            stat = path.stat()
            datasets.append({
                "path": path.relative_to(directory).as_posix(),
                "size_bytes": stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            })
    return {"datasets": datasets}


def _validate_profile(value: dict[str, Any], profile_loader: ProfileLoader) -> Any:
    try:
        profile = profile_loader(value)
    except (AttributeError, TypeError, ValueError, KeyError) as error:
        raise ProfileRequestError(str(error)) from error
    if not isinstance(profile.profile_id, str) or not PROFILE_ID.fullmatch(profile.profile_id):
        raise ProfileRequestError("profile_id must use letters, numbers, underscores, or hyphens.")
    return profile


def _pipeline_generator(profile: Any, datasets_dir: Path) -> Any:
    """Import the pipeline only when a generation request actually arrives."""
    from .pipeline import build_projections

    return build_projections(profile=profile, output=datasets_dir)
