#!/bin/sh
set -e

# Wait for DB to be available (simple loop using nc)
# If DATABASE_URL is provided (e.g. mysql://user:pass@host:port/db) parse host/port
if [ -n "${DATABASE_URL}" ]; then
  # strip protocol
  stripped=$(echo "${DATABASE_URL}" | sed -E 's#^[a-zA-Z0-9+.-]+://##')
  # after stripping creds and protocol, host may be user:pass@host:port/db
  # remove user:pass@ if present
  hostpart=$(echo "${stripped}" | sed -E 's#.*@##')
  # extract host:port (before first /)
  hostport=$(echo "${hostpart}" | cut -d'/' -f1)
  DB_HOST=$(echo "${hostport}" | cut -d':' -f1)
  DB_PORT=$(echo "${hostport}" | cut -s -d':' -f2)
  DB_PORT=${DB_PORT:-3306}
else
  DB_HOST=${DB_HOST:-db}
  DB_PORT=${DB_PORT:-3306}
fi
TIMEOUT=${DB_WAIT_TIMEOUT:-60}

start_time=$(date +%s)
echo "Waiting for database at ${DB_HOST}:${DB_PORT} (timeout ${TIMEOUT}s)"
while ! nc -z ${DB_HOST} ${DB_PORT}; do
  now=$(date +%s)
  elapsed=$((now - start_time))
  if [ ${elapsed} -ge ${TIMEOUT} ]; then
    echo "Timed out waiting for DB after ${TIMEOUT}s"
    exit 1
  fi
  sleep 1
done

echo "Database reachable, running migrations"
if [ -f ./knexfile.cjs ]; then
  npx knex migrate:latest --knexfile ./knexfile.cjs
else
  echo "No knexfile found, skipping migrations"
fi

echo "Starting server"
# --- Safe env presence check (masked) ---
# Prints whether important env vars are set without exposing full secret values.
mask() {
  v="$1"
  len=${#v}
  if [ "$len" -le 8 ]; then
    echo "$v"
  else
    start=$(echo "$v" | cut -c1-3)
    end=$(echo "$v" | rev | cut -c1-3 | rev)
    echo "${start}...${end}"
  fi
}

check_var() {
  key="$1"
  # get variable value
  eval "val=\".$key\"" 2>/dev/null || true
  # The eval above can be quirky; fallback read from environment
  if [ -z "$val" ]; then
    # try indirect expansion (POSIX sh compat)
    val=$(eval echo "\\\$$key")
  fi
  if [ -z "$val" ]; then
    echo "[env] $key: MISSING"
  else
    masked=$(mask "$val")
    echo "[env] $key: SET ($masked)"
  fi
}

echo "Checking essential environment variables (values masked):"
for k in JWT_SECRET DATABASE_URL FRONTEND_ORIGIN NODE_ENV GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  check_var "$k"
done
# --- end env presence check ---

# If command-line args were provided to the container, exec them. Otherwise start node server.
if [ "$#" -gt 0 ]; then
  exec "$@"
else
  exec node ./src/server.js
fi

