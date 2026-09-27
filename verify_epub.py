#!/usr/bin/env python3
"""Validate the built EPUB and report its size in words and tokens.

Checks the container/mimetype conventions, parses every XHTML file as XML,
confirms each manifest href exists and every spine idref resolves, then
tokenises the extracted prose.

Usage:  uv run --with tiktoken python verify_epub.py
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

DEFAULT = Path(__file__).resolve().parent / "Echoes of the Real - Cosmos.epub"
EPUB = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
OPF_NS = "{http://www.idpf.org/2007/opf}"
XHTML_NS = "{http://www.w3.org/1999/xhtml}"

problems: list[str] = []


def check(condition: bool, message: str) -> None:
    if condition:
        print(f"  ok   {message}")
    else:
        print(f"  FAIL {message}")
        problems.append(message)


def main() -> int:
    if not EPUB.exists():
        print(f"missing {EPUB}", file=sys.stderr)
        return 1

    with zipfile.ZipFile(EPUB) as z:
        names = z.namelist()
        infos = z.infolist()

        print("container:")
        check(names[0] == "mimetype", "mimetype is the first zip entry")
        check(
            infos[0].compress_type == zipfile.ZIP_STORED,
            "mimetype is stored uncompressed",
        )
        check(
            z.read("mimetype").decode() == "application/epub+zip",
            "mimetype content is application/epub+zip",
        )
        check("META-INF/container.xml" in names, "META-INF/container.xml present")

        container = ET.fromstring(z.read("META-INF/container.xml"))
        rootfile = container.find(
            ".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile"
        )
        opf_path = rootfile.get("full-path")
        check(opf_path in names, f"rootfile {opf_path} exists")

        print("package:")
        opf = ET.fromstring(z.read(opf_path))
        base = opf_path.rsplit("/", 1)[0]
        manifest = {
            item.get("id"): item.get("href")
            for item in opf.findall(f".//{OPF_NS}manifest/{OPF_NS}item")
        }
        spine = [
            ref.get("idref")
            for ref in opf.findall(f".//{OPF_NS}spine/{OPF_NS}itemref")
        ]
        missing = [h for h in manifest.values() if f"{base}/{h}" not in names]
        check(not missing, f"all {len(manifest)} manifest hrefs exist in the zip")
        if missing:
            print(f"       missing: {missing[:5]}")
        unresolved = [i for i in spine if i not in manifest]
        check(not unresolved, f"all {len(spine)} spine idrefs resolve")

        nav_items = [
            i for i in opf.findall(f".//{OPF_NS}manifest/{OPF_NS}item")
            if "nav" in (i.get("properties") or "")
        ]
        check(len(nav_items) == 1, "exactly one EPUB 3 nav document declared")
        cover_items = [
            i for i in opf.findall(f".//{OPF_NS}manifest/{OPF_NS}item")
            if "cover-image" in (i.get("properties") or "")
        ]
        check(len(cover_items) == 1, "cover-image declared")

        print("documents:")
        xhtml = [n for n in names if n.endswith(".xhtml")]
        bad = []
        for name in xhtml:
            try:
                ET.fromstring(z.read(name))
            except ET.ParseError as exc:
                bad.append(f"{name}: {exc}")
        check(not bad, f"all {len(xhtml)} XHTML documents parse as XML")
        for line in bad[:5]:
            print(f"       {line}")

        try:
            ET.fromstring(z.read(f"{base}/cover.svg"))
            print("  ok   cover.svg parses as XML")
        except ET.ParseError as exc:
            check(False, f"cover.svg parses as XML ({exc})")

        # The nav document should list every chapter, in spine order.
        nav = ET.fromstring(z.read(f"{base}/{manifest['nav']}"))
        nav_hrefs = [a.get("href") for a in nav.iter(f"{XHTML_NS}a")]
        chapter_spine = [manifest[i] for i in spine if i.startswith("ch")]
        check(
            nav_hrefs == chapter_spine,
            f"nav lists all {len(chapter_spine)} chapters in spine order",
        )

        ncx = ET.fromstring(z.read(f"{base}/toc.ncx"))
        points = ncx.findall(".//{http://www.daisy.org/z3986/2005/ncx/}navPoint")
        check(
            len(points) == len(chapter_spine),
            f"NCX fallback has {len(chapter_spine)} navPoints",
        )

        print("content:")
        texts = []
        for href in chapter_spine:
            root = ET.fromstring(z.read(f"{base}/{href}"))
            body = root.find(f"{XHTML_NS}body")
            texts.append("\n".join(t for t in body.itertext()))
        empty = [h for h, t in zip(chapter_spine, texts) if len(t.strip()) < 200]
        check(not empty, "no chapter is suspiciously short (<200 chars)")
        if empty:
            print(f"       short: {empty[:10]}")

        prose = "\n\n".join(texts)
        chars = len(prose)
        words = len(prose.split())
        print(f"  {len(chapter_spine):,} chapters")
        print(f"  {words:,} words")
        print(f"  {chars:,} characters")

        print("tokens:")
        try:
            import tiktoken

            enc = tiktoken.get_encoding("o200k_base")
            total = sum(len(enc.encode(t)) for t in texts)
            print(f"  {total:,} tokens (o200k_base, a close stand-in for Claude's)")
            print(f"  {total/len(chapter_spine):,.0f} tokens per chapter on average")
            print(f"  {chars/total:.2f} characters per token")
        except ImportError:
            est = round(chars / 4)
            print(f"  ~{est:,} tokens (rough chars/4 estimate; install tiktoken for exact)")

    print()
    if problems:
        print(f"{len(problems)} problem(s) found")
        return 1
    print("EPUB validates clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
