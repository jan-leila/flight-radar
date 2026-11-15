#!/usr/bin/env bash
# Pixel comparison of the watch app with the original Flight Radar in the Pebble emulator, driven by
# src/pkjs/ui-fixture.js.
#
#   tools/screenshots.sh [--update] [--threshold F] [platform...]   # default platforms: emery gabbro
#
# Builds the fixture app (PKJS_ENTRY=src/pkjs/ui-fixture.js, after `pebble clean`), then per platform walks the fixed
# SCENES below and saves test/screenshots/current/<platform>/<scene>.png. The images are then compared with
# test/screenshots/baseline/ (tools/lib/png-diff.js): diff images go to test/screenshots/diff/, a table is printed,
# and the exit status is non-zero when any image differs by more than F (fraction of pixels, default 0: the app has
# to match pixel for pixel) or is missing.
#
# --update records the baseline instead, and records it from the ORIGINAL app: its watch binaries
# (tools/reference.py fetches the .pbw) run with the same fixture as their phone side, since both apps speak the
# same protocol. The baseline is therefore what the original draws, never what this app happens to draw.
#
# Determinism: the app has no clock and no animation; every scene is the result of the fixture's messages and of
# button presses, and the script waits for the fixture's log lines before each screenshot.
#
# The emulator of the round watch stops answering after some twenty screenshots, so every BOOT_SHOTS screenshots the
# emulator is restarted and the scenes are replayed up to where it left off.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v pebble >/dev/null 2>&1; then
  # (printf with no arguments would still print one empty word)
  exec nix-shell "$ROOT/shell.nix" --run "bash $(printf '%q' "${BASH_SOURCE[0]}")$([ $# -gt 0 ] && printf ' %q' "$@")"
fi

UPDATE=0
THRESHOLD=0
PLATFORMS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --update) UPDATE=1 ;;
    --threshold) THRESHOLD="$2"; shift ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) PLATFORMS+=("$1") ;;
  esac
  shift
done
[ ${#PLATFORMS[@]} -gt 0 ] || PLATFORMS=(emery gabbro)

SHOTS="$ROOT/test/screenshots"
if [ "$UPDATE" = 1 ]; then DEST="$SHOTS/baseline"; else DEST="$SHOTS/current"; fi
STATE="$SHOTS/.state"
REAL_SDK_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pebble-sdk"
mkdir -p "$STATE/xdg/pebble-sdk" "$STATE/tmp"
[ -e "$STATE/xdg/pebble-sdk/SDKs" ] || ln -s "$REAL_SDK_DIR/SDKs" "$STATE/xdg/pebble-sdk/SDKs"
export XDG_DATA_HOME="$STATE/xdg" TMPDIR="$STATE/tmp"
cd "$ROOT" || exit 1

fail=0
P=""
LOGS_PID=""
LOG=""
note() { echo "[screenshots $P] $*"; }
bad() { echo "[screenshots $P] FAIL: $*" >&2; fail=1; }

kill_emulator() {
  [ -n "$LOGS_PID" ] && kill "$LOGS_PID" 2>/dev/null
  LOGS_PID=""
  pebble kill >/dev/null 2>&1
  for sig in TERM KILL; do
    for pid in $(ps -eo pid,args | grep -E '[q]emu-pebble|[p]ypkjs' | grep -F "$STATE/" | awk '{print $1}'); do
      kill -s "$sig" "$pid" 2>/dev/null
    done
    sleep 1
  done
}
trap 'kill_emulator; pebble clean >/dev/null 2>&1' EXIT

echo "[screenshots] building with ui-fixture.js"
pebble clean >/dev/null 2>&1
if ! PKJS_ENTRY=src/pkjs/ui-fixture.js pebble build >"$STATE/build.log" 2>&1; then
  tail -30 "$STATE/build.log" >&2
  echo "[screenshots] pebble build failed (see $STATE/build.log)" >&2
  exit 1
fi
PBW="$STATE/plane-watch-ui-fixture.pbw"
if [ "$UPDATE" = 1 ]; then
  echo "[screenshots] recording the baseline from the original app's watch binaries"
  python3 tools/reference.py repack build/pebble-js-app.js "$PBW" || exit 1
else
  cp build/plane-watch.pbw "$PBW"
fi
pebble clean >/dev/null 2>&1  # the fixture bundle must never be mistaken for the real app

e() { timeout 30 pebble "$1" --emulator "$P" "${@:2}" >/dev/null 2>&1; }

wait_log() {  # wait_log PATTERN SECONDS [COUNT]: the pattern is on at least COUNT (default 1) log lines
  local i
  for ((i = 0; i < $2 * 2; i++)); do
    [ "$(grep -c -- "$1" "$LOG")" -ge "${3:-1}" ] && return 0
    sleep 0.5
  done
  return 1
}

BOOT_SHOTS=12
STEP=0
next_step() {  # SELECT -> CMD_VIEW -> the fixture runs its next STEP and reports when the watch has it all
  [ "$PAST" = 1 ] && return
  STEP=$((STEP + 1))
  e emu-button click select || bad "select"
  # The press is lost when it lands while another message of the watch is still on its way: press again.
  wait_log "UI-FIXTURE step ${STEP} " 5 || e emu-button click select || bad "select"
  wait_log "UI-FIXTURE done ${STEP}\$" 60 || bad "fixture step $STEP not delivered"
  sleep 1
}

PICKS=0
pick() {  # pick up|down: moves the selection; the watch asks for the flight path 300 ms later
  [ "$PAST" = 1 ] && return
  PICKS=$((PICKS + 1))
  e emu-button click "$1" || bad "$1"
  wait_log "UI-FIXTURE trail " 20 "$PICKS" || bad "selection $PICKS ($1) not reported"
  sleep 1
}

btn() { [ "$PAST" = 1 ] && return; e emu-button click "$1" || bad "$1"; sleep 1; }

shot() {  # shot NAME: taken when it is one of this boot's BOOT_SHOTS, skipped when an earlier boot took it
  local f="$DEST/$P/$1.png" try
  SHOT=$((SHOT + 1))
  [ "$SHOT" -le "$TAKEN" ] && return
  if [ "$SHOT" -gt $((TAKEN + BOOT_SHOTS)) ]; then PAST=1; return; fi
  for try in 1 2 3; do
    rm -f "$f"
    timeout 30 pebble screenshot --no-open --emulator "$P" "$f" >/dev/null 2>&1
    [ -s "$f" ] && { note "$1"; return 0; }
    sleep 2
  done
  bad "screenshot $1 failed"
}

# The scene list. Each next_step must match the fixture's STEPS order (src/pkjs/ui-fixture.js).
run_scenes() {
  shot 01-locating                    # the hello is not answered yet
  next_step;  shot 02-status          # a status text from the phone, centred: no map yet
  next_step;  shot 03-receiving       # a view has begun
  next_step;  shot 04-map             # roads and a busy sky: label spacing, altitude colours, edges
  pick up;    shot 05-selected        # the closest plane: details and its flight path
  pick up;    shot 06-next            # the next one out: no callsign, so its address
  pick up;    shot 07-ground          # a plane on the ground, without type and tail number
  pick down; pick down; pick down
              shot 08-wrapped         # back past the closest plane to the farthest one on screen
  btn back;   shot 09-deselected
  next_step;  shot 10-rendering       # the watch's own note after SELECT, across the map
  next_step;  shot 11-refresh         # planes only: other planes over the same map
  pick up;    shot 12-corner-1        # labels pushed back on screen; a path crossing the usual label place
  pick up;    shot 13-corner-2
  pick up;    shot 14-corner-3
  pick up;    shot 15-corner-4
  pick up;    shot 16-corner-5
  next_step;  shot 17-road-timeout    # no roads and the reason; the selection follows its plane
  btn back
  next_step;  shot 18-phone-error     # an error text from the phone
  next_step;  shot 19-watch-error     # a bitmap chunk out of order
  next_step;  shot 20-no-planes       # a new view clears the error; UP has nothing to pick
  btn up;     shot 21-no-planes-up
  next_step;  shot 22-three-planes
}

for P in "${PLATFORMS[@]}"; do
  mkdir -p "$DEST/$P"
  rm -f "$DEST/$P"/*.png
  LOG="$STATE/$P-logs.txt"
  TAKEN=0
  PAST=1
  while [ "$PAST" = 1 ]; do  # one emulator boot per BOOT_SHOTS screenshots
    STEP=0
    PICKS=0
    SHOT=0
    PAST=0
    installed=0
    for try in 1 2 3; do  # a freshly started emulator sometimes refuses the first install
      kill_emulator
      note "starting emulator"
      timeout 180 pebble install --emulator "$P" "$PBW" >"$STATE/$P-install.log" 2>&1 && { installed=1; break; }
    done
    if [ "$installed" = 0 ]; then
      cat "$STATE/$P-install.log" >&2
      bad "install failed"
      break
    fi
    : >"$LOG"
    pebble logs --emulator "$P" >"$LOG" 2>&1 &
    LOGS_PID=$!
    wait_log "UI-FIXTURE hello" 30 || bad "the watch never said hello"
    sleep 1
    run_scenes
    kill_emulator
    TAKEN=$((TAKEN + BOOT_SHOTS))
  done
done

P=""
if [ "$UPDATE" = 1 ]; then
  echo "[screenshots] baseline written to $DEST"
  exit "$fail"
fi
rm -rf "$SHOTS/diff"
# compare only the platforms that ran
CMP_BASE="$STATE/cmp-baseline"; CMP_CUR="$STATE/cmp-current"
rm -rf "$CMP_BASE" "$CMP_CUR"; mkdir -p "$CMP_BASE" "$CMP_CUR"
for P in "${PLATFORMS[@]}"; do
  [ -d "$SHOTS/baseline/$P" ] && cp -r "$SHOTS/baseline/$P" "$CMP_BASE/$P"
  [ -d "$DEST/$P" ] && cp -r "$DEST/$P" "$CMP_CUR/$P"
done
node tools/lib/png-diff.js compare "$CMP_BASE" "$CMP_CUR" "$SHOTS/diff" --threshold "$THRESHOLD" || fail=1
exit "$fail"
