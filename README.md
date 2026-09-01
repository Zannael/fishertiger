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

On Windows, use the virtual environment executables under `Scripts`:

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
cd web && npm install
```

## Run Locally

Start the local API from the repository root:

```bash
.venv/bin/python -m advisor.server --host 127.0.0.1 --port 8000
```

On Windows:

```bash
.venv/Scripts/python.exe -m advisor.server --host 127.0.0.1 --port 8000
```

In another terminal, start Vite:

```bash
cd web
npm run dev
```

Open the Vite URL. On first launch the application opens **Impostazioni**.
Upload your private `calendario_lega.xlsx`, verify participants and sources,
then use **Genera dati**. Generated datasets and simulations stay local under
`data/processed/<profile_id>/<season>/`.

## Web Tooling

The web app now includes TypeScript configuration for incremental migration:

- `web/tsconfig.json` is enabled with strict type-checking for `.ts`/`.tsx`
  while keeping existing `.js`/`.jsx` files behavior unchanged.
- During migration, type-checking is available with:

```bash
cd web
npx tsc --noEmit
```

Formatting and Git hooks are configured in `web/`:

- Prettier script: `npm run format`
- Prettier check: `npm run format:check`
- Husky `pre-commit` runs `lint-staged` and formats staged files via Prettier.
- Husky `commit-msg` runs Commitlint.

Commit messages follow Conventional Commits with allowed scopes `general` and
`release`.

## Inputs And Profiles

`config/default_profile.json` is the single public default profile. The API
serves it to the client; there is no duplicate browser profile.

The repository includes base inputs in `data/raw/`. The only excluded input is
`data/raw/calendario_lega.xlsx`, because it identifies a user's fantasy league.
It must be uploaded locally. The profile source declarations identify the
expected files and seasons.

The Serie A input is always a 20-team, 38-matchday, 380-match calendar. The
fantasy league can use a shorter configured interval through
`fantasy_start_matchday`, `fantasy_end_matchday`, and `fantasy_matchdays`.

## CLI

The UI is the normal workflow. These commands are useful for local automation
after a matching private calendar has been supplied:

```bash
.venv/bin/python -m advisor.pipeline --profile config/default_profile.json --raw-dir data/raw --output-dir data/processed
.venv/bin/python -m advisor.simulate --profile config/default_profile.json --raw-dir data/raw --output-dir data/processed --iterations 1000 --seed 202627
```

On Windows:

```bash
.venv/Scripts/python.exe -m advisor.pipeline --profile config/default_profile.json --raw-dir data/raw --output-dir data/processed
.venv/Scripts/python.exe -m advisor.simulate --profile config/default_profile.json --raw-dir data/raw --output-dir data/processed --iterations 1000 --seed 202627
```

## Verification

```bash
.venv/bin/python -m pytest
cd web && npm test && npm run build
```

Additional web checks:

```bash
cd web
npm run format:check
npx tsc --noEmit
```

On Windows:

```bash
.venv/Scripts/python.exe -m pytest
cd web && npm test && npm run build
```

Additional web checks on Windows:

```bash
cd web
npm run format:check
npx tsc --noEmit
```
