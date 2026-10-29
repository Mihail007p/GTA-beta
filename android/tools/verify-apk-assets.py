#!/usr/bin/env python3
"""Check that the release APK contains exactly the current runtime game files."""
import hashlib
import re
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[2] / 'game'
files = [root / name for name in ('index.html', 'manifest.json', 'sw.js', 'README.md', 'ASSET-CREDITS.md')]
for folder in ('css', 'js', 'icons', 'vendor', 'assets'):
    files.extend(p for p in (root / folder).rglob('*') if p.is_file())

with zipfile.ZipFile(sys.argv[1]) as apk:
    names = apk.namelist()
    if len(set(names)) != len(names):
        raise SystemExit('Duplicate ZIP entries')
    expected = {'assets/game/' + f.relative_to(root).as_posix() for f in files}
    actual = {n for n in names if n.startswith('assets/game/') and not n.endswith('/')}
    unexpected = actual - expected
    if unexpected:
        raise SystemExit('Unexpected game assets: ' + ', '.join(sorted(unexpected)))
    for f in files:
        entry = 'assets/game/' + f.relative_to(root).as_posix()
        if entry not in names:
            raise SystemExit('Missing ' + entry)
        if hashlib.sha256(apk.read(entry)).digest() != hashlib.sha256(f.read_bytes()).digest():
            raise SystemExit('Contents differ: ' + entry)
    cached = re.findall(r"'\./([^']+)'", (root / 'sw.js').read_text(encoding='utf-8'))
    for path in cached:
        if 'assets/game/' + path not in names:
            raise SystemExit('Service worker references a missing file: ' + path)
    for n in names:
        lower = n.lower()
        if n.startswith('assets/game/tests/') or n.startswith('assets/game/tools/') or lower.endswith(('.p12', '.jks', '.keystore')):
            raise SystemExit('Unexpected file: ' + n)
    if 'classes.dex' not in names or 'AndroidManifest.xml' not in names:
        raise SystemExit('Missing DEX or Android manifest')
    print(f'APK: {len(files)} game files match byte-for-byte; {len(cached)} cache paths exist; no tests or private keys')
