#!/usr/bin/env bash
# Open the Peak probe in a Chromium that actually has Web Bluetooth.
#
# Brave ships Web Bluetooth disabled with no working switch, so the probe cannot
# run there. This launches a Chromium build with the feature enabled and a
# dedicated profile, so the pairing survives between runs.
#
#   ./probe.sh              open the probe
#   ./probe.sh --sim        open it against the simulator (no hardware)
#   PORT=9000 ./probe.sh    different port

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8791}"
URL="http://127.0.0.1:${PORT}/probe.html"
[[ "${1:-}" == "--sim" ]] && URL="${URL}?sim=1"

# --- find a Chromium with the Web Bluetooth feature compiled in --------------
CANDIDATES=(
  "${CHROME_PATH:-}"
  "$HOME/.cache/ms-playwright/chromium-"*/chrome-linux64/chrome
  "$HOME/.cache/ms-playwright/chromium-"*/chrome-linux/chrome
  /usr/bin/chromium
  /usr/bin/chromium-browser
  /usr/bin/google-chrome
  /usr/bin/microsoft-edge
)

BROWSER=""
for c in "${CANDIDATES[@]}"; do
  [[ -n "$c" && -x "$c" ]] && { BROWSER="$c"; break; }
done

if [[ -z "$BROWSER" ]]; then
  cat >&2 <<'MSG'
No Chromium found. Install one:

  sudo pacman -S chromium

Brave and Firefox cannot do Web Bluetooth here, so they are not options.
MSG
  exit 1
fi

echo "browser: $BROWSER"

# --- serve the ui directory -------------------------------------------------
if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/probe.html"; then
  echo "server:  already running on ${PORT}"
else
  python3 -m http.server "$PORT" --bind 127.0.0.1 --directory ui >/tmp/peak-probe-server.log 2>&1 &
  echo "server:  started on ${PORT} (pid $!)"
  for _ in $(seq 1 30); do
    curl -sf -o /dev/null "http://127.0.0.1:${PORT}/probe.html" && break
    sleep 0.1
  done
fi

# --- launch ----------------------------------------------------------------
# A dedicated profile keeps the BLE pairing between runs, and stops the browser
# from attaching to an existing session that was started without the flag.
PROFILE="$HOME/.cache/peak-probe-profile"
mkdir -p "$PROFILE"

echo "opening: $URL"
exec "$BROWSER" \
  --enable-features=WebBluetooth \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  "$URL"
