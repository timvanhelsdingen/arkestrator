# Production Deployment (VPS + Caddy HTTPS)

Recommended production setup:
- Arkestrator server runs in Docker via `docker-compose.yml`
- A reverse proxy (Caddy recommended) terminates TLS on `:443` and forwards to the server
- HTTP (`:80`) handles ACME challenges and redirects to HTTPS

## Prerequisites

- A VPS with Docker + Docker Compose plugin
- A public domain with DNS `A`/`AAAA` record pointing to the VPS
- Ports `80` and `443` open in your firewall/security group

## 1. Prepare Environment

Create a `.env` file with your configuration:

```env
DOMAIN=your-domain.com
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=replace-with-strong-secret
```

If no `BOOTSTRAP_ADMIN_PASSWORD` is set, Arkestrator generates a random one and writes it to `/data/bootstrap-admin.txt` inside the container.

Set `TRUST_PROXY_HEADERS=true` in the container environment (add it to the `environment` section in `docker-compose.yml`) since Caddy sits in front. Never enable this without a trusted reverse proxy.

## 2. Start the Stack

```bash
docker compose up -d --build
```

Then run Caddy (or your preferred reverse proxy) separately to terminate TLS and forward to `localhost:7800`. Example `Caddyfile`:

```
your-domain.com {
    reverse_proxy localhost:7800
}
```

## 3. Validate

```bash
# Check containers are running
docker compose ps

# Health check
curl https://your-domain.com/health
```

Expected: JSON health payload with HTTP 200.

## 4. First Login

Read the generated bootstrap password:

```bash
docker compose exec arkestrator cat /data/bootstrap-admin.txt
```

Log in via the desktop client:
1. Enter `https://your-domain.com` as the server URL
2. Log in with the bootstrap credentials
3. Change your password immediately

## 5. Install AI CLIs

The Docker image needs AI CLIs installed to run agents. Either:

**A) Custom Dockerfile**: Add CLI installation to your `Dockerfile` or `docker/install.d/*.sh` scripts before building.

**B) GitHub Actions build args**: Set repository variables (`ARKESTRATOR_BUN_GLOBAL_PACKAGES`, etc.) to install CLIs during image build. See [Installation](installation.md#installing-ai-clis-in-the-container).

**C) Exec into container**: For quick testing (not persistent across rebuilds):
```bash
docker compose exec arkestrator bun install -g @anthropic-ai/claude-code
```

## Security Notes

- **`TRUST_PROXY_HEADERS=true`** must be set in the container environment when behind a reverse proxy. Never enable this without a trusted proxy.
- **CORS origins** should be restricted to your domain and the desktop client origins:
  - `https://your-domain.com`
  - `tauri://localhost` (desktop client)
  - `http://tauri.localhost` / `https://tauri.localhost`
- **WebSocket forwarding** (`/ws`) works automatically through Caddy's `reverse_proxy`
- **Admin panel** is served at `https://your-domain.com/admin`
- **MCP endpoint** is at `https://your-domain.com/mcp` (requires API key)

## Updating

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker compose up -d --build
```

Database and coordinator data persist in the Docker volume across rebuilds.

## Data Persistence

The Docker Compose file mounts a volume for `/data` which contains:
- SQLite database
- Coordinator scripts and playbooks
- Training data
- Sync temp files
- Bootstrap credentials

Back up this volume regularly.
