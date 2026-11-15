# Plane Watch

A Pebble watchapp that shows the aircraft around you over a road map.

The screen follows [Flight Radar](https://apps.repebble.com/flight-radar_fc84423d0b15457a94f47085) by Will Loconto (version 0.4.1, "the original" below): for the same data the watch draws the same pixels. The code is new, and the phone side gets its data differently, so that it keeps working when the road service does not. Plane Watch is a separate app with its own UUID, name and icon (`tools/draw-icon.py`), and is not affiliated with the original or its author. It runs on Pebble Time 2 (emery) and Pebble Round 2 (gabbro).

- **The map:** the motorways, trunk, primary and secondary roads within 40 miles, drawn by the phone and sent to the watch as a bitmap. Your position is the yellow dot in the middle.
- **Aircraft:** live ADS-B positions, refreshed every 30 seconds. The colour is the altitude: orange below 12,000 ft, red up to 28,000 ft, blue above. Aircraft are labelled with their callsign (greyed: the ICAO address of an aircraft that sends no callsign), closest first; one within 24 pixels of a labelled aircraft, or at the edge of the screen, gets no label.
- **UP / DOWN:** select the next / previous aircraft by distance from you. The selected aircraft turns green and shows its callsign, type and tail number, altitude, ground speed and the path it flew during the last half hour.
- **SELECT:** zoom. The app starts with 20 miles from the centre to the nearer screen edge; each press goes on to 40, 5, 10 and back to 20.
- **BACK:** drop the selection; with nothing selected, leave the app.

Aircraft data comes from [adsb.lol](https://adsb.lol) (no key), road data from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors through the Overpass API (no key).

## What is different from the original

The watch app draws the same pixels for the same messages; that is tested against the original's binaries (below). The phone side sends the same bytes as the original's for the same data, also tested, but gets the data differently:

| | original 0.4.1 | this app |
|---|---|---|
| first aircraft on screen | after the roads arrived (or 65 s) | as soon as adsb.lol answers; the map follows |
| road query | one query for all roads with all tags: about 34 MB for Minneapolis | one query per road tier, geometry only |
| road servers | overpass-api.de | three Overpass servers, tried in turn; one that answers 429 is left alone for a while |
| while roads load | every 30 s refresh starts another full road query | one road fetch at a time |
| roads failed | shown once the app is reopened | fetched again two minutes later, only the missing tiers |
| stored roads | raw JSON, too big for `localStorage` in a city, so fetched on every launch | packed losslessly (about 6 characters per point, 1.3 MB for Minneapolis), kept for a week |
| `[PE8] UA blocked` banner | shown where the phone's JavaScript cannot set a User-Agent | never shown |
| `location` capability | not declared | declared |
| aircraft refresh | a 30 s floor counted from the last answer, which by the code drops every other 30 s request of the watch once the roads are loaded | every request is answered |
| position | no older than 1 minute, 15 s to get one | no older than 10 minutes, 30 s to get one |

The status texts on the way to the first map differ accordingly (`Fetching roads...` appears under the aircraft instead of before them).

## Gravel and other Pebble apps

The phone side runs inside the Pebble phone app. In [Gravel](https://github.com/jan-leila/gravel) a watchapp gets neither internet access nor the phone's position until you allow both: Settings > Apps > Watch App Permissions > Plane Watch, *Internet access* and *Location*: Allow. Until then the watch stays on `Locating...` (Gravel does not start the phone side at all, or starts it without network) or shows `GPS err 1`.

`GPS err 1` with both allowed means the phone had no position to give within 30 seconds, which happens on a phone without network location that has not had a GPS fix lately. The watch asks again every 30 seconds.

`tools/test-gravel.sh` runs the app through Gravel without a watch: it attaches the Pebble emulator to a debug build of Gravel on an Android device or emulator (`adb`), installs the `.pbw` through Gravel and reports what the watch shows. `--expect locating` checks the denied state, the default `--expect answer` the allowed one. With both permissions allowed, version 0.4.1 of the original and this app both run in Gravel 0.12.0; the stored roads survive a restart there.

## Build

```
nix-shell                       # pebble.nix pinned with npins (see shell.nix)
pebble sdk install 4.9.169      # once
pebble build                    # -> build/plane-watch.pbw
pebble install --emulator emery
```

## Tests

Each part is tested on its own (see `CONTRACTS.md` for the interfaces):

| part | test | command (inside nix-shell) |
|---|---|---|
| projection, geohash | `test/geo.test.js` | `node tools/run-tests.js geo` |
| road queries, fail-over, stored form | `test/roads.test.js` | `node tools/run-tests.js roads` |
| map rendering | `test/raster.test.js` | `node tools/run-tests.js raster` |
| aircraft, flight paths | `test/planes.test.js` | `node tools/run-tests.js planes` |
| phone⇄watch protocol, send queue | `test/protocol.test.js` | `node tools/run-tests.js protocol` |
| the phone side as a whole (roads and aircraft in every order, failures, storage) | `test/session.test.js` | `node tools/run-tests.js session` |
| same bytes as the original's phone side | `test/parity.test.js` + `test/fixtures/reference-streams.json` | `node tools/run-tests.js parity` |
| PebbleKit JS glue | `test/pkjs-glue.test.js` | `node tools/run-tests.js pkjs-glue` |
| watch state + label placement (host gcc, with sanitizers) | `test/c/test_radar_model.c`, `test/c/test_radar_label.c` | `node tools/run-tests.js c-model` |
| module boundaries, ES5, protocol constants on both sides | `test/modularity.test.js` | `node tools/run-tests.js modularity` |
| same pixels as the original's watch app, in the emulator | `test/screenshots/baseline/` | `tools/screenshots.sh [platform...]` |
| end to end in the emulator (real phone side, canned network) | `tools/test-app-emulator.sh [platform]` | |
| through Gravel (real phone side in Gravel's runtime, live services) | `tools/test-gravel.sh` | needs an adb device with a debug build of Gravel |

`node tools/run-tests.js` runs every `test/*.test.js`. `node tools/smoke-live.js [lat lon] [--zoom MI] [--screen WxH] [--png FILE]` runs the real pipeline against the live services and reports what the watch would get.

### Pixel comparison with the original

`tools/screenshots.sh` builds the app with `src/pkjs/ui-fixture.js` as its phone side: a script of canned messages (no network, no clock) that the watch steps through with SELECT. In the emulator it walks 22 scenes per watch (status texts, the map, selections with flight paths, labels near the edges, phone and watch errors) and compares each screenshot pixel by pixel with `test/screenshots/baseline/` (`tools/lib/png-diff.js`). A run writes `current/`, plus red-on-grey diff images in `diff/` for anything that changed, and fails on the first differing pixel (`--threshold` loosens that).

The baseline is not this app's output. `tools/screenshots.sh --update` records it from the **original's watch binaries**: `tools/reference.py` downloads the original `.pbw` (checksum pinned, kept in `.reference/`, not committed) and repacks its binaries with the same fixture as their phone side, which works because both apps speak the same protocol. Rerun it after changing the fixture's scenes.

The emulator of the round watch stops answering after about twenty screenshots, so the script restarts it every twelve and replays the scenes up to that point.

### Byte comparison with the original's phone side

`node tools/reference-streams.js` runs the original's phone-side JavaScript in a sandbox on the recorded responses in `test/fixtures/` (roads and aircraft around Minneapolis, two flight traces) and records what it sends to the watch: the map bitmap at all four zoom levels on both screens, the aircraft list, flight paths, a refresh. `test/parity.test.js` requires this app to send the same bytes in the same situations. Rerun the script after changing the fixtures.

## Releases

Releases follow deutschebahned's process (`.github/workflows/release.yml`). Each push to the `release` branch builds `plane-watch.pbw` and publishes it as a GitHub release `v<version>` (version from `package.json`), with the asset `plane-watch-v<version>.pbw`. If that release already exists the run stops without building. After a release, the workflow commits a minor version bump to `main` (`tools/bump-version.js`; Pebble only uses major.minor). If `main` was already bumped by hand, it is left alone.

To release: `git push origin-github main:release`.
