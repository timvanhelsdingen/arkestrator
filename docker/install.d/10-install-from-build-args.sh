#!/bin/sh
set -eu

apt_packages="${ARKESTRATOR_APT_PACKAGES:-}"
bun_packages="${ARKESTRATOR_BUN_GLOBAL_PACKAGES:-}"
pip_packages="${ARKESTRATOR_PIP_PACKAGES:-}"
install_commands="${ARKESTRATOR_INSTALL_COMMANDS:-}"
install_commands_timeout="${ARKESTRATOR_INSTALL_COMMANDS_TIMEOUT_SECONDS:-900}"
apt_updated=0

if [ -n "$apt_packages" ] || [ -n "$pip_packages" ]; then
  apt-get update
  apt_updated=1
fi

if [ -n "$apt_packages" ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $apt_packages
fi

if [ -n "$pip_packages" ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-pip
  pip3 install --no-cache-dir $pip_packages
fi

if [ -n "$bun_packages" ]; then
  # Dockerfile sets BUN_INSTALL=/usr/local/bun so Bun-installed CLIs land in a
  # system-wide location that remains executable after the runtime switches to
  # the non-root `bun` user.
  if ! command -v node >/dev/null 2>&1; then
    if [ "$apt_updated" -eq 0 ]; then
      apt-get update
      apt_updated=1
    fi
    # Bun-installed global CLIs like codex/claude rely on a node runtime shim.
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs npm
  fi
  bun install -g $bun_packages
fi

if [ -n "$install_commands" ]; then
  # User-supplied install commands for tools without apt/npm/pip installers.
  if command -v timeout >/dev/null 2>&1; then
    timeout "${install_commands_timeout}" /bin/sh -lc "$install_commands"
  else
    /bin/sh -lc "$install_commands"
  fi
fi

if [ "$apt_updated" -eq 1 ]; then
  rm -rf /var/lib/apt/lists/*
fi
