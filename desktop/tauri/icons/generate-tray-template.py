from math import hypot
from pathlib import Path
from struct import pack
from zlib import compress, crc32


STROKE_RADIUS = 0.75
LETTER = [(5.5, 12.25), (5.5, 5.75), (9, 10), (12.5, 5.75), (12.5, 12.25)]


def distance_to_segment(x, y, start, end):
    ax, ay = start
    dx, dy = end[0] - ax, end[1] - ay
    t = min(1, max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return hypot(x - ax - t * dx, y - ay - t * dy)


def ink(x, y):
    # Signed distance to the centerline of the rounded square.
    dx, dy = abs(x - 9) - 4.25, abs(y - 9) - 4.25
    outline = hypot(max(0, dx), max(0, dy)) + min(0, max(dx, dy)) - 3
    return abs(outline) <= STROKE_RADIUS or any(
        distance_to_segment(x, y, start, end) <= STROKE_RADIUS
        for start, end in zip(LETTER, LETTER[1:])
    )


def chunk(kind, data):
    return pack(">I", len(data)) + kind + data + pack(">I", crc32(kind + data))


def render(scale):
    size = 18 * scale
    samples = 8
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            covered = sum(
                ink((x + (sx + 0.5) / samples) / scale, (y + (sy + 0.5) / samples) / scale)
                for sy in range(samples) for sx in range(samples)
            )
            rows.extend((0, 0, 0, round(255 * covered / (samples * samples))))
    assert rows[4] == 0 and 255 in rows
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", compress(rows, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    directory = Path(__file__).resolve().parent
    (directory / "tray-template.png").write_bytes(render(1))
    (directory / "tray-template@2x.png").write_bytes(render(2))
