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
# Behavior:
# - If MAIN_FILE is provided and START_BOTH=1, start worker in background and run MAIN_FILE as the server in foreground.
# - If MAIN_FILE is provided and START_BOTH!=1, run MAIN_FILE (legacy behavior) and do not start worker.
# - If MAIN_FILE is not provided, start worker in background and run the builtin server (src/server.js) in foreground.

start_worker_bg() {
  echo "Starting duplicate-scan worker in background (nohup)..."
  # redirect worker stdout/stderr to container stdout/stderr so logs appear in console
  nohup node ./src/worker/dupWorker.js > /dev/stdout 2> /dev/stderr &
  WORKER_PID=$!
}

if [ -n "${MAIN_FILE:-}" ]; then
  # If MAIN_FILE is set but START_BOTH is not explicitly provided, and
  # MAIN_FILE points to the bundled server (e.g. src/server.js), default
  # to starting both the server and the worker. This helps Pterodactyl
  # setups that set MAIN_FILE=src/server.js by default.
  # Treat empty or unset START_BOTH as not provided; default to starting both when MAIN_FILE looks like the API server
  if [ -z "${START_BOTH:-}" ]; then
    if echo "$MAIN_FILE" | grep -E '(^|/)(src/)?server\.js$' >/dev/null 2>&1; then
      echo "Detected MAIN_FILE=${MAIN_FILE} looks like the API server — defaulting START_BOTH=1"
      START_BOTH=1
    fi
  fi
  # MAIN_FILE set
  if [ "${START_BOTH:-0}" = "1" ]; then
    # start worker, then run main file as foreground server
    start_worker_bg
    echo "MAIN_FILE is set and START_BOTH=1 — running ${MAIN_FILE} as server (foreground)"
    MAIN_PATH="$MAIN_FILE"
    case "$MAIN_FILE" in
      /*) MAIN_PATH="$MAIN_FILE" ;;
      *) MAIN_PATH="$SCRIPT_DIR/$MAIN_FILE" ;;
    esac
    trap 'echo "Shutting down worker..."; kill -TERM "$WORKER_PID" 2>/dev/null || true; wait "$WORKER_PID" 2>/dev/null || true; exit 0' INT TERM
    if echo "$MAIN_FILE" | grep -E '\.js$' >/dev/null 2>&1; then
      /usr/local/bin/node "$MAIN_PATH" ${NODE_ARGS:-}
      EXIT_CODE=$?
      echo "Server process exited with code $EXIT_CODE"
      # ensure worker is stopped
      if kill -0 "$WORKER_PID" 2>/dev/null; then kill -TERM "$WORKER_PID" 2>/dev/null || true; fi
      wait "$WORKER_PID" 2>/dev/null || true
      exit $EXIT_CODE
    else
      if command -v ts-node >/dev/null 2>&1; then
        ts-node --esm "$MAIN_PATH" ${NODE_ARGS:-}
        EXIT_CODE=$?
        echo "Server (ts-node) exited with code $EXIT_CODE"
        if kill -0 "$WORKER_PID" 2>/dev/null; then kill -TERM "$WORKER_PID" 2>/dev/null || true; fi
        wait "$WORKER_PID" 2>/dev/null || true
        exit $EXIT_CODE
      else
        /usr/local/bin/node "$MAIN_PATH" ${NODE_ARGS:-}
        EXIT_CODE=$?
        echo "Fallback server exited with code $EXIT_CODE"
        if kill -0 "$WORKER_PID" 2>/dev/null; then kill -TERM "$WORKER_PID" 2>/dev/null || true; fi
        wait "$WORKER_PID" 2>/dev/null || true
        exit $EXIT_CODE
      fi
    fi
  else
    # legacy: run MAIN_FILE only (no worker)
    echo "MAIN_FILE is set and START_BOTH!=1 — running custom main file only"
    MAIN_PATH="$MAIN_FILE"
    case "$MAIN_FILE" in
      /*) MAIN_PATH="$MAIN_FILE" ;;
      *) MAIN_PATH="$SCRIPT_DIR/$MAIN_FILE" ;;
    esac
    if echo "$MAIN_FILE" | grep -E '\.js$' >/dev/null 2>&1; then
      /usr/local/bin/node "$MAIN_PATH" ${NODE_ARGS:-}
      EXIT_CODE=$?
      echo "Custom main process exited with code $EXIT_CODE"
      exit $EXIT_CODE
    else
      if command -v ts-node >/dev/null 2>&1; then
        ts-node --esm "$MAIN_PATH" ${NODE_ARGS:-}
        EXIT_CODE=$?
        echo "Custom ts-node process exited with code $EXIT_CODE"
        exit $EXIT_CODE
      else
        /usr/local/bin/node "$MAIN_PATH" ${NODE_ARGS:-}
        EXIT_CODE=$?
        echo "Fallback node process exited with code $EXIT_CODE"
        exit $EXIT_CODE
      fi
    fi
  fi
else
  # Default: start worker background and run built-in server in foreground
  start_worker_bg
  echo "Starting API server (foreground)..."
  API_PID=0
  trap 'echo "Received signal, shutting down..."; if kill -0 "$WORKER_PID" 2>/dev/null; then kill -TERM "$WORKER_PID" 2>/dev/null || true; fi; wait "$WORKER_PID" 2>/dev/null || true; exit 0' INT TERM
  # run server in foreground (no ampersand) so this script remains the parent and can clean up the worker
  /usr/local/bin/node ./src/server.js
  EXIT_CODE=$?
  echo "API server exited with code $EXIT_CODE"
  if kill -0 "$WORKER_PID" 2>/dev/null; then
    kill -TERM "$WORKER_PID" 2>/dev/null || true
  fi
  wait "$WORKER_PID" 2>/dev/null || true
  exit $EXIT_CODE
fi

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

# script will not reach here because branches exit after running server/main; keep file end clean

