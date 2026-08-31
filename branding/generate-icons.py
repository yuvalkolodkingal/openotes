#!/usr/bin/env python3
# This file is part of the Notesnook project (https://notesnook.com/)
#
# Copyright (C) 2026 Openotes contributors
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

"""
Regenerates every raster icon in the tree from the single source of truth,
branding/openotes-mark.svg. Run from the repository root:

    pip install cairosvg
    python3 branding/generate-icons.py

The SVG is the master; the PNG/ICO/ICNS files it produces are committed so a
build needs no rasterizer, but they are derived — never hand-edit them, edit
the SVG and re-run this.
"""

import io
import os
import struct

import cairosvg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARK = os.path.join(ROOT, "branding", "openotes-mark.svg")
LOCKUP = os.path.join(ROOT, "branding", "openotes-lockup.svg")
ICONS = os.path.join(ROOT, "apps", "desktop", "assets", "icons")
PUB = os.path.join(ROOT, "apps", "web", "public")


def render(svg, size):
    return cairosvg.svg2png(url=svg, output_width=size, output_height=size)


def write(path, data):
    with open(path, "wb") as handle:
        handle.write(data)
    print("wrote", os.path.relpath(path, ROOT))


def make_ico(path, sizes):
    frames = [(s, render(MARK, s)) for s in sizes]
    out = io.BytesIO()
    out.write(struct.pack("<HHH", 0, 1, len(frames)))
    offset = 6 + len(frames) * 16
    for size, data in frames:
        dim = 0 if size >= 256 else size  # 0 means 256 in the ICO header
        out.write(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    for _, data in frames:
        out.write(data)
    write(path, out.getvalue())


def make_icns(path, mapping):
    body = b""
    for ostype, size in mapping:
        data = render(MARK, size)
        body += ostype.encode("ascii") + struct.pack(">I", len(data) + 8) + data
    write(path, b"icns" + struct.pack(">I", len(body) + 8) + body)


def main():
    for size in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
        write(os.path.join(ICONS, f"{size}x{size}.png"), render(MARK, size))

    make_ico(os.path.join(ICONS, "app.ico"), (16, 24, 32, 48, 64, 128, 256))
    make_icns(
        os.path.join(ICONS, "app.icns"),
        [
            ("icp4", 16), ("icp5", 32), ("icp6", 64),
            ("ic07", 128), ("ic08", 256), ("ic09", 512), ("ic10", 1024),
            ("ic11", 32), ("ic12", 64), ("ic13", 256), ("ic14", 512),
        ],
    )

    write(os.path.join(PUB, "favicon.png"), render(MARK, 48))
    with open(MARK, "rb") as handle:
        write(os.path.join(PUB, "favicon.svg"), handle.read())
    write(os.path.join(PUB, "apple-touch-icon.png"), render(MARK, 180))
    for name, size in (
        ("android-chrome-192x192.png", 192),
        ("android-chrome-512x512.png", 512),
        ("android-chrome-maskable-192x192.png", 192),
        ("android-chrome-maskable-512x512.png", 512),
    ):
        write(os.path.join(PUB, name), render(MARK, size))

    write(os.path.join(ROOT, "branding", "openotes-lockup.png"),
          cairosvg.svg2png(url=LOCKUP, output_width=720, output_height=200))


if __name__ == "__main__":
    main()
