# Installation

## Desktop App (Recommended)

The desktop app bundles the server as a sidecar binary — install and launch, and you're running.

Download from [GitHub Releases](https://github.com/timvanhelsdingen/arkestrator/releases):

| Platform | Format |
|---|---|
| Windows | `.exe` installer (NSIS) |
| macOS | `.dmg` disk image |
| Linux | `.rpm`, `.deb`, `.AppImage` |

On first launch, the app starts the server automatically on port 7800. Bootstrap admin credentials are written to `bootstrap-admin.txt` in your app data directory (the setup page shows the exact path).

## Linux Installer

Quick install for Linux systems:

```bash
curl -fsSL https://raw.githubusercontent.com/timvanhelsdingen/arkestrator/main/install.sh | bash
```

Interactive menu lets you choose: server only, desktop app only, or both.

### Non-Interactive

```bash
bash install.sh --server      # Server only (systemd service)
bash install.sh --desktop     # Desktop app only
bash install.sh --both        # Both
```

### What Gets Installed

**Server** (`--server`):
- Binary: `/usr/local/bin/arkestrator-server`
- Data: `/var/lib/arkestrator/`
- Systemd service: `arkestrator.service` (enabled + started automatically)
- Port 7800

**Desktop app** (`--desktop`):
- **Fedora/RHEL/openSUSE** → `.rpm` via dnf/zypper
- **Debian/Ubuntu** → `.deb` via dpkg/apt
- **Other** → `.AppImage` to `~/.local/bin/`

### Managing the Server Service

```bash
sudo systemctl status arkestrator     # Check status
sudo systemctl stop arkestrator       # Stop
sudo systemctl start arkestrator      # Start
sudo systemctl restart arkestrator    # Restart
sudo journalctl -u arkestrator -f    # View logs
```

### Uninstall

```bash
bash install.sh --uninstall
```

Removes the binary, service, and desktop files. Data directory (`/var/lib/arkestrator`) is preserved — delete manually to remove all data.

## Standalone Server Binary

For headless or remote deployments without a desktop environment:

```bash
# Download from GitHub Releases (no runtime needed)
./arkestrator-server-linux-x64
./arkestrator-server-darwin-arm64
./arkestrator-server-win-x64.exe
```

Server starts at `http://localhost:7800`. Bootstrap credentials are in `bootstrap-admin.txt` beside the database file.

## Docker

### Local Docker

```bash
docker compose up --build
```

Server at `http://localhost:7800`. Read bootstrap credentials:

```bash
docker compose exec arkestrator cat /data/bootstrap-admin.txt
```

### Production (VPS with HTTPS)

For public-facing deployments, run the standard Docker Compose setup behind a reverse proxy (Caddy, nginx, etc.) that terminates TLS:

```bash
docker compose up -d --build
```

Set `TRUST_PROXY_HEADERS=true` in your container environment when behind a reverse proxy. See [Production Deployment](deployment-vps-caddy.md) for DNS, firewall, security, and full setup.

### TrueNAS (Private GHCR Image)

For NAS deployments using a private container image:

1. **Publish the image** using the GitHub Actions workflow (`.github/workflows/publish-server-image.yml`)
2. **Configure TrueNAS** with GitHub PAT credentials for `ghcr.io` (`read:packages` scope)
3. **Create a custom app** with this YAML:

```yaml
services:
  arkestrator:
    image: ghcr.io/<owner>/<repo>:main
    container_name: arkestrator
    ports:
      - "7800:7800"
    environment:
      PORT: "7800"
      DB_PATH: "/data/arkestrator.db"
      COORDINATOR_SCRIPTS_DIR: "/data/coordinator-scripts"
      COORDINATOR_PLAYBOOKS_DIR: "/data/coordinator-playbooks"
      MAX_CONCURRENT_AGENTS: "2"
      LOG_LEVEL: "info"
    volumes:
      - /mnt/<pool>/appdata/arkestrator:/data
    restart: unless-stopped
```

#### Installing AI CLIs in the Container

Set these GitHub repository variables before publishing the image:

| Variable | Purpose | Example |
|---|---|---|
| `ARKESTRATOR_APT_PACKAGES` | System packages | `git curl` |
| `ARKESTRATOR_BUN_GLOBAL_PACKAGES` | npm CLIs via Bun | `@anthropic/codex` |
| `ARKESTRATOR_PIP_PACKAGES` | Python packages | `google-generativeai` |
| `ARKESTRATOR_INSTALL_COMMANDS` | Custom install scripts | Any shell commands |

You can also add custom install scripts to `docker/install.d/*.sh`.

Don't put secrets or API tokens in build args — inject runtime credentials via environment variables.

## Build from Source

### Requirements

| Tool | Required For | Install |
|---|---|---|
| Node.js 20+ | Package management | [nodejs.org](https://nodejs.org) |
| pnpm | Workspace management | `npm install -g pnpm` |
| Bun | Server runtime | `npm install -g bun` |
| Rust | Desktop client builds | [rustup.rs](https://rustup.rs) |

Verify:

```bash
pnpm --version && bun --version && rustc --version && cargo --version
```

### Setup

```bash
git clone https://github.com/timvanhelsdingen/arkestrator.git
cd arkestrator

# Install all workspace dependencies
pnpm install

# Build the shared protocol package (required first)
pnpm --filter @arkestrator/protocol build
```

### Dev Mode

```bash
pnpm dev          # Full stack (server + client + admin)
pnpm server       # Server only
pnpm client       # Client only (Tauri desktop app)
```

### Production Build

```bash
# Build server sidecar binary for Tauri
pnpm build:sidecar

# Build admin SPA
pnpm --filter @arkestrator/admin build

# Build desktop app
cd client && pnpm tauri build
```

## First Login

On first server start, a bootstrap admin account is created:

- **Username:** `admin` (or set via `BOOTSTRAP_ADMIN_USERNAME`)
- **Password:** Random (or set via `BOOTSTRAP_ADMIN_PASSWORD`)
- **Credential file:** `bootstrap-admin.txt` in the data directory

The desktop client's setup page shows the exact file path for your platform.

After logging in:
1. Change your password
2. Go to **Admin > Agents > Add from Template** to create your first agent config
3. Install AI CLIs on the server machine (Claude Code, Codex, etc.)
4. Install a bridge plugin in your DCC app — it auto-connects via the shared config
