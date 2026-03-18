#!/bin/sh
set -eu

timeout_seconds="${ARKESTRATOR_PNPM_INSTALL_TIMEOUT_SECONDS:-300}"
heartbeat_seconds="${ARKESTRATOR_PNPM_INSTALL_HEARTBEAT_SECONDS:-30}"
install_attempts="${ARKESTRATOR_PNPM_INSTALL_ATTEMPTS:-2}"
install_filter="${ARKESTRATOR_PNPM_FILTER:-}"
install_prod="${ARKESTRATOR_PNPM_PROD:-0}"
install_extra_args="${ARKESTRATOR_PNPM_INSTALL_EXTRA_ARGS:-}"

run_with_timeout() {
  label="$1"
  timeout_limit="$2"
  shift 2

  echo "[$label] starting (timeout ${timeout_limit}s): $*"

  "$@" &
  child_pid=$!
  start_ts="$(date +%s)"

  (
    while kill -0 "$child_pid" 2>/dev/null; do
      sleep "$heartbeat_seconds"
      if ! kill -0 "$child_pid" 2>/dev/null; then
        break
      fi

      now_ts="$(date +%s)"
      elapsed=$((now_ts - start_ts))
      echo "[$label] heartbeat ${elapsed}s"

      if [ "$elapsed" -ge "$timeout_limit" ]; then
        echo "[$label] timeout after ${elapsed}s; sending TERM to pid ${child_pid}"
        kill -TERM "$child_pid" 2>/dev/null || true
        sleep 10

        if kill -0 "$child_pid" 2>/dev/null; then
          echo "[$label] process ignored TERM; sending KILL to pid ${child_pid}"
          kill -KILL "$child_pid" 2>/dev/null || true
        fi
        break
      fi
    done
  ) &
  watchdog_pid=$!

  set +e
  wait "$child_pid"
  child_status=$?
  set -e

  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true

  echo "[$label] exited with status ${child_status}"
  return "$child_status"
}

# Use hoisted node-linker to avoid pnpm's symlink-heavy default which
# is extremely slow on Docker BuildKit's overlay filesystem.
pnpm config set --location=project node-linker hoisted
pnpm config set --location=project fetch-retries 5
pnpm config set --location=project fetch-retry-mintimeout 10000
pnpm config set --location=project fetch-retry-maxtimeout 60000
pnpm config set --location=project network-concurrency 8

build_install_command() {
  cmd="pnpm install --frozen-lockfile --reporter=append-only"

  if [ "$install_prod" = "1" ]; then
    cmd="$cmd --prod"
  fi

  if [ -n "$install_filter" ]; then
    cmd="$cmd --filter $install_filter"
  fi

  if [ -n "$install_extra_args" ]; then
    cmd="$cmd $install_extra_args"
  fi

  printf '%s\n' "$cmd"
}

attempt=1
while [ "$attempt" -le "$install_attempts" ]; do
  install_cmd="$(build_install_command)"
  if run_with_timeout "pnpm-install-attempt-${attempt}" "$timeout_seconds" \
    sh -c "$install_cmd"; then
    exit 0
  fi

  if [ "$attempt" -eq "$install_attempts" ]; then
    echo "[pnpm-install] failed after ${install_attempts} attempt(s)"
    exit 1
  fi

  echo "[pnpm-install] retrying in 10s (attempt ${attempt}/${install_attempts})"
  attempt=$((attempt + 1))
  sleep 10
done
