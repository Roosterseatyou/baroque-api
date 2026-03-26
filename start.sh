#!/bin/sh

# Entrypoint: optionally auto-pull from git, install packages, then start API + worker
# Designed for Pterodactyl / container startup. Keeps foreground process for supervisor.

set -eu

# Ensure we operate from this script's directory (the repo root / baroque-api)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Startup script running from $SCRIPT_DIR"

# --- Auto-update / install logic (env-driven) ---
# Expected env vars: GIT_ADDRESS, BRANCH, AUTO_UPDATE ("1" to enable),
# NODE_PACKAGES (space-separated packages to install), UNNODE_PACKAGES (to uninstall)

if [ ! -d .git ]; then
  if [ -n "${GIT_ADDRESS:-}" ]; then
    echo "Cloning repository from ${GIT_ADDRESS} (branch ${BRANCH:-main})..."
    git clone "${GIT_ADDRESS}" . -b "${BRANCH:-main}" || echo "git clone failed (continuing)"
  else
    echo "No .git directory and GIT_ADDRESS not set — skipping clone"
  fi
fi

if [ -d .git ] && [ "${AUTO_UPDATE:-0}" = "1" ]; then
  echo "AUTO_UPDATE=1 — fetching latest from origin/${BRANCH:-main}"
  git fetch --all || echo "git fetch failed (continuing)"
  git reset --hard "origin/${BRANCH:-main}" || echo "git reset failed (continuing)"
fi

if [ -n "${UNNODE_PACKAGES:-}" ]; then
  echo "Uninstalling node packages: ${UNNODE_PACKAGES}"
  /usr/local/bin/npm uninstall ${UNNODE_PACKAGES} || echo "npm uninstall failed (continuing)"
fi

if [ -n "${NODE_PACKAGES:-}" ]; then
  echo "Installing node packages: ${NODE_PACKAGES}"
  /usr/local/bin/npm install ${NODE_PACKAGES} || echo "npm install (specific) failed (continuing)"
fi

if [ -f package.json ]; then
  echo "Running npm install (package.json present)"
  /usr/local/bin/npm install || echo "npm install failed (continuing)"
fi

# --- Start processes ---
# If MAIN_FILE is provided, run it instead of starting the default API + worker
if [ -n "${MAIN_FILE:-}" ]; then
  echo "MAIN_FILE is set to '${MAIN_FILE}' — running custom main file"
  # prefer the SCRIPT_DIR as base if MAIN_FILE is a relative path
  MAIN_PATH="$MAIN_FILE"
  case "$MAIN_FILE" in
    /*) MAIN_PATH="$MAIN_FILE" ;; # absolute path — use as-is
    *) MAIN_PATH="$SCRIPT_DIR/$MAIN_FILE" ;; # relative to script dir
  esac

  if echo "$MAIN_FILE" | grep -E '\.js$' >/dev/null 2>&1; then
    echo "Running node ${MAIN_PATH} ${NODE_ARGS:-}"
    /usr/local/bin/node "$MAIN_PATH" ${NODE_ARGS:-}
    EXIT_CODE=$?
    echo "Custom main process exited with code $EXIT_CODE"
    exit $EXIT_CODE
  else
    echo "Running ts-node (ESM) ${MAIN_PATH} ${NODE_ARGS:-}"
    # attempt to run via ts-node; fall back to node if ts-node not present
    if command -v ts-node >/dev/null 2>&1; then
      ts-node --esm "$MAIN_PATH" ${NODE_ARGS:-}
      EXIT_CODE=$?
      echo "Custom ts-node process exited with code $EXIT_CODE"
      exit $EXIT_CODE
    else
      echo "ts-node not available; attempting to run with node"
      /usr/local/bin/node "$MAIN_PATH" ${NODE_ARGS:-}
      EXIT_CODE=$?
      echo "Fallback node process exited with code $EXIT_CODE"
      exit $EXIT_CODE
    fi
  fi
fi

echo "Starting API server..."
node ./src/server.js &
API_PID=$!

echo "Starting duplicate-scan worker..."
node ./src/worker/dupWorker.js &
WORKER_PID=$!

# Forward SIGINT/SIGTERM to children and wait for graceful shutdown
term_handler() {
  echo "Received signal, shutting down children..."
  if kill -0 "$API_PID" 2>/dev/null; then
    kill -TERM "$API_PID" 2>/dev/null || true
  fi
  if kill -0 "$WORKER_PID" 2>/dev/null; then
    kill -TERM "$WORKER_PID" 2>/dev/null || true
  fi
  # wait for children to exit
  wait "$API_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  echo "Shutdown complete"
  exit 0
}

trap 'term_handler' INT TERM

# If either process exits, terminate the other and exit with its status
( wait "$API_PID"; RC=$?; echo "API process exited with $RC"; kill -TERM "$WORKER_PID" 2>/dev/null || true; exit $RC ) &
WATCHER_API=$!
( wait "$WORKER_PID"; RC=$?; echo "Worker process exited with $RC"; kill -TERM "$API_PID" 2>/dev/null || true; exit $RC ) &
WATCHER_WORKER=$!

# Wait for any child to exit (the subshells above handle cleanup/exit)
wait

