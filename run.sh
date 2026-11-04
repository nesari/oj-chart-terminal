#!/usr/bin/env bash
# AUDIT FIX (installation/cross-platform): the project previously only
# shipped run-demo.bat / run-mt5.bat (Windows). main.js already branches
# pyExe() between 'python' and 'python3', so the app logic itself works on
# macOS/Linux; this script is the missing launcher for those platforms,
# mirroring exactly what the .bat files do (install once, verify the
# Electron binary against its official checksum, then launch).
#
# Usage:
#   ./run.sh          -> demo mode (simulated data)
#   ./run.sh mt5      -> real MetaTrader 5 mode
#   ./run.sh [flags]  -> any other flag (e.g. --no-sandbox) is forwarded as-is
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-demo}"
# F6.2: keep any extra Electron flags the user passes (e.g. --no-sandbox on
# distributions whose kernel/AppArmor policy blocks the SUID sandbox).
# ROUND270: a plain string, not an array — stock macOS ships bash 3.2, where
# `set -u` treats an EMPTY array as unbound and the documented demo launch
# (`./run.sh`, no flags) died with "ARGS[@]: unbound variable".
MODE_FLAG=""
if [ "$MODE" = "mt5" ]; then
  MODE_FLAG="--mode=mt5"
  shift || true
elif [ "$MODE" = "demo" ]; then
  shift || true
fi

if [ ! -x "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ] && \
   [ ! -x "node_modules/.bin/electron" ]; then
  echo "First run: installing Electron, please wait..."
  npm install --no-audit --no-fund
  echo "Verifying downloaded Electron against the OFFICIAL GitHub release checksum..."
  if ! node scripts/verify-electron.js; then
    echo ""
    echo "SECURITY: Electron checksum verification failed. The downloaded binary"
    echo "does not match the official release and will NOT be launched."
    echo "Delete node_modules and the electron cache, then try again."
    exit 1
  fi
fi

# shellcheck disable=SC2086  # MODE_FLAG is one fixed token (or empty)
npx electron . $MODE_FLAG "$@"
