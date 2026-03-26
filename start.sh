#!/bin/sh

# Entrypoint: optionally auto-pull from git, install packages, then start API + worker
# Designed for Pterodactyl / container startup. Keeps foreground process for supervisor.

set -eu

# Ensure we operate from this script's directory (the repo root / baroque-api)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Startup script running from $SCRIPT_DIR"

# Debug: print key env vars so we can see what Pterodactyl provided
echo "ENV: MAIN_FILE='${MAIN_FILE:-}' START_BOTH='${START_BOTH:-}' DISABLE_WORKER='${DISABLE_WORKER:-}' AUTO_UPDATE='${AUTO_UPDATE:-}'"

# If RUN_DUP_QUEUE_INLINE is set to true/1, the API process will run the poller
# so we should NOT start a separate background worker process to avoid duplicates.
if [ "${RUN_DUP_QUEUE_INLINE:-}" = "true" ] || [ "${RUN_DUP_QUEUE_INLINE:-}" = "1" ]; then
  echo "RUN_DUP_QUEUE_INLINE=true — inline poller enabled; background worker will not be started by start.sh unless DISABLE_WORKER is explicitly unset"
  RUN_INLINE=1
else
  RUN_INLINE=0
fi

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
  echo "Starting duplicate-scan worker in background..."
  # redirect worker stdout/stderr to container stdout/stderr so logs appear in console
  if command -v nohup >/dev/null 2>&1; then
    nohup node ./src/worker/dupWorker.js > /dev/stdout 2> /dev/stderr &
    WORKER_PID=$!
  elif command -v setsid >/dev/null 2>&1; then
    setsid node ./src/worker/dupWorker.js > /dev/stdout 2> /dev/stderr &
    WORKER_PID=$!
  else
    # fallback: simple backgrounded node with redirected output
    node ./src/worker/dupWorker.js > /dev/stdout 2> /dev/stderr &
    WORKER_PID=$!
  fi
  echo "Worker started with PID $WORKER_PID"
}

if [ -n "${MAIN_FILE:-}" ]; then
  # Start the worker unless explicitly disabled via DISABLE_WORKER.
  if [ "$RUN_INLINE" = "1" ]; then
    echo "RUN_DUP_QUEUE_INLINE enabled — skipping starting separate background worker"
  elif echo "${DISABLE_WORKER:-}" | grep -E '^(1|true|yes|on)$' >/dev/null 2>&1; then
    echo "DISABLE_WORKER is set; not starting worker"
  else
    echo "Starting worker in background (DISABLE_WORKER not set)"
    start_worker_bg
  fi

  # MAIN_FILE set — run it in foreground (worker already started unless disabled)
  echo "MAIN_FILE is set — running ${MAIN_FILE} as server (foreground)"
  MAIN_PATH="$MAIN_FILE"
  case "$MAIN_FILE" in
    /*) MAIN_PATH="$MAIN_FILE" ;;
    *) MAIN_PATH="$SCRIPT_DIR/$MAIN_FILE" ;;
  esac
  trap 'echo "Shutting down worker..."; kill -TERM "$WORKER_PID" 2>/dev/null || true; wait "$WORKER_PID" 2>/dev/null || true; exit 0' INT TERM
    if echo "$MAIN_FILE" | grep -E '\.js$' >/dev/null 2>&1; then
      echo "Execing node ${MAIN_PATH} ${NODE_ARGS:-}"
      exec node "$MAIN_PATH" ${NODE_ARGS:-}
    else
      if command -v ts-node >/dev/null 2>&1; then
        echo "Execing ts-node ${MAIN_PATH} ${NODE_ARGS:-}"
        exec ts-node --esm "$MAIN_PATH" ${NODE_ARGS:-}
      else
        echo "Execing node (fallback) ${MAIN_PATH} ${NODE_ARGS:-}"
        exec node "$MAIN_PATH" ${NODE_ARGS:-}
      fi
    fi
else
  # Default: start worker background and run built-in server in foreground
  start_worker_bg
  echo "Starting API server (foreground)..."
  API_PID=0
  trap 'echo "Received signal, shutting down..."; if kill -0 "$WORKER_PID" 2>/dev/null; then kill -TERM "$WORKER_PID" 2>/dev/null || true; fi; wait "$WORKER_PID" 2>/dev/null || true; exit 0' INT TERM
  # run server in foreground (exec so the node process replaces this shell)
  echo "Execing node ./src/server.js"
  exec node ./src/server.js
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

