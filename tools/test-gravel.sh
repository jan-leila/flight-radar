#!/usr/bin/env bash
# Runs the app through Gravel (https://github.com/jan-leila/gravel): the Pebble emulator is attached as a watch to
# a debug build of Gravel on an Android device or emulator, and the .pbw is installed through Gravel's developer
# connection, so the phone side runs in Gravel's PebbleKit JS runtime with Gravel's permissions and the live
# services.
#
#   tools/test-gravel.sh [--serial ADB_SERIAL] [--platform emery|gabbro] [--seconds N] [--expect locating|answer] [PBW]
#
# Needs: adb, one device with a DEBUG build of Gravel (release builds have no adb hooks), and for a map and
# aircraft: Settings > Apps > Watch App Permissions > Plane Watch, Internet access and Location: Allow.
# PBW defaults to build/plane-watch.pbw (built when missing). Runs N seconds (default 60), prints what the phone
# side logged and saves the watch's screen to test/gravel-out/<platform>.png.
#
# --expect answer (default) fails when the watch still shows its first screen ("Locating...", the phone side never
# answered); --expect locating fails when it does not: that is what Gravel's defaults (internet and location
# denied) have to give.
#
# The first time a watch is attached Gravel asks "Keep watch / Replace" on the phone: answer it, the script waits.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if ! command -v pebble >/dev/null 2>&1; then
  exec nix-shell "$ROOT/shell.nix" --run "bash $(printf '%q' "$0")$([ $# -gt 0 ] && printf ' %q' "$@")"
fi
# The nix shell names an emulator here, and pebble-tool prefers it over --phone.
unset PEBBLE_EMULATOR

GRAVEL=com.anopticlabs.gravel.signed
DEVICE_PORT=12344
SERIAL=""
PLAT=emery
SECONDS_TO_RUN=60
EXPECT=answer
PBW=""
while [ $# -gt 0 ]; do
  case "$1" in
    --serial) SERIAL="$2"; shift ;;
    --platform) PLAT="$2"; shift ;;
    --seconds) SECONDS_TO_RUN="$2"; shift ;;
    --expect) EXPECT="$2"; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) PBW="$1" ;;
  esac
  shift
done
ADB=(adb)
[ -n "$SERIAL" ] && ADB=(adb -s "$SERIAL")
OUT=$ROOT/test/gravel-out
mkdir -p "$OUT"
cd "$ROOT"

QEMU_PID=""
stop() { [ -n "$QEMU_PID" ] && kill "$QEMU_PID" 2>/dev/null; }
trap stop EXIT
fail() { echo "FAIL: $*"; exit 1; }
broadcast() {  # broadcast ACTION RECEIVER [extras...]: prints the broadcast's result line
  "${ADB[@]}" shell am broadcast -a "coredevices.coreapp.$1" -n "$GRAVEL/coredevices.coreapp.debug.$2" "${@:3}" | tail -1
}

"${ADB[@]}" get-state >/dev/null 2>&1 || fail "no adb device"
"${ADB[@]}" shell pm path "$GRAVEL" | grep -q . || fail "Gravel ($GRAVEL) is not installed on the device"
if [ -z "$PBW" ]; then
  PBW=build/plane-watch.pbw
  [ -f "$PBW" ] || pebble build >/dev/null 2>&1 || fail "pebble build"
fi

# A fresh watch. pebble-tool starts the emulator together with its own phone simulator (pypkjs), which holds the
# watch's only connection: stop it and hand the connection to Gravel.
before=$(pgrep -x qemu-pebble | tr '\n' ' ')
timeout 180 pebble emu-battery --percent 100 --emulator "$PLAT" >/dev/null 2>&1 || fail "the Pebble emulator did not start"
for pid in $(pgrep -x qemu-pebble); do
  case " $before " in *" $pid "*) ;; *) QEMU_PID=$pid ;; esac
done
[ -n "$QEMU_PID" ] || fail "no new qemu-pebble process (is another $PLAT emulator of this user running? pebble kill)"
PORT=$(tr '\0' '\n' <"/proc/$QEMU_PID/cmdline" | grep -o 'tcp::[0-9]*' | sed -n 1p | cut -d: -f3)
pkill -f "pypkjs --qemu localhost:$PORT " || true
sleep 1

# Always the same port on the device, so that Gravel sees the same watch on every run.
"${ADB[@]}" reverse "tcp:$DEVICE_PORT" "tcp:$PORT" >/dev/null || fail "adb reverse"
"${ADB[@]}" shell monkey -p "$GRAVEL" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 3
broadcast ADD_QEMU_WATCH QemuSetupReceiver --es host 127.0.0.1 --ei port "$DEVICE_PORT" | grep -q 'result=0' ||
  fail "Gravel did not take the watch (a release build has no adb hooks)"
echo "[gravel] attached the $PLAT emulator; waiting for Gravel to connect (answer 'Keep watch' on the phone if asked)"
"${ADB[@]}" forward tcp:9000 tcp:9000 >/dev/null || fail "adb forward"

LOG=$OUT/$PLAT-logs.txt
SHOT=$OUT/$PLAT.png
# screen: 'locating' (the app's first screen, as in the pixel comparison), 'app' (anything else on the app's black
# background) or 'other' (not this app: a launcher, a dialog)
screen() {
  rm -f "$SHOT"
  timeout 60 pebble screenshot --no-open --phone 127.0.0.1 "$SHOT" >/dev/null 2>&1
  [ -s "$SHOT" ] || { echo other; return; }
  node -e "
    const { decode, diff } = require('./tools/lib/png-diff');
    const fs = require('fs');
    const shot = decode(fs.readFileSync(process.argv[2]));
    const d = diff(decode(fs.readFileSync(process.argv[1])), shot, {});
    let black = 0;
    for (let i = 0; i < shot.data.length; i += 4) if (shot.data[i] + shot.data[i + 1] + shot.data[i + 2] === 0) black++;
    console.log(!d.sizeMismatch && d.diffPixels === 0 ? 'locating' : black * 4 > shot.data.length * 0.7 ? 'app' : 'other');" \
    "test/screenshots/baseline/$PLAT/01-locating.png" "$SHOT"
}

running=0
for _ in $(seq 40); do  # until Gravel has the watch (and the question on the phone is answered) and the app is up
  if broadcast DEV_CONNECTION DevConnectionReceiver | grep -q 'result=0'; then
    pkill -f 'pebble logs --phone 127.0.0.1' || true
    : >"$LOG"
    ( timeout $((SECONDS_TO_RUN + 60)) pebble logs --phone 127.0.0.1 >"$LOG" 2>&1 & )
    sleep 2
    if timeout 120 pebble install --phone 127.0.0.1 "$PBW" 2>&1 | grep -q 'succeeded'; then
      sleep 5
      # While Gravel is still setting the watch up, an installed app is not started.
      [ "$(screen)" != other ] && { running=1; break; }
    fi
  fi
  sleep 3
done
[ "$running" = 1 ] || fail "the app did not start through Gravel (is the watch connected in Gravel?)"
echo "[gravel] installed $PBW; running for $SECONDS_TO_RUN s"
sleep "$SECONDS_TO_RUN"
state=$(screen)
echo "[gravel] phone side log:"
grep 'pkjs>' "$LOG" | sed 's/^/  /'
echo "[gravel] watch screen: $SHOT"
case "$EXPECT:$state" in
  answer:app) echo "PASS: the phone side answered" ;;
  answer:locating) fail "the watch still shows 'Locating...': the phone side did not run or could not answer (Watch App Permissions?)" ;;
  locating:locating) echo "PASS: nothing reached the watch" ;;
  locating:app) fail "expected the watch to stay on 'Locating...'" ;;
  answer:other|locating:other) fail "the app is not on the watch's screen" ;;
  *) fail "--expect takes 'answer' or 'locating'" ;;
esac
