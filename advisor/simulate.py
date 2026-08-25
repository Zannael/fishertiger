"""CLI entrypoint for a reproducible pre-auction season simulation."""
import argparse
import copy
import json
from pathlib import Path

from .config import LeagueConfig
from .league_profile import LeagueProfile
from .simulation import make_sample_rosters, simulate_season


def run_simulation(output_dir: Path, *, iterations: int = 1000, seed: int = 202627, league: LeagueConfig | None = None) -> dict:
    """Simulate the current dataset and replace its previous season report."""
    league = league or LeagueConfig()
    payload = json.loads((output_dir / "auction_data.json").read_text(encoding="utf-8"))
    rosters = make_sample_rosters(payload, league)
    result = simulate_season(payload, rosters, iterations=iterations, seed=seed, league=league)
    output = {"iterations": result.iterations, "teams": result.teams, "scenarios": result.scenarios, "diagnostics": result.diagnostics, "rosters": rosters}
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "season_simulation.json").write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    return output


def anonymize_public_simulation(simulation: dict, calendar: dict) -> dict:
    """Replace local fantasy-team names before publishing a browser report."""
    public_simulation = copy.deepcopy(simulation)
    replacements = {
        name: f"Squadra {index}"
        for index, name in enumerate(calendar.get("teams", []), start=1)
    }
    for field in ("teams", "scenarios", "rosters"):
        if field in public_simulation:
            public_simulation[field] = {
                replacements.get(name, name): value
                for name, value in public_simulation[field].items()
            }
    return public_simulation


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Simulate a fantasy league season.")
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/processed"))
    parser.add_argument("--web-export-dir", type=Path)
    parser.add_argument("--iterations", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=202627)
    args = parser.parse_args(argv)
    profile = LeagueProfile.load_json(args.profile) if args.profile else None
    league = LeagueConfig.from_profile(profile) if profile else LeagueConfig()
    output_dir = args.output_dir / profile.profile_id / profile.season.season.replace("/", "-") if profile else args.output_dir
    output = run_simulation(output_dir, iterations=args.iterations, seed=args.seed, league=league)
    if args.web_export_dir:
        args.web_export_dir.mkdir(parents=True, exist_ok=True)
        payload = json.loads((output_dir / "auction_data.json").read_text(encoding="utf-8"))
        public_output = anonymize_public_simulation(output, payload["calendario_lega"])
        (args.web_export_dir / "season_simulation.json").write_text(json.dumps(public_output, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Simulated {args.iterations:,} seasons to {output_dir / 'season_simulation.json'}")


if __name__ == "__main__":
    main()
