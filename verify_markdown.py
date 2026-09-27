#!/usr/bin/env python3
"""Check the per-chapter Markdown folder: numbering, front matter, and clean conversion.

Usage:  uv run python verify_markdown.py [dir]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent / "chapters"

problems: list[str] = []


def check(ok: bool, message: str, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {message}")
    if not ok:
        problems.append(message)
        if detail:
            print(f"       {detail}")


def main() -> int:
    if not DIR.is_dir():
        print(f"missing directory {DIR}", file=sys.stderr)
        return 1

    files = sorted(DIR.glob("chapter-*.md"))
    others = [p.name for p in DIR.iterdir() if p not in files]
    print(f"{DIR.name}/ — {len(files)} chapter files")
    check(not others, "no unexpected files in the folder", f"found: {others[:5]}")

    nums, no_front, bad_chapter, html_left, sentinel, empty, unclosed = [], [], [], [], [], [], []
    words = 0
    italics = 0

    for path in files:
        text = path.read_text(encoding="utf-8")
        n = int(re.search(r"chapter-(\d+)\.md", path.name).group(1))
        nums.append(n)

        m = re.match(r"---\n(.*?)\n---\n\n", text, re.S)
        if not m:
            no_front.append(path.name)
            continue
        front, body = m.group(1), text[m.end():]

        cm = re.search(r"^chapter: (\d+)$", front, re.M)
        tm = re.search(r'^title: "(.*)"$', front, re.M)
        if not cm or int(cm.group(1)) != n or not tm:
            bad_chapter.append(path.name)

        if re.search(r"</?(p|em|strong|div|span|br|h[1-6])\b[^>]*>", body):
            html_left.append(path.name)
        if "\x00" in text:
            sentinel.append(path.name)

        stripped = re.sub(r"^# .*$", "", body, count=1, flags=re.M).strip()
        if len(stripped) < 200:
            empty.append(path.name)
        words += len(stripped.split())

        # Emphasis markers must pair up within each file.
        if stripped.count("**") % 2 or (stripped.replace("**", "").count("*") % 2):
            unclosed.append(path.name)
        if "*" in stripped:
            italics += 1

    check(bool(nums) and nums == list(range(1, len(nums) + 1)),
          f"numbering is contiguous 1..{len(nums)}",
          f"gaps near {[n for i, n in enumerate(nums, 1) if n != i][:5]}")
    check(not no_front, "every file has YAML front matter", f"missing: {no_front[:5]}")
    check(not bad_chapter, "front matter title/chapter agree with the filename",
          f"wrong: {bad_chapter[:5]}")
    check(not html_left, "no HTML tags survived the conversion", f"in: {html_left[:5]}")
    check(not sentinel, "no internal line-break sentinel leaked", f"in: {sentinel[:5]}")
    check(not empty, "no chapter body is suspiciously short", f"short: {empty[:5]}")
    check(not unclosed, "emphasis markers pair up in every file", f"in: {unclosed[:5]}")
    check(italics > 0, f"italic conversion applied ({italics} files use emphasis)")

    print(f"  {words:,} words across the folder")
    print()
    if problems:
        print(f"{len(problems)} problem(s) found")
        return 1
    print("Markdown folder validates clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
