#!/usr/bin/env bash
# Arkestrator — Linux Installer
# Downloads and installs the Arkestrator desktop app and/or standalone server from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/timvanhelsdingen/arkestrator/main/install.sh | bash
#   bash install.sh --server          # Install server only
#   bash install.sh --desktop         # Install desktop app only (RPM/DEB/AppImage)
#   bash install.sh --both            # Install both
#   bash install.sh --uninstall       # Remove everything
#   bash install.sh --help            # Show usage
set -euo pipefail

REPO="${ARKESTRATOR_REPO:-timvanhelsdingen/arkestrator}"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
SERVER_BIN_NAME="arkestrator-server-linux-x64"

# Install locations (server standalone)
SERVER_INSTALL_DIR="/usr/local/bin"
SERVER_BIN="${SERVER_INSTALL_DIR}/arkestrator-server"
SERVER_DATA_DIR="/var/lib/arkestrator"
SYSTEMD_UNIT="/etc/systemd/system/arkestrator.service"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()   { echo -e "${GREEN}[OK]${NC}  $1"; }
warn()   { echo -e "${YELLOW}[!!]${NC}  $1"; }
fail()   { echo -e "${RED}[ERR]${NC} $1"; }
header() { echo -e "\n${BOLD}$1${NC}"; }

usage() {
    cat <<EOF
${BOLD}Arkestrator — Linux Installer${NC}

Usage: install.sh [OPTIONS]

Options:
  --server       Install standalone server with systemd service
  --desktop      Install desktop app (RPM, DEB, or AppImage)
  --both         Install both server and desktop app
  --uninstall    Remove all installed components
  --help         Show this help message

If no option is given, an interactive menu is shown.

The desktop installer auto-detects your package manager:
  - Fedora/RHEL/openSUSE → RPM package
  - Debian/Ubuntu → DEB package
  - Other → AppImage fallback

Examples:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash
  bash install.sh --server
  bash install.sh --uninstall
EOF
}

# ── Helpers ──────────────────────────────────────────────────────────────

check_arch() {
    local arch
    arch="$(uname -m)"
    if [[ "$arch" != "x86_64" ]]; then
        fail "Unsupported architecture: $arch. Only x86_64 is supported."
        exit 1
    fi
}

check_linux() {
    if [[ "$(uname -s)" != "Linux" ]]; then
        fail "This installer is for Linux only."
        exit 1
    fi
}

need_cmd() {
    if ! command -v "$1" &>/dev/null; then
        fail "Required command not found: $1"
        echo "    Please install it and try again."
        exit 1
    fi
}

detect_pkg_manager() {
    if command -v dnf &>/dev/null; then
        echo "rpm"
    elif command -v rpm &>/dev/null && command -v zypper &>/dev/null; then
        echo "rpm"
    elif command -v dpkg &>/dev/null && command -v apt-get &>/dev/null; then
        echo "deb"
    else
        echo "appimage"
    fi
}

fetch_release_info() {
    header "Fetching latest release info..."

    # Private repo requires authentication — try gh CLI first, then GITHUB_TOKEN
    if command -v gh &>/dev/null; then
        RELEASE_JSON="$(gh api "repos/${REPO}/releases/latest" 2>/dev/null || true)"
    fi

    if [[ -z "${RELEASE_JSON:-}" ]] && [[ -n "${GITHUB_TOKEN:-}" ]]; then
        RELEASE_JSON="$(curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" "$API_URL" 2>/dev/null || true)"
    fi

    if [[ -z "${RELEASE_JSON:-}" ]]; then
        RELEASE_JSON="$(curl -fsSL "$API_URL" 2>/dev/null || true)"
    fi

    if [[ -z "${RELEASE_JSON:-}" ]]; then
        fail "Could not fetch release info. For private repos, install gh CLI (https://cli.github.com)"
        fail "or set GITHUB_TOKEN environment variable."
        exit 1
    fi

    RELEASE_TAG="$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')"
    if [[ -z "$RELEASE_TAG" ]]; then
        fail "Could not determine latest release."
        exit 1
    fi
    info "Latest release: ${RELEASE_TAG}"
}

get_asset_url() {
    local pattern="$1"
    echo "$RELEASE_JSON" | grep '"browser_download_url"\|"url"' | grep -v 'api.github.com/repos' | sed 's/.*"browser_download_url": *"//;s/.*"url": *"//;s/".*//' | grep -E "$pattern" | head -1
}

download() {
    local url="$1" dest="$2"
    echo -e "    ${DIM}Downloading $(basename "$dest")...${NC}"

    # For private repos, use gh CLI for authenticated download
    if command -v gh &>/dev/null && [[ "$url" == *"github.com"* ]]; then
        # gh release download needs the asset name and tag
        local asset_name
        asset_name="$(basename "$url")"
        gh release download "$RELEASE_TAG" --repo "$REPO" --pattern "$asset_name" --output "$dest" --clobber 2>/dev/null && return 0
    fi

    # Fallback: curl with optional token auth
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
        curl -fSL --progress-bar -H "Authorization: Bearer ${GITHUB_TOKEN}" -H "Accept: application/octet-stream" -o "$dest" "$url"
    else
        curl -fSL --progress-bar -o "$dest" "$url"
    fi
}

# ── Remove old Tauri RPM (generic "app" binary name) ────────────────────

remove_old_rpm() {
    # The old Tauri builds had a bug where the binary was named "app" instead of "arkestrator"
    local old_rpm
    old_rpm="$(rpm -qa 2>/dev/null | grep -i '^arkestrator-' | head -1 || true)"
    if [[ -n "$old_rpm" ]]; then
        # Check if it's the old version with the "app" binary
        if rpm -ql "$old_rpm" 2>/dev/null | grep -q '/usr/bin/app$'; then
            warn "Found old Arkestrator RPM with generic binary name: ${old_rpm}"
            echo "    Removing old package before installing new version..."
            sudo rpm -e "$old_rpm"
            info "Old RPM removed"
            return 0
        fi
    fi
    return 1
}

# ── Server install ───────────────────────────────────────────────────────

install_server() {
    header "Installing Arkestrator Server"

    local url
    url="$(get_asset_url "$SERVER_BIN_NAME")"
    if [[ -z "$url" ]]; then
        fail "Server binary not found in release ${RELEASE_TAG}."
        fail "Expected asset matching: ${SERVER_BIN_NAME}"
        exit 1
    fi

    local tmpfile
    tmpfile="$(mktemp)"
    download "$url" "$tmpfile"

    echo "    Installing to ${SERVER_BIN} (requires sudo)..."
    sudo install -Dm755 "$tmpfile" "$SERVER_BIN"
    rm -f "$tmpfile"
    info "Server binary installed to ${SERVER_BIN}"

    # Create data directory
    if [[ ! -d "$SERVER_DATA_DIR" ]]; then
        sudo mkdir -p "$SERVER_DATA_DIR"
        info "Data directory created: ${SERVER_DATA_DIR}"
    fi

    # Create systemd service
    echo "    Creating systemd service (requires sudo)..."
    sudo tee "$SYSTEMD_UNIT" > /dev/null <<UNIT
[Unit]
Description=Arkestrator Server
Documentation=https://github.com/${REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${SERVER_BIN}
WorkingDirectory=${SERVER_DATA_DIR}
Environment=PORT=7800
Environment=DB_PATH=${SERVER_DATA_DIR}/arkestrator.db
Environment=COORDINATOR_SCRIPTS_DIR=${SERVER_DATA_DIR}/coordinator-scripts
Environment=COORDINATOR_PLAYBOOKS_DIR=${SERVER_DATA_DIR}/coordinator-playbooks
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${SERVER_DATA_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
    info "Systemd service created: ${SYSTEMD_UNIT}"

    sudo systemctl daemon-reload
    sudo systemctl enable arkestrator.service
    sudo systemctl start arkestrator.service
    info "Service enabled and started"

    echo ""
    echo -e "  ${BOLD}Server is running at http://localhost:7800${NC}"
    echo -e "  First-login credentials: ${SERVER_DATA_DIR}/bootstrap-admin.txt"
    echo ""
    echo "  Useful commands:"
    echo "    sudo systemctl status arkestrator    # Check status"
    echo "    sudo systemctl stop arkestrator      # Stop server"
    echo "    sudo systemctl restart arkestrator   # Restart server"
    echo "    sudo journalctl -u arkestrator -f    # View logs"
}

# ── Desktop install ──────────────────────────────────────────────────────

install_desktop() {
    header "Installing Arkestrator Desktop App"

    # Remove old RPM with broken binary name if present
    remove_old_rpm || true

    local pkg_type
    pkg_type="$(detect_pkg_manager)"
    info "Detected package format: ${pkg_type}"

    case "$pkg_type" in
        rpm) install_desktop_rpm ;;
        deb) install_desktop_deb ;;
        *)   install_desktop_appimage ;;
    esac
}

install_desktop_rpm() {
    local url
    url="$(get_asset_url '\.rpm$')"
    if [[ -z "$url" ]]; then
        warn "No RPM found in release ${RELEASE_TAG}, falling back to AppImage"
        install_desktop_appimage
        return
    fi

    local tmpfile
    tmpfile="$(mktemp --suffix=.rpm)"
    download "$url" "$tmpfile"

    echo "    Installing RPM package (requires sudo)..."
    if command -v dnf &>/dev/null; then
        sudo dnf install -y "$tmpfile"
    elif command -v zypper &>/dev/null; then
        sudo zypper install -y --allow-unsigned-rpm "$tmpfile"
    else
        sudo rpm -U "$tmpfile"
    fi
    rm -f "$tmpfile"
    info "RPM package installed"

    echo ""
    echo -e "  ${BOLD}Desktop app installed!${NC}"
    echo "  Launch from your application menu or run: arkestrator"
    echo ""
    echo "  To update later, just re-run this installer."
    echo "  To uninstall: sudo dnf remove arkestrator  (or sudo rpm -e arkestrator)"
}

install_desktop_deb() {
    local url
    url="$(get_asset_url '\.deb$')"
    if [[ -z "$url" ]]; then
        warn "No DEB found in release ${RELEASE_TAG}, falling back to AppImage"
        install_desktop_appimage
        return
    fi

    local tmpfile
    tmpfile="$(mktemp --suffix=.deb)"
    download "$url" "$tmpfile"

    echo "    Installing DEB package (requires sudo)..."
    sudo dpkg -i "$tmpfile" || sudo apt-get install -f -y
    rm -f "$tmpfile"
    info "DEB package installed"

    echo ""
    echo -e "  ${BOLD}Desktop app installed!${NC}"
    echo "  Launch from your application menu or run: arkestrator"
    echo ""
    echo "  To update later, just re-run this installer."
    echo "  To uninstall: sudo apt remove arkestrator"
}

install_desktop_appimage() {
    local url
    url="$(get_asset_url '\.AppImage$')"
    if [[ -z "$url" ]]; then
        fail "No AppImage found in release ${RELEASE_TAG}."
        exit 1
    fi

    local install_dir="${HOME}/.local/bin"
    local install_path="${install_dir}/arkestrator.AppImage"
    local desktop_file="${HOME}/.local/share/applications/arkestrator.desktop"
    local icon_dir="${HOME}/.local/share/icons/hicolor/256x256/apps"
    local icon_file="${icon_dir}/arkestrator.png"

    mkdir -p "$install_dir"

    local tmpfile
    tmpfile="$(mktemp)"
    download "$url" "$tmpfile"

    install -Dm755 "$tmpfile" "$install_path"
    rm -f "$tmpfile"
    info "AppImage installed to ${install_path}"

    # Download icon from repo
    mkdir -p "$icon_dir"
    local icon_url="https://raw.githubusercontent.com/${REPO}/main/client/src-tauri/icons/128x128.png"
    if curl -fsSL -o "$icon_file" "$icon_url" 2>/dev/null; then
        info "Icon installed"
    else
        warn "Could not download icon — desktop entry will work without it"
    fi

    # Create .desktop file
    mkdir -p "$(dirname "$desktop_file")"
    cat > "$desktop_file" <<DESKTOP
[Desktop Entry]
Name=Arkestrator
Comment=AI agent orchestration for creative tools
Exec=${install_path}
Icon=arkestrator
Type=Application
Categories=Development;
Terminal=false
StartupWMClass=Arkestrator
DESKTOP
    info "Desktop entry created: ${desktop_file}"

    # Update desktop database if available
    if command -v update-desktop-database &>/dev/null; then
        update-desktop-database "${HOME}/.local/share/applications" 2>/dev/null || true
    fi

    # Ensure ~/.local/bin is in PATH
    if [[ ":$PATH:" != *":${install_dir}:"* ]]; then
        warn "${install_dir} is not in your PATH."
        echo "    Add it to your shell config:"
        echo "      echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
    fi

    echo ""
    echo -e "  ${BOLD}Desktop app installed!${NC}"
    echo "  Launch from your application menu or run: ${install_path}"
}

# ── Uninstall ────────────────────────────────────────────────────────────

uninstall() {
    header "Uninstalling Arkestrator"

    # Remove RPM package if installed
    local rpm_pkg
    rpm_pkg="$(rpm -qa 2>/dev/null | grep -i '^arkestrator' | head -1 || true)"
    if [[ -n "$rpm_pkg" ]]; then
        echo "    Removing RPM package: ${rpm_pkg}..."
        if command -v dnf &>/dev/null; then
            sudo dnf remove -y "$rpm_pkg"
        else
            sudo rpm -e "$rpm_pkg"
        fi
        info "RPM package removed"
    fi

    # Remove DEB package if installed
    if dpkg -l arkestrator 2>/dev/null | grep -q '^ii'; then
        echo "    Removing DEB package..."
        sudo apt remove -y arkestrator
        info "DEB package removed"
    fi

    # Server (standalone binary)
    if [[ -f "$SYSTEMD_UNIT" ]]; then
        echo "    Stopping and removing systemd service..."
        sudo systemctl stop arkestrator.service 2>/dev/null || true
        sudo systemctl disable arkestrator.service 2>/dev/null || true
        sudo rm -f "$SYSTEMD_UNIT"
        sudo systemctl daemon-reload
        info "Systemd service removed"
    fi
    if [[ -f "$SERVER_BIN" ]]; then
        sudo rm -f "$SERVER_BIN"
        info "Server binary removed"
    fi

    # AppImage + desktop entry (user-local)
    local appimage="${HOME}/.local/bin/arkestrator.AppImage"
    local desktop_file="${HOME}/.local/share/applications/arkestrator.desktop"
    local icon_file="${HOME}/.local/share/icons/hicolor/256x256/apps/arkestrator.png"

    if [[ -f "$appimage" ]]; then
        rm -f "$appimage"
        info "AppImage removed"
    fi
    if [[ -f "$desktop_file" ]]; then
        rm -f "$desktop_file"
        info "Desktop entry removed"
    fi
    if [[ -f "$icon_file" ]]; then
        rm -f "$icon_file"
        info "Icon removed"
    fi

    echo ""
    if [[ -d "$SERVER_DATA_DIR" ]]; then
        warn "Data directory preserved: ${SERVER_DATA_DIR}"
        echo "    Remove manually if you want to delete all data:"
        echo "      sudo rm -rf ${SERVER_DATA_DIR}"
    fi

    info "Uninstall complete"
}

# ── Interactive menu ─────────────────────────────────────────────────────

interactive_menu() {
    echo ""
    echo -e "${BOLD}What would you like to install?${NC}"
    echo ""
    echo "  1) Server         — Standalone server with systemd service"
    echo "  2) Desktop app    — System package (RPM/DEB) or AppImage"
    echo "  3) Both           — Server + desktop app"
    echo "  4) Uninstall      — Remove all components"
    echo "  5) Cancel"
    echo ""
    read -rp "  Choose [1-5]: " choice
    case "$choice" in
        1) MODE="server" ;;
        2) MODE="desktop" ;;
        3) MODE="both" ;;
        4) MODE="uninstall" ;;
        5) echo "Cancelled."; exit 0 ;;
        *) fail "Invalid choice"; exit 1 ;;
    esac
}

# ── Main ─────────────────────────────────────────────────────────────────

main() {
    local MODE=""

    # Parse args
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --server)    MODE="server" ;;
            --desktop)   MODE="desktop" ;;
            --both)      MODE="both" ;;
            --uninstall) MODE="uninstall" ;;
            --help|-h)   usage; exit 0 ;;
            *)           fail "Unknown option: $1"; usage; exit 1 ;;
        esac
        shift
    done

    header "Arkestrator — Linux Installer"

    check_linux
    check_arch
    need_cmd curl

    # Interactive if no mode specified
    if [[ -z "$MODE" ]]; then
        interactive_menu
    fi

    if [[ "$MODE" == "uninstall" ]]; then
        uninstall
        exit 0
    fi

    fetch_release_info

    case "$MODE" in
        server)  install_server ;;
        desktop) install_desktop ;;
        both)    install_server; install_desktop ;;
    esac

    echo ""
    header "Installation complete!"
    echo ""
}

main "$@"
