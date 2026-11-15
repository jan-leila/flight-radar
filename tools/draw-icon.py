#!/usr/bin/env python3
"""Draws resources/images/menu-icon.png: a 25x25 miniature of the watch screen (roads, you in the middle, aircraft
in their altitude colours, one selected). Run from the repo root: nix-shell -p python3Packages.pillow --run
'python3 tools/draw-icon.py'."""
from PIL import Image

W = 25
K = (0, 0, 0, 255)
G = (85, 85, 85, 255)       # roads
Y = (255, 255, 0, 255)      # you
O = (255, 170, 0, 255)      # below 12,000 ft
R = (255, 0, 0, 255)        # up to 28,000 ft
B = (0, 170, 255, 255)      # above
S = (0, 255, 0, 255)        # selected
Wh = (255, 255, 255, 255)
T = (0, 0, 0, 0)

# an aircraft seen from above, flying up the screen
PLANE = ["..#..",
         "..#..",
         "#####",
         "..#..",
         ".###."]


def build():
    im = Image.new('RGBA', (W, W), K)

    def px(x, y, col):
        if 0 <= x < W and 0 <= y < W:
            im.putpixel((x, y), col)

    def glyph(x0, y0, rows, col, turns=0):
        n = len(rows)
        for dy, r in enumerate(rows):
            for dx, ch in enumerate(r):
                if ch != '#':
                    continue
                x, y = dx, dy
                for _ in range(turns):          # quarter turns clockwise
                    x, y = n - 1 - y, x
                px(x0 + x, y0 + y, col)

    # two roads crossing near the middle
    for i in range(W):
        px(i, 15 - i // 4, G)
        px(9 + i // 3, i, G)
    # you
    for x, y in [(12, 12), (13, 12), (12, 13), (13, 13)]:
        px(x, y, Y)
    # aircraft
    glyph(3, 3, PLANE, O, 1)
    glyph(16, 2, PLANE, B)
    glyph(17, 16, PLANE, R, 2)
    glyph(3, 16, PLANE, S, 3)
    # the selected aircraft's path
    for x, y in [(9, 18), (10, 18), (12, 18), (13, 18)]:
        px(x, y, S)
    # bezel with rounded corners
    for i in range(W):
        for p in [(i, 0), (i, W - 1), (0, i), (W - 1, i)]:
            px(*p, Wh)
    for p in [(0, 0), (W - 1, 0), (0, W - 1), (W - 1, W - 1)]:
        im.putpixel(p, T)
    return im


build().save('resources/images/menu-icon.png')
