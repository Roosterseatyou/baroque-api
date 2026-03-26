#!/bin/sh

set -eu

# Start the API server
echo "Starting API server..."
node ./src/server.js &
API_PID=$!

# Start the duplicate-scan worker
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

