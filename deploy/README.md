# Deploy

Two containers behind one port:

- **web** - nginx serving the built frontend, and proxying `/api/` to the API.
- **api** - the Python advisor (`advisor.server`), reachable only from inside the
  compose network.

Same origin means the browser never makes a cross-origin call, so no CORS is
involved and there is a single port to publish.

## Start

```sh
cd deploy
cp .env.example .env      # optional, the defaults work
docker compose up -d --build
```

Open <http://127.0.0.1:8080>.

```sh
docker compose logs -f api     # follow the pipeline while it generates
docker compose down            # stop
```

## Data on the host

Nothing lives only inside a container. Paths are relative to the repository root:

| host path | in container | mode |
|---|---|---|
| `config/` | `/app/config` | read-write - saved profiles land in `config/profiles/` |
| `data/raw/` | `/app/data/raw` | read-only - the source spreadsheets |
| `data/processed/` | `/app/data/processed` | read-write - generated datasets |
| `data/uploads/` | `/app/data/uploads` | read-write - files uploaded from the UI |

`data/raw/` must already hold the source files (`listone_*.xlsx`,
`statistiche_*.xlsx`, `squadre.csv`, ...) or generation fails with
`invalid_source_data`. The league calendar is optional; without it generation
works but the season simulation does not.

Backing up means copying `config/` and `data/`. There is no database.

## Security

**The API has no authentication.** Anyone who can reach the port can upload
files, regenerate datasets, and delete profiles. This is why `BIND_ADDRESS`
defaults to `127.0.0.1`: out of the box the stack is reachable only from the
machine running it.

Before setting `BIND_ADDRESS=0.0.0.0`, put something in front of it. The
smallest option is HTTP basic auth in nginx - add to the `location /api/` block
in `nginx.conf`:

```nginx
auth_basic "fishertiger";
auth_basic_user_file /etc/nginx/.htpasswd;
```

then generate the file and mount it in `docker-compose.yml` under the `web`
service:

```sh
docker run --rm httpd:alpine htpasswd -nb yourname 'yourpassword' > .htpasswd
```

```yaml
    volumes:
      - ./.htpasswd:/etc/nginx/.htpasswd:ro
```

There is no TLS here. If the stack is reachable from outside the machine, put it
behind a reverse proxy that terminates HTTPS (Caddy, Traefik, nginx with
certbot) - basic auth over plain HTTP sends the password in clear text.

## What this is not

`advisor.server` is built on Python's `http.server`. It is a threaded, single
process, dependency-free server: fine for one household using the app, not a
production web server. It has no rate limiting, no request logging, and no
graceful handling of concurrent generations - two simultaneous generate calls
will both run the full pandas pipeline and race on the output file.

For the intended use - your league, your machine, maybe a small VPS behind auth -
that is a reasonable trade. Do not put it on the open internet.

## Updating after a code change

```sh
docker compose up -d --build
```

The frontend is compiled at image build time, so a change under `web/src/`
needs the rebuild to appear. Changes under `advisor/` do too - the code is
copied into the image, not mounted.

## Configuration

`.env` in this directory:

| variable | default | meaning |
|---|---|---|
| `BIND_ADDRESS` | `127.0.0.1` | interface the port binds to |
| `PORT` | `8080` | host port |
| `VITE_LOCAL_API_BASE` | empty | API base baked into the frontend; empty = same origin. Set it only when serving the API from another host |
