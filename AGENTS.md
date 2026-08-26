# Agent Guide

## Project Shape

- `advisor/` is the Python 3.10+ API, profile handling, projection pipeline, and Monte Carlo simulation; `advisor.server` is the local HTTP entrypoint.
- `web/` is the Vite/React client. It consumes profile-scoped generated JSON from the local API; the browser does not run the Python pipeline.
- Inside `web/src`, `main.jsx` holds the shell and routing, `views/` holds one file per screen, `ui.jsx` holds the shared presentational primitives, and `styles/` holds the design system (`tokens.css` first, then base, primitives, shell and per-screen sheets). `league-settings.css` and `random-auction.css` keep their own namespaces but read their colours from the same tokens.
- The interface is mobile-first: write the phone layout as the default and add `min-width` media queries for larger screens. Colour carries meaning: the indigo brand marks navigation and focus, and green/amber/red are reserved for auction verdicts.
- `config/default_profile.json` is the only committed public profile. Saved profiles, uploads, and generated datasets are intentionally ignored by git.

## Setup And Run

- From the repository root, create/install Python dependencies with `python -m venv .venv` and `.venv/bin/pip install -r requirements.txt`; install client dependencies with `cd web && npm install`.
- Run the API from the repository root with `.venv/bin/python -m advisor.server --host 127.0.0.1 --port 8000`, then run Vite in a second terminal with `cd web && npm run dev`.
- The UI workflow requires uploading the private league calendar in **Impostazioni** before generating data. Do not add `data/raw/calendario_lega.xlsx` or other league-identifying inputs to git.
- `VITE_LOCAL_API_BASE` optionally overrides the client API URL; otherwise it uses `http://127.0.0.1:8000`.

## Data Workflow

- Generation must precede simulation: `.venv/bin/python -m advisor.pipeline --profile config/default_profile.json --raw-dir data/raw --output-dir data/processed`, then `.venv/bin/python -m advisor.simulate --profile config/default_profile.json --raw-dir data/raw --output-dir data/processed --iterations 1000 --seed 202627`.
- Profile outputs are written under `data/processed/<profile_id>/<season-with-hyphen>/`; simulation expects `auction_data.json` in that directory.
- Source declarations in the active profile are authoritative for input files and seasons. The pipeline also validates the Serie A calendar and the private league calendar against profile participants and matchday settings.

## Verification

- Python tests: `.venv/bin/python -m pytest`.
- Web tests: `cd web && npm test`; this runs only `web/tests/*.test.js`. Also run `node --test src/profile-client.test.js` from `web` when changing the profile client.
- Client build: `cd web && npm run build`.
- There are no configured lint or typecheck scripts; do not infer additional commands from the framework defaults.
