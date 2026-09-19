# fishertiger - A Fantacalcio Auction Advisor

Local-first advisor for a Classic Fantacalcio Serie A auction. It builds player
projections, supports a live auction, replays randomized auctions, and runs a
season-level Monte Carlo simulation using the configured league rules.

## License

- Software: [MIT](LICENSE)
- Structured base data in `data/raw/`: [CC BY 4.0](DATA_LICENSE.md)
- Model choices: [MODEL.md](MODEL.md)
- Input data and private calendar: [DATA_SOURCES.md](DATA_SOURCES.md)

## Requirements

- Python 3.10+
- Node.js 22+

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
cd web && npm install
```

## Run Locally

Start the local API from the repository root:

```bash
.venv/bin/python -m advisor.server --host 127.0.0.1 --port 8000
```

In another terminal, start Vite:

```bash
cd web
npm run dev
```

Open the Vite URL. On first launch the application opens **Impostazioni**.
The included sources are enough to use **Genera dati** for the dashboard,
projections, and auction tools. Upload a compatible private
`calendario_lega.xlsx` and regenerate the dataset only before running the
season simulation. Generated datasets and simulations stay local under
`data/processed/<profile_id>/<season>/`.

## Automatic availability

Current Serie A injuries can be refreshed from the authorized public
Fantacalcio Online injury list. No authentication or browser-side secret is
required: the Python backend downloads and validates the HTML page.

Successful snapshots are stored locally under `data/updates/` and remain
available offline if the provider cannot be reached. This first version is an
informational runtime overlay: it does not change projections, auction values,
recommendations, simulations, or `confirmed_inactive`, and it does not require
regenerating `auction_data.json`.

## Inputs And Profiles

`config/default_profile.json` is the single public default profile. The API
serves it to the client; there is no duplicate browser profile.

The repository includes base inputs in `data/raw/`. The only excluded input is
`data/raw/calendario_lega.xlsx`, because it identifies a user's fantasy league.
It is optional for generation and required for season simulation. Download the
sanitized model from **Impostazioni** when needed. The profile source
declarations identify the expected files and seasons.

The Serie A input is always a 20-team, 38-matchday, 380-match calendar. The
fantasy league can use a shorter configured interval through
`fantasy_start_matchday`, `fantasy_end_matchday`, and `fantasy_matchdays`.

## CLI

The UI is the normal workflow. The pipeline command works with the included
sources; supply a matching private calendar before the simulation command:

```bash
.venv/bin/python -m advisor.pipeline --profile config/default_profile.json --raw-dir data/raw --output-dir data/processed
.venv/bin/python -m advisor.simulate --profile config/default_profile.json --raw-dir data/raw --output-dir data/processed --iterations 1000 --seed 202627
```

## Verification

```bash
.venv/bin/python -m pytest
cd web && npm test && npm run build
```
