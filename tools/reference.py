#!/usr/bin/env python3
"""The original Flight Radar (the app this one reproduces), for recording reference data.

  tools/reference.py fetch                      download the original .pbw into .reference/ (checksum pinned)
  tools/reference.py repack FIXTURE.js OUT.pbw  the original's watch binaries with FIXTURE.js as its phone side
  tools/reference.py pkjs OUT.js                the original's phone-side JavaScript

The original is not part of this repository. tools/screenshots.sh --update drives its watch binaries with
src/pkjs/ui-fixture.js to record test/screenshots/baseline/, and tools/reference-streams.js runs its phone-side
code against test/fixtures/ to record test/fixtures/reference-streams.json.
"""
import hashlib
import os
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PBW = os.path.join(ROOT, '.reference', 'flight-radar-0.4.1.pbw')
URL = ('https://appstore-api.repebble.com/api/assets/pbw/fc84423d0b15457a94f47085/0.4.1/'
       'f7e187b0-1847-4f6f-877d-4e15979bc8c8.pbw')
SHA256 = '08fb46b3193d1759d59d7400783c05aaaa366795809ade3625f860c4f895930a'
JS_NAME = 'pebble-js-app.js'


def digest(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def fetch():
    if not os.path.exists(PBW):
        os.makedirs(os.path.dirname(PBW), exist_ok=True)
        print('downloading', URL)
        with urllib.request.urlopen(URL, timeout=60) as response, open(PBW + '.part', 'wb') as out:
            out.write(response.read())
        os.replace(PBW + '.part', PBW)
    if digest(PBW) != SHA256:
        sys.exit('%s is not version 0.4.1 of the original (sha256 %s)' % (PBW, digest(PBW)))
    print(PBW)


def repack(fixture, out):
    """Every entry of the original except its JavaScript (and source map), plus the fixture as pebble-js-app.js."""
    fetch()
    with zipfile.ZipFile(PBW) as src, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            if not info.filename.startswith(JS_NAME):
                dst.writestr(info.filename, src.read(info.filename))
        dst.write(fixture, JS_NAME)


def pkjs(out):
    fetch()
    with zipfile.ZipFile(PBW) as src, open(out, 'wb') as f:
        f.write(src.read(JS_NAME))


def main(argv):
    if argv[1:] == ['fetch']:
        fetch()
    elif len(argv) == 4 and argv[1] == 'repack':
        repack(argv[2], argv[3])
    elif len(argv) == 3 and argv[1] == 'pkjs':
        pkjs(argv[2])
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
