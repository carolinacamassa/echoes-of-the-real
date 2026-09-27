#!/usr/bin/env python3
"""Scrape 'Echoes of the Real: Cosmos' from GitLab Pages and assemble an EPUB 3.

Phase 1 caches every chapter's HTML under cache/ so re-runs are offline and cheap.
Phase 2 parses each page into well-formed XHTML and zips up the EPUB.

Usage:  uv run python build_epub.py [--refresh] [--limit N]
"""

from __future__ import annotations

import argparse
import html
import html.entities
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

BASE = "https://echoes-cosmos-fecd9f.gitlab.io/"
ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache"
OUT = ROOT / "Echoes of the Real - Cosmos.epub"
MD_DIR = ROOT / "chapters"
UA = "Mozilla/5.0 (compatible; personal-epub-builder/1.0)"
WORKERS = 8

XHTML_NS = "http://www.w3.org/1999/xhtml"
VOID = ("br", "hr", "img", "col", "area", "base", "input", "link", "meta", "source", "wbr")


# --------------------------------------------------------------------------- fetch


def fetch(url: str, tries: int = 4) -> str:
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {last}")


def cached(name: str, refresh: bool = False) -> str:
    path = CACHE / name
    if path.exists() and not refresh and path.stat().st_size > 0:
        return path.read_text(encoding="utf-8")
    text = fetch(BASE + name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")
    return text


# --------------------------------------------------------------------------- parse

TOC_RE = re.compile(
    r'<li><span class="n">(\d+)</span><a href="(chapter-\d+\.html)">(.*?)</a></li>'
)
TITLE_RE = re.compile(r'<h1 class="title">(.*?)</h1>', re.S)
META_RE = re.compile(r'<div class="meta">(.*?)</div>', re.S)
BODY_RE = re.compile(r'<div class="meta">.*?</div>(.*?)<nav class="chap">', re.S)
NAMED_ENT_RE = re.compile(r"&([A-Za-z][A-Za-z0-9]{1,31});")
VOID_RE = re.compile(r"<(" + "|".join(VOID) + r")\b([^>]*?)/?>", re.I)


def keep_xml_entities(match: re.Match[str]) -> str:
    """Turn HTML named entities into literal characters; XML only predefines five."""
    name = match.group(1)
    if name in ("amp", "lt", "gt", "quot", "apos"):
        return match.group(0)
    char = html.entities.html5.get(name + ";")
    return char if char else match.group(0)


def to_xhtml_fragment(raw: str) -> tuple[str, bool]:
    """Return (well-formed XHTML fragment, used_fallback)."""
    frag = NAMED_ENT_RE.sub(keep_xml_entities, raw)
    frag = VOID_RE.sub(lambda m: f"<{m.group(1).lower()}{m.group(2)}/>", frag)
    try:
        node = ET.fromstring(f"<div xmlns='{XHTML_NS}'>{frag}</div>")
    except ET.ParseError:
        # Last resort: strip every tag and rebuild as plain paragraphs.
        chunks = re.split(r"</p\s*>", raw, flags=re.I)
        paras = []
        for chunk in chunks:
            text = html.unescape(re.sub(r"<[^>]+>", "", chunk)).strip()
            if text:
                paras.append(f"<p>{escape(text)}</p>")
        return "\n".join(paras), True
    out = []
    for child in node:
        out.append(ET.tostring(child, encoding="unicode"))
    body = "".join(out).replace(f' xmlns="{XHTML_NS}"', "").replace(f"{{{XHTML_NS}}}", "")
    return body.strip(), False


def clean_title(raw: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", raw)).strip()


# --------------------------------------------------------------------------- markdown

BR = "\x00br\x00"


def inline_md(node: ET.Element) -> str:
    """Render one element's children as Markdown inline text (excluding its tail)."""
    parts = [node.text or ""]
    for child in node:
        tag = child.tag.rsplit("}", 1)[-1].lower()
        inner = inline_md(child)
        if tag in ("em", "i", "cite") and inner.strip():
            parts.append(f"*{inner}*")
        elif tag in ("strong", "b") and inner.strip():
            parts.append(f"**{inner}**")
        elif tag == "br":
            parts.append(BR)
        else:
            parts.append(inner)
        parts.append(child.tail or "")
    return "".join(parts)


def markdown_body(fragment: str) -> str:
    """Convert a well-formed XHTML chapter fragment into Markdown blocks."""
    root = ET.fromstring(f"<div>{fragment}</div>")
    blocks = []
    for el in root:
        tag = el.tag.rsplit("}", 1)[-1].lower()
        if tag == "hr":
            blocks.append("---")
            continue
        # Collapse runs of whitespace, then restore hard line breaks.
        text = re.sub(r"\s+", " ", inline_md(el)).strip()
        text = text.replace(f" {BR} ", BR).replace(BR, "  \n")
        if not text:
            continue
        if re.fullmatch(r"h[1-6]", tag):
            blocks.append("#" * min(6, int(tag[1]) + 1) + f" {text}")
        elif tag == "blockquote":
            blocks.append("\n".join("> " + ln for ln in text.split("\n")))
        elif tag in ("ul", "ol"):
            marker = "- " if tag == "ul" else "1. "
            items = [inline_md(li).strip() for li in el]
            blocks.append("\n".join(marker + re.sub(r"\s+", " ", i) for i in items if i))
        else:
            blocks.append(text)
    return "\n\n".join(blocks)


def yaml_scalar(value: str) -> str:
    """Double-quote a YAML scalar; chapter titles routinely contain colons."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def write_markdown(chapters: list[dict], out_dir: Path) -> tuple[int, list[str]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    width = max(3, len(str(max(c["num"] for c in chapters))))
    expected = set()
    for ch in chapters:
        name = f"chapter-{ch['num']:0{width}d}.md"
        expected.add(name)
        doc = (
            "---\n"
            f"title: {yaml_scalar(ch['title'])}\n"
            f"chapter: {ch['num']}\n"
            "---\n\n"
            f"# {ch['title']}\n\n"
            f"{markdown_body(ch['body'])}\n"
        )
        (out_dir / name).write_text(doc, encoding="utf-8", newline="\n")
    stale = sorted(p.name for p in out_dir.glob("*.md") if p.name not in expected)
    return len(expected), stale


# --------------------------------------------------------------------------- epub


def xhtml_page(title: str, body: str, css: str = "style.css") -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        f'<html xmlns="{XHTML_NS}" xml:lang="en" lang="en">\n'
        f"<head><meta charset=\"utf-8\"/><title>{escape(title)}</title>"
        f'<link rel="stylesheet" type="text/css" href="{css}"/></head>\n'
        f"<body>\n{body}\n</body>\n</html>\n"
    )


CSS = """@namespace "http://www.w3.org/1999/xhtml";
body { margin: 0 6%; font-family: Georgia, "Times New Roman", serif;
       line-height: 1.5; text-align: justify; hyphens: auto; }
h1.title { font-size: 1.35em; line-height: 1.3; text-align: left;
           margin: 1.4em 0 0.2em; font-weight: 700; page-break-before: always; }
p.meta { font-size: 0.72em; letter-spacing: 0.12em; text-transform: uppercase;
         color: #666; text-align: left; margin: 0 0 1.6em; font-family: sans-serif; }
p { margin: 0 0 0.85em; text-indent: 0; }
em { font-style: italic; }
.titlepage { text-align: center; margin-top: 22%; }
.titlepage h1 { font-size: 2em; margin: 0.4em 0 0.2em; line-height: 1.2; }
.titlepage .kicker { font-family: sans-serif; font-size: 0.75em;
                     letter-spacing: 0.24em; text-transform: uppercase; color: #666; }
.titlepage .by { font-style: italic; color: #444; margin-top: 0.6em; }
.titlepage .note { font-size: 0.78em; color: #777; margin-top: 3em; }
nav#toc ol { list-style: none; padding-left: 0; }
nav#toc li { margin: 0.25em 0; }
"""

COVER_SVG = """<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1800"
     viewBox="0 0 1200 1800" preserveAspectRatio="xMidYMid meet">
  <defs>
    <radialGradient id="g" cx="62%" cy="14%" r="95%">
      <stop offset="0%" stop-color="#1b2450"/>
      <stop offset="55%" stop-color="#0a0e22"/>
      <stop offset="100%" stop-color="#05060d"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="1800" fill="url(#g)"/>
  {stars}
  <circle cx="600" cy="760" r="196" fill="none" stroke="#7fb0ff"
          stroke-opacity="0.75" stroke-width="2"/>
  <circle cx="600" cy="760" r="262" fill="none" stroke="#7fb0ff"
          stroke-opacity="0.42" stroke-width="1.5"/>
  <circle cx="600" cy="760" r="330" fill="none" stroke="#7fb0ff"
          stroke-opacity="0.2" stroke-width="1"/>
  <circle cx="600" cy="760" r="15" fill="#e8ecff"/>
  <text x="600" y="1400" text-anchor="middle" fill="#e8ecff"
        font-family="Georgia, serif" font-size="92">Echoes of the Real</text>
  <text x="600" y="1500" text-anchor="middle" fill="#e8ecff"
        font-family="Georgia, serif" font-size="92">Cosmos</text>
  {subtitle}
  <text x="600" y="{author_y}" text-anchor="middle" fill="#9aa3d0"
        font-family="Georgia, serif" font-size="40"
        font-style="italic">Unknown author</text>
</svg>
"""


def starfield(seed: int = 7, count: int = 150) -> str:
    """Deterministic pseudo-random stars, so rebuilds are byte-identical."""
    state = seed
    out = []
    for _ in range(count):
        state = (1103515245 * state + 12345) % (2**31)
        x = state % 1200
        state = (1103515245 * state + 12345) % (2**31)
        y = state % 1800
        state = (1103515245 * state + 12345) % (2**31)
        r = 0.8 + (state % 100) / 55.0
        state = (1103515245 * state + 12345) % (2**31)
        o = 0.15 + (state % 100) / 160.0
        out.append(
            f'<circle cx="{x}" cy="{y}" r="{r:.2f}" fill="#ffffff" '
            f'fill-opacity="{o:.2f}"/>'
        )
    return "\n  ".join(out)


def build(
    chapters: list[dict],
    book_title: str,
    author: str,
    out: Path,
    subtitle: str = '',
) -> None:
    book_id = "urn:uuid:" + str(
        uuid.uuid5(uuid.NAMESPACE_DNS, "echoes-of-the-real-cosmos::" + book_title)
    )
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    manifest = [
        '<item id="css" href="style.css" media-type="text/css"/>',
        '<item id="cover-image" href="cover.svg" media-type="image/svg+xml" '
        'properties="cover-image"/>',
        '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" '
        'properties="nav"/>',
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    ]
    spine = ['<itemref idref="cover"/>', '<itemref idref="titlepage"/>',
             '<itemref idref="nav"/>']
    nav_items, ncx_points = [], []

    for i, ch in enumerate(chapters, start=1):
        cid = f"ch{ch['num']:04d}"
        href = f"{cid}.xhtml"
        manifest.append(
            f'<item id="{cid}" href="{href}" media-type="application/xhtml+xml"/>'
        )
        spine.append(f'<itemref idref="{cid}"/>')
        label = escape(ch["title"])
        nav_items.append(f'<li><a href="{href}">{label}</a></li>')
        ncx_points.append(
            f'<navPoint id="np{i}" playOrder="{i}">'
            f"<navLabel><text>{label}</text></navLabel>"
            f'<content src="{href}"/></navPoint>'
        )

    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"
         unique-identifier="bookid" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">{book_id}</dc:identifier>
    <dc:title>{escape(book_title)}</dc:title>
    <dc:creator id="author">{escape(author)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">{stamp}</meta>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    {chr(10).join("    " + m for m in manifest).strip()}
  </manifest>
  <spine toc="ncx">
    {chr(10).join("    " + s for s in spine).strip()}
  </spine>
</package>
"""

    nav = xhtml_page(
        "Contents",
        '<nav epub:type="toc" id="toc" xmlns:epub="http://www.idpf.org/2007/ops">\n'
        "<h1>Contents</h1>\n<ol>\n" + "\n".join(nav_items) + "\n</ol>\n</nav>",
    )

    ncx = f"""<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="{book_id}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>{escape(book_title)}</text></docTitle>
  <navMap>
    {chr(10).join("    " + p for p in ncx_points).strip()}
  </navMap>
</ncx>
"""

    titlepage = xhtml_page(
        book_title,
        '<div class="titlepage">\n'
        f"<h1>{escape(book_title)}</h1>\n"
        f'<p class="by">{escape(author)}</p>\n'
        f'<p class="note">{len(chapters)} chapters</p>\n'
        "</div>",
    )

    cover_page = xhtml_page(
        "Cover",
        '<div style="margin:0;padding:0;text-align:center">'
        '<img src="cover.svg" alt="Cover" style="max-width:100%;height:auto"/></div>',
    )

    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w") as z:
        # The mimetype entry must be first and stored uncompressed.
        z.writestr(
            zipfile.ZipInfo("mimetype"),
            "application/epub+zip",
            compress_type=zipfile.ZIP_STORED,
        )
        add = lambda name, data: z.writestr(name, data, zipfile.ZIP_DEFLATED)
        add(
            "META-INF/container.xml",
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<container version="1.0" '
            'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
            "  <rootfiles><rootfile full-path=\"OEBPS/content.opf\" "
            'media-type="application/oebps-package+xml"/></rootfiles>\n'
            "</container>\n",
        )
        add("OEBPS/content.opf", opf)
        add("OEBPS/nav.xhtml", nav)
        add("OEBPS/toc.ncx", ncx)
        add("OEBPS/style.css", CSS)
        sub_svg = (
            f'<text x="600" y="1588" text-anchor="middle" fill="#7fb0ff" '
            f'font-family="Georgia, serif" font-size="44">{escape(subtitle)}</text>'
            if subtitle
            else ''
        )
        cover_svg = (
            COVER_SVG.replace("{stars}", starfield())
            .replace("{subtitle}", sub_svg)
            .replace("{author_y}", "1688" if subtitle else "1610")
        )
        add("OEBPS/cover.svg", cover_svg)
        add("OEBPS/cover.xhtml", cover_page)
        add("OEBPS/titlepage.xhtml", titlepage)
        for ch in chapters:
            body = (
                f"<h1 class=\"title\">{escape(ch['title'])}</h1>\n"
                f"<p class=\"meta\">{escape(ch['meta'])}</p>\n"
                f"{ch['body']}"
            )
            add(f"OEBPS/ch{ch['num']:04d}.xhtml", xhtml_page(ch["title"], body))


# --------------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="ignore the cache")
    ap.add_argument("--limit", type=int, default=0, help="only build N chapters")
    ap.add_argument("--out", type=Path, default=None, help="output .epub path")
    ap.add_argument(
        "--md",
        type=Path,
        nargs="?",
        const=MD_DIR,
        default=None,
        help=f"also write one .md per chapter (default dir: {MD_DIR.name}/)",
    )
    ap.add_argument("--skip-epub", action="store_true", help="only write the Markdown")
    args = ap.parse_args()

    print("fetching index...", flush=True)
    index = cached("index.html", refresh=args.refresh)
    entries = [
        {"num": int(n), "file": f, "toc_title": clean_title(t)}
        for n, f, t in TOC_RE.findall(index)
    ]
    entries.sort(key=lambda e: e["num"])
    if not entries:
        print("no chapters found in the table of contents", file=sys.stderr)
        return 1
    if args.limit:
        entries = entries[: args.limit]
    print(f"{len(entries)} chapters listed (1..{entries[-1]['num']})", flush=True)

    missing = [e["num"] for e in entries if e["num"] != entries[0]["num"] + entries.index(e)]
    if missing:
        print(f"warning: chapter numbering is not contiguous near {missing[:5]}")

    done = [0]

    def grab(entry: dict) -> tuple[dict, str]:
        page = cached(entry["file"], refresh=args.refresh)
        done[0] += 1
        if done[0] % 100 == 0:
            print(f"  {done[0]}/{len(entries)}", flush=True)
        return entry, page

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        pages = list(pool.map(grab, entries))

    chapters, fallbacks, empties = [], [], []
    for entry, page in pages:
        tm = TITLE_RE.search(page)
        title = clean_title(tm.group(1)) if tm else entry["toc_title"]
        mm = META_RE.search(page)
        meta = clean_title(mm.group(1)) if mm else f"Chapter {entry['num']}"
        bm = BODY_RE.search(page)
        if not bm:
            empties.append(entry["num"])
            body = "<p/>"
            used_fallback = False
        else:
            body, used_fallback = to_xhtml_fragment(bm.group(1))
            if not body.strip():
                empties.append(entry["num"])
                body = "<p/>"
        if used_fallback:
            fallbacks.append(entry["num"])
        chapters.append(
            {"num": entry["num"], "title": title, "meta": meta, "body": body}
        )

    words = sum(
        len(re.sub(r"<[^>]+>", " ", c["body"]).split()) for c in chapters
    )
    print(f"parsed {len(chapters)} chapters, ~{words:,} words")
    if fallbacks:
        print(f"  {len(fallbacks)} needed the plain-text fallback: {fallbacks[:10]}")
    if empties:
        print(f"  {len(empties)} came out empty: {empties[:10]}")

    author = "Unknown author"
    tm = re.search(r"<title>(.*?)</title>", index, re.S)
    book_title = clean_title(tm.group(1)) if tm else "Echoes of the Real: Cosmos"

    subtitle = ''
    out = args.out or OUT
    if args.limit:
        first, last = chapters[0]['num'], chapters[-1]['num']
        subtitle = f'Chapters {first}\u2013{last}'
        book_title = f'{book_title} ({subtitle})'
        if not args.out:
            out = OUT.with_name(
                f'{OUT.stem} (Chapters {first}-{last}){OUT.suffix}'
            )

    if not args.skip_epub:
        build(chapters, book_title, author, out, subtitle)
        size = out.stat().st_size
        print(f"wrote {out.name} ({size/1024/1024:.2f} MB)")

    if args.md is not None:
        count, stale = write_markdown(chapters, args.md)
        print(f"wrote {count} Markdown files to {args.md.name}/")
        if stale:
            print(f"  note: {len(stale)} pre-existing .md file(s) not part of this run, "
                  f"e.g. {stale[:3]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
