#!/usr/bin/env python3
"""Append classes.dex and align every ZIP_STORED entry before APK signing.

Android zipalign pads local-header extra fields; only uncompressed data needs
4-byte alignment. No native libraries are packaged by this app. Use the SDK's
zipalign when available; this small fallback keeps the minimal build portable.
"""
import copy
import struct
import sys
import zipfile
from pathlib import Path


def add_aligned(zout, info, data):
    info = copy.copy(info)
    if info.compress_type == zipfile.ZIP_STORED:
        name, _ = info._encodeFilenameFlags()
        start = zout.fp.tell() + 30 + len(name) + len(info.extra)
        padding = (-start) % 4
        if padding:
            # Complete extra-field header + padding. The header itself is 4 bytes.
            info.extra += struct.pack('<HH', 0xA11E, padding) + bytes(padding)
    zout.writestr(info, data)


def build(source, dex, destination):
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(destination, 'w', allowZip64=False) as zout:
        names = set()
        for info in zin.infolist():
            if info.filename in names or info.filename == 'classes.dex':
                raise ValueError('duplicate or unexpected ZIP entry: ' + info.filename)
            names.add(info.filename)
            add_aligned(zout, info, zin.read(info))
        info = zipfile.ZipInfo('classes.dex', date_time=(2020, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_STORED
        info.external_attr = 0o644 << 16
        add_aligned(zout, info, Path(dex).read_bytes())
    verify(destination)


def verify(path):
    with zipfile.ZipFile(path) as z, open(path, 'rb') as raw:
        bad_crc = z.testzip()
        if bad_crc:
            raise ValueError('bad CRC: ' + bad_crc)
        for info in z.infolist():
            if info.compress_type != zipfile.ZIP_STORED:
                continue
            raw.seek(info.header_offset)
            header = raw.read(30)
            if len(header) != 30 or header[:4] != b'PK\x03\x04':
                raise ValueError('bad local header: ' + info.filename)
            name_len, extra_len = struct.unpack_from('<HH', header, 26)
            offset = info.header_offset + 30 + name_len + extra_len
            if offset % 4:
                raise ValueError('unaligned entry: %s at %d' % (info.filename, offset))
    print('ZIP: CRC OK; all uncompressed entries are 4-byte aligned')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--check':
        verify(sys.argv[2])
    elif len(sys.argv) == 4:
        build(*sys.argv[1:])
    else:
        raise SystemExit('Usage: align-apk.py resources.apk classes.dex aligned.apk | --check APK')
