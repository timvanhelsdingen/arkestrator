#!/usr/bin/env bash
# Arkestrator Linux package repo installer
# Usage: curl -fsSL https://timvanhelsdingen.github.io/arkestrator/install.sh | sudo bash
set -euo pipefail

REPO_BASE="https://timvanhelsdingen.github.io/arkestrator"

info()  { echo -e "\033[1;34m[arkestrator]\033[0m $*"; }
error() { echo -e "\033[1;31m[arkestrator]\033[0m $*" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  error "This script must be run as root (use sudo)."
  exit 1
fi

# Detect distro family
detect_distro() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    case "$ID" in
      fedora|rhel|centos|rocky|alma|nobara)
        echo "rpm"
        ;;
      debian|ubuntu|linuxmint|pop|elementary|zorin)
        echo "deb"
        ;;
      arch|manjaro|endeavouros|garuda|cachyos)
        echo "arch"
        ;;
      *)
        # Check ID_LIKE for derivatives
        case "${ID_LIKE:-}" in
          *rhel*|*fedora*|*centos*)  echo "rpm" ;;
          *debian*|*ubuntu*)         echo "deb" ;;
          *arch*)                    echo "arch" ;;
          *)                         echo "unknown" ;;
        esac
        ;;
    esac
  else
    echo "unknown"
  fi
}

install_rpm() {
  info "Detected RPM-based distro — setting up DNF/YUM repo..."

  # Import GPG key
  rpm --import "${REPO_BASE}/gpg-key.asc"

  # Add repo file
  curl -fsSL "${REPO_BASE}/arkestrator.repo" -o /etc/yum.repos.d/arkestrator.repo

  info "Repo added. Install with:"
  info "  sudo dnf install arkestrator"
}

install_deb() {
  info "Detected Debian-based distro — setting up APT repo..."

  # Import GPG key
  curl -fsSL "${REPO_BASE}/gpg-key.asc" | gpg --dearmor -o /usr/share/keyrings/arkestrator.gpg

  # Add repo source
  echo "deb [signed-by=/usr/share/keyrings/arkestrator.gpg] ${REPO_BASE}/apt stable main" \
    > /etc/apt/sources.list.d/arkestrator.list

  apt-get update -o Dir::Etc::sourcelist="sources.list.d/arkestrator.list" \
                 -o Dir::Etc::sourceparts="-" -o APT::Get::List-Cleanup="0" 2>/dev/null || true

  info "Repo added. Install with:"
  info "  sudo apt install arkestrator"
}

install_arch() {
  info "Detected Arch-based distro."
  info ""
  info "Install from AUR:"
  info "  yay -S arkestrator-bin"
  info ""
  info "Or manually:"
  info "  git clone https://aur.archlinux.org/arkestrator-bin.git"
  info "  cd arkestrator-bin && makepkg -si"
}

DISTRO=$(detect_distro)

case "$DISTRO" in
  rpm)  install_rpm  ;;
  deb)  install_deb  ;;
  arch) install_arch ;;
  *)
    error "Could not detect your Linux distribution."
    error "Manual install options:"
    error "  RPM (Fedora/RHEL): sudo dnf config-manager addrepo --from-repofile=${REPO_BASE}/arkestrator.repo"
    error "  DEB (Debian/Ubuntu): See ${REPO_BASE}/#debian"
    error "  Arch (AUR): yay -S arkestrator-bin"
    exit 1
    ;;
esac

info "Done!"
