"""Build the data file for the night-sky site from the chapters and the curated
constellation list.

The curated file, ``constellations.json``, holds what a person has to decide:
which characters get a constellation, the names that count as a mention of
them, the figure each one draws, the story told about it and the excerpts
quoted from the myth. Everything that can be measured is measured here instead,
straight from ``chapters/``: how often each name is used, in which chapters,
when it first and last appears, and from that its magnitude and its place in
the sky. Every excerpt is checked against its chapter so a quotation can never
drift from the text, and the build stops if one does not match.

    uv run python sky/build_sky.py                 # writes sky/data.js
    uv run python sky/build_sky.py --bundle out.html [--fragment]

``--bundle`` also writes a single self-contained HTML file with the styles,
script, data and fonts inlined; ``--fragment`` leaves out the document wrapper
(doctype, html, head, body) for hosts that add their own.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import random
import re
import sys
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CHAPTERS = ROOT / "chapters"
SOURCE = HERE / "constellations.json"
OUT = HERE / "data.js"

# The sky is laid out on a fixed plane in "sky units"; the page scales it to
# the screen. Chapter 1 sits at the left edge of the usable band and the last
# chapter at the right, so a figure's place across the sky says when it shines.
SKY_W, SKY_H = 2400, 1350
MARGIN_X, MARGIN_TOP, MARGIN_BOTTOM = 150, 150, 120
BIN = 10  # chapters per bar in the per-constellation chart

# Magnitude classes by mention count, brightest first. The radius is the size
# of the figure in sky units; label space is added on top when packing.
MAGNITUDES = [
    # (minimum mentions, magnitude, figure radius, star size of alpha)
    (300, 1, 150, 4.6),
    (140, 2, 118, 3.9),
    (70, 3, 92, 3.3),
    (0, 4, 70, 2.8),
]


def read_chapters() -> dict[int, dict]:
    chapters = {}
    for path in sorted(CHAPTERS.glob("chapter-*.md")):
        text = path.read_text(encoding="utf-8")
        _, front, body = text.split("---", 2)
        number = int(re.search(r"^chapter:\s*(\d+)", front, re.M).group(1))
        title = re.search(r'^title:\s*"(.*)"\s*$', front, re.M).group(1)
        title = re.sub(r"^Chapter \d+:\s*", "", title)
        # Drop the heading line, which repeats the title, and keep the prose.
        body = re.sub(r"^#.*$", "", body, count=1, flags=re.M).strip()
        chapters[number] = {"title": title, "body": body}
    if not chapters:
        sys.exit(f"no chapters found in {CHAPTERS}")
    return chapters


def name_pattern(names: list[str]) -> re.Pattern:
    # Longest first so "First Artist" is tried before "Artist". A name must not
    # run on into more letters, which keeps "Kael" from matching "Kaelen" and
    # "Weaver" from matching "Weavers", while possessives ("Weaver’s") count.
    alternatives = sorted(names, key=len, reverse=True)
    body = "|".join(re.escape(n) for n in alternatives)
    return re.compile(rf"(?<![A-Za-z])(?:{body})(?![A-Za-z])")


def measure(entry: dict, chapters: dict[int, dict]) -> dict:
    pattern = name_pattern(entry["match"])
    # Phrases that contain the name but mean something else ("the Fading
    # Shadow" is not the Fading) are blanked out before counting.
    excluded = [re.compile(re.escape(p)) for p in entry.get("exclude", [])]
    per_chapter = {}
    for number, chapter in chapters.items():
        body = chapter["body"]
        for ex in excluded:
            body = ex.sub(" ", body)
        hits = len(pattern.findall(body))
        if hits:
            per_chapter[number] = hits
    if not per_chapter:
        sys.exit(f"{entry['id']}: none of {entry['match']} occurs in the chapters")
    total = sum(per_chapter.values())
    last_chapter = max(chapters)
    bins = [0] * math.ceil(last_chapter / BIN)
    for number in per_chapter:
        bins[(number - 1) // BIN] += 1
    # Weighted median chapter: where half the mentions have been made.
    running, median = 0, None
    for number in sorted(per_chapter):
        running += per_chapter[number]
        if running * 2 >= total:
            median = number
            break
    return {
        "mentions": total,
        "chapterCount": len(per_chapter),
        "first": min(per_chapter),
        "last": max(per_chapter),
        "median": median,
        "bins": bins,
    }


def normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def check_excerpts(entry: dict, chapters: dict[int, dict]) -> list[str]:
    problems = []
    for excerpt in entry.get("excerpts", []):
        chapter = chapters.get(excerpt["ch"])
        if chapter is None:
            problems.append(f"{entry['id']}: chapter {excerpt['ch']} does not exist")
            continue
        if normalise(excerpt["text"]) not in normalise(chapter["body"]):
            problems.append(
                f"{entry['id']}: excerpt not found verbatim in chapter {excerpt['ch']}: "
                f"{excerpt['text'][:70]}…"
            )
        excerpt["title"] = chapter["title"]
    return problems


def magnitude_for(mentions: int) -> tuple[int, float, float]:
    for minimum, magnitude, radius, alpha in MAGNITUDES:
        if mentions >= minimum:
            return magnitude, radius, alpha
    raise AssertionError("unreachable")


def chapter_x(chapter: float, last_chapter: int) -> float:
    return MARGIN_X + (chapter - 1) / (last_chapter - 1) * (SKY_W - 2 * MARGIN_X)


def build_figure(entry: dict, radius: float, alpha_size: float, rng: random.Random):
    """Turn the authored polylines (on a -10..10 grid) into stars and a path.

    Points that coincide become one star. The alpha star is the one named in
    the entry, or the first point drawn; the rest get seeded magnitudes so the
    figure has the uneven brightness of a real asterism.
    """
    scale = radius / 10.0
    stars: list[list[float]] = []
    index: dict[tuple[float, float], int] = {}

    def star_at(point) -> int:
        key = (float(point[0]), float(point[1]))
        if key not in index:
            index[key] = len(stars)
            stars.append([round(key[0] * scale, 1), round(key[1] * scale, 1)])
        return index[key]

    polylines = [[star_at(p) for p in line] for line in entry["lines"]]
    for extra in entry.get("loose", []):  # stars in the figure but on no line
        star_at(extra)

    alpha_point = entry.get("alpha", entry["lines"][0][0])
    alpha = index[(float(alpha_point[0]), float(alpha_point[1]))]
    sizes = []
    for i in range(len(stars)):
        if i == alpha:
            sizes.append(round(alpha_size, 2))
        else:
            sizes.append(round(alpha_size * rng.uniform(0.38, 0.78), 2))
    return (
        [[x, y, s] for (x, y), s in zip(stars, sizes)],
        polylines,
        alpha,
    )


def place(items: list[dict], last_chapter: int, rng: random.Random) -> None:
    """Pack the figures across the sky, each near the x of its median chapter.

    A simple relaxation: overlapping discs push each other apart (the smaller
    one moves further), every disc is pulled gently back toward its chapter,
    and everything stays inside the plane. It is seeded, so the sky is the same
    on every build.
    """
    for item in items:
        item["_tx"] = chapter_x(item["median"], last_chapter)
        item["_x"] = item["_tx"] + rng.uniform(-20, 20)
        item["_y"] = rng.uniform(MARGIN_TOP + item["_r"], SKY_H - MARGIN_BOTTOM - item["_r"])

    for step in range(900):
        cool = 1.0 - step / 900
        for i, a in enumerate(items):
            for b in items[i + 1:]:
                dx, dy = b["_x"] - a["_x"], b["_y"] - a["_y"]
                dist = math.hypot(dx, dy) or 0.01
                need = a["_r"] + b["_r"] + a["_gap"] + b["_gap"]
                if dist < need:
                    push = (need - dist) * 0.5
                    ux, uy = dx / dist, dy / dist
                    share_a = b["_r"] / (a["_r"] + b["_r"])
                    share_b = 1 - share_a
                    a["_x"] -= ux * push * share_a
                    a["_y"] -= uy * push * share_a
                    b["_x"] += ux * push * share_b
                    b["_y"] += uy * push * share_b
        for item in items:
            item["_x"] += (item["_tx"] - item["_x"]) * 0.03 * cool
            r = item["_r"]
            item["_x"] = min(max(item["_x"], MARGIN_X * 0.5 + r), SKY_W - MARGIN_X * 0.5 - r)
            item["_y"] = min(max(item["_y"], MARGIN_TOP + r), SKY_H - MARGIN_BOTTOM - r)

    for item in items:
        item["x"], item["y"] = round(item["_x"], 1), round(item["_y"], 1)


def build() -> dict:
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    chapters = read_chapters()
    last_chapter = max(chapters)
    word_count = sum(len(c["body"].split()) for c in chapters.values())
    rng = random.Random(1108)

    problems: list[str] = []
    constellations, nebulae = [], []

    for entry in source["constellations"]:
        stats = measure(entry, chapters)
        problems += check_excerpts(entry, chapters)
        magnitude, radius, alpha_size = magnitude_for(stats["mentions"])
        stars, lines, alpha = build_figure(entry, radius, alpha_size, rng)
        constellations.append({
            "id": entry["id"],
            "name": entry["name"],
            "aka": entry.get("aka", ""),
            "magnitude": magnitude,
            "radius": radius,
            "stars": stars,
            "lines": lines,
            "alpha": alpha,
            "desc": entry["desc"],
            "excerpts": entry["excerpts"],
            "related": entry.get("related", []),
            "match": entry["match"],
            **stats,
            "_r": radius,
            "_gap": 38 if magnitude <= 2 else 30,
        })

    for entry in source.get("nebulae", []):
        stats = measure(entry, chapters)
        problems += check_excerpts(entry, chapters)
        nebulae.append({
            "id": entry["id"],
            "name": entry["name"],
            "hue": entry.get("hue", "violet"),
            "desc": entry["desc"],
            "excerpts": entry.get("excerpts", []),
            "related": entry.get("related", []),
            "match": entry["match"],
            **stats,
            "radius": entry.get("radius", 150),
            "_r": entry.get("radius", 150) * 0.45,
            "_gap": 10,
        })

    known = {c["id"] for c in constellations} | {n["id"] for n in nebulae}
    for item in constellations + nebulae:
        for rel in item["related"]:
            if rel not in known:
                problems.append(f"{item['id']}: related id {rel!r} is not in the sky")

    if problems:
        sys.exit("excerpt or link check failed:\n  " + "\n  ".join(problems))

    place(constellations + nebulae, last_chapter, rng)
    for item in constellations + nebulae:
        for key in [k for k in item if k.startswith("_")]:
            del item[key]

    constellations.sort(key=lambda c: -c["mentions"])
    nebulae.sort(key=lambda n: -n["mentions"])
    return {
        "sky": {"width": SKY_W, "height": SKY_H, "marginX": MARGIN_X},
        "corpus": {
            "chapters": last_chapter,
            "words": word_count,
            "bin": BIN,
        },
        "constellations": constellations,
        "nebulae": nebulae,
    }


def write_data(data: dict) -> str:
    # "</" is escaped so the data can also sit inside an inline <script>.
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    script = (
        "// Generated by sky/build_sky.py from chapters/ and sky/constellations.json.\n"
        "// Do not edit by hand; edit the JSON and rebuild.\n"
        f"window.SKY = {payload};\n"
    )
    OUT.write_text(script, encoding="utf-8")
    return script


FONT_TYPES = {".otf": "font/otf", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2"}


def inline_fonts(css: str) -> str:
    """Replace each url("../fonts/...") in the stylesheet with a data URI."""
    def embed(match: re.Match) -> str:
        path = (HERE / urllib.parse.unquote(match.group(1))).resolve()
        mime = FONT_TYPES[path.suffix.lower()]
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        return f'url("data:{mime};base64,{data}")'
    return re.sub(r'url\("(\.\./fonts/[^"]+)"\)', embed, css)


def bundle(out: Path, data_script: str, fragment: bool) -> None:
    html = (HERE / "index.html").read_text(encoding="utf-8")
    css = inline_fonts((HERE / "sky.css").read_text(encoding="utf-8"))
    js = (HERE / "sky.js").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="sky.css">', f"<style>\n{css}\n</style>")
    html = html.replace('<script src="data.js"></script>', f"<script>\n{data_script}</script>")
    html = html.replace('<script src="sky.js"></script>', f"<script>\n{js}\n</script>")
    if fragment:
        html = re.sub(r"<!doctype html>\s*", "", html, flags=re.I)
        html = re.sub(r"</?(html|body)[^>]*>\s*", "", html)
        html = re.sub(r"</?head>\s*", "", html)
        html = re.sub(r'<meta charset="[^"]*">\s*', "", html)
        html = re.sub(r'<meta name="viewport"[^>]*>\s*', "", html)
    out.write_text(html, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--bundle", type=Path, help="also write a single-file HTML here")
    parser.add_argument("--fragment", action="store_true",
                        help="leave out doctype/html/head/body in the bundle")
    args = parser.parse_args()

    data = build()
    script = write_data(data)
    for c in data["constellations"]:
        print(f"  mag {c['magnitude']}  {c['mentions']:5d} mentions  {c['chapterCount']:4d} ch"
              f"  {c['first']:4d}–{c['last']:<4d}  {c['name']}")
    for n in data["nebulae"]:
        print(f"  nebula  {n['mentions']:5d} mentions  {n['chapterCount']:4d} ch  {n['name']}")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(script) / 1024:.0f} KB), "
          f"{len(data['constellations'])} constellations, {len(data['nebulae'])} nebulae")
    if args.bundle:
        bundle(args.bundle, script, args.fragment)
        print(f"wrote {args.bundle}")


if __name__ == "__main__":
    main()
