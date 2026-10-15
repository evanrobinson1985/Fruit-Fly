"""Store arbitrary bytes as a valid 8-bit grayscale PNG.

Static hosts that only serve web media types still serve PNG. Each row is
filter type 0 (None), so the browser recovers the exact bytes by inflating
the IDAT stream (see web/src/pngdata.js); no canvas or color management is
involved. The PNG's zlib stream also does the compression.
"""
from __future__ import annotations

import struct
import zlib

WIDTH = 4096


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def encode(data: bytes, level: int = 9) -> bytes:
    height = max(1, -(-len(data) // WIDTH))
    padded = data + b"\0" * (height * WIDTH - len(data))
    rows = b"".join(b"\0" + padded[r * WIDTH:(r + 1) * WIDTH] for r in range(height))
    ihdr = struct.pack(">IIBBBBB", WIDTH, height, 8, 0, 0, 0, 0)  # 8-bit grayscale
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(rows, level)) + _chunk(b"IEND", b"")


def decode(png: bytes) -> bytes:
    """Inverse of encode() (padding included), for tests."""
    pos, idat, width = 8, b"", None
    while pos < len(png):
        n, kind = struct.unpack(">I4s", png[pos:pos + 8])
        body = png[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            width = struct.unpack(">I", body[:4])[0]
        elif kind == b"IDAT":
            idat += body
        pos += 12 + n
    raw = zlib.decompress(idat)
    return b"".join(raw[r * (width + 1) + 1:(r + 1) * (width + 1)] for r in range(len(raw) // (width + 1)))
