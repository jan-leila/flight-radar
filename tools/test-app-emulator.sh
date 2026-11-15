#!/usr/bin/env bash
# End-to-end test of the real app in the Pebble emulator: builds with src/pkjs/app-fixture.js (the real phone
# side, index.js, on canned network answers and a fixed position), then checks that the watch gets aircraft and
# roads, that UP selects a plane and fetches its trace, and that SELECT zooms.
#
# usage (inside nix-shell): tools/test-app-emulator.sh [platform]      (default emery)
#
# Screenshots go to test/app-out/<platform>-{map,selected,zoomed}.png.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if ! command -v pebble >/dev/null 2>&1; then exec nix-shell "$ROOT/shell.nix" --run "bash $0 $*"; fi
PLAT=${1:-emery}
REAL_SDK_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pebble-sdk"
OUT=$ROOT/test/app-out
STATE=$OUT/.state
LOG=$OUT/$PLAT-logs.txt
mkdir -p "$OUT" "$STATE/xdg/pebble-sdk" "$STATE/tmp"
[ -e "$STATE/xdg/pebble-sdk/SDKs" ] || ln -s "$REAL_SDK_DIR/SDKs" "$STATE/xdg/pebble-sdk/SDKs"
export XDG_DATA_HOME=$STATE/xdg TMPDIR=$STATE/tmp
cd "$ROOT"

stop() { pebble kill >/dev/null 2>&1 || true; pebble clean >/dev/null 2>&1 || true; }  # clean: waf does not track PKJS_ENTRY
fail() { echo "FAIL: $*"; stop; exit 1; }
wait_log() {  # wait_log PATTERN SECONDS [COUNT]
  local i
  for ((i = 0; i < $2 * 2; i++)); do
    [ "$(grep -c -- "$1" "$LOG")" -ge "${3:-1}" ] && return 0
    sleep 0.5
  done
  return 1
}
shot() {
  local try
  for try in 1 2 3; do
    rm -f "$OUT/$PLAT-$1.png"
    timeout 30 pebble screenshot --no-open --emulator "$PLAT" "$OUT/$PLAT-$1.png" >/dev/null 2>&1 || true
    [ -s "$OUT/$PLAT-$1.png" ] && return 0
    sleep 2
  done
  fail "screenshot $1"
}
# road_pixels FILE: how many pixels of the screenshot have the colour of a road (dark grey; the emulator shows it as 84)
road_pixels() {
  node -e "
    const png = require('./tools/lib/png-diff').decode(require('fs').readFileSync(process.argv[1]));
    let n = 0;
    for (let i = 0; i < png.data.length; i += 4) if (Math.abs(png.data[i] - 85) <= 2 && png.data[i + 1] === png.data[i] && png.data[i + 2] === png.data[i]) n++;
    console.log(n);" "$1"
}

pebble clean >/dev/null 2>&1
PKJS_ENTRY=src/pkjs/app-fixture.js pebble build >"$STATE/build.log" 2>&1 || { tail -20 "$STATE/build.log"; fail "pebble build"; }
PBW=$STATE/plane-watch-app-fixture.pbw
cp build/plane-watch.pbw "$PBW"
pebble clean >/dev/null 2>&1
pebble kill >/dev/null 2>&1 || true; sleep 2
timeout 180 pebble install --emulator "$PLAT" "$PBW" >"$STATE/install.log" 2>&1 || { cat "$STATE/install.log"; fail "install"; }
: >"$LOG"
( pebble logs --emulator "$PLAT" >"$LOG" 2>&1 & )

# The fixture repeats what it was asked for every 2 s, so it does not matter when the logs attach.
wait_log "APP-FIXTURE seen planes=[1-9]" 40 || fail "the phone never asked for aircraft (see $LOG)"
wait_log "roads=motorway,trunk,primary,secondary " 40 || fail "the phone did not ask for the four road tiers in order (see $LOG)"
sleep 8  # the last map travels to the watch
shot map
[ "$(road_pixels "$OUT/$PLAT-map.png")" -gt 2000 ] || fail "no roads on the watch (see $OUT/$PLAT-map.png)"

timeout 20 pebble emu-button --emulator "$PLAT" click up >/dev/null 2>&1 || fail "UP"
wait_log "trace=1 " 15 || fail "selecting a plane did not fetch its trace (see $LOG)"
sleep 3
shot selected
cmp -s "$OUT/$PLAT-map.png" "$OUT/$PLAT-selected.png" && fail "UP changed nothing on the watch"

timeout 20 pebble emu-button --emulator "$PLAT" click select >/dev/null 2>&1 || fail "SELECT"
sleep 8
shot zoomed
cmp -s "$OUT/$PLAT-selected.png" "$OUT/$PLAT-zoomed.png" && fail "SELECT changed nothing on the watch"
sleep 3
tail -n 3 "$LOG" | grep -q "roads=motorway,trunk,primary,secondary trace=1 unknown=0" || fail "zooming fetched something again (see $LOG)"

stop
echo "screenshots: $OUT/$PLAT-{map,selected,zoomed}.png"
echo "PASS ($PLAT)"
