# Echoes of the Real: Cosmos — scraper and EPUB builder

Tooling that reads the web serial *Echoes of the Real: Cosmos* from its public
GitLab Pages site, converts every chapter to clean Markdown, and assembles an
EPUB 3 you can read offline. The chapter text as scraped lives in
[`chapters/`](chapters/), one Markdown file per chapter.

## Source

The serial is published at
<https://echoes-cosmos-fecd9f.gitlab.io/>, authored by Gemini 2.5 Pro as part of
the AI Village project. All prose in `chapters/` is that work, reproduced here as
a format conversion; the scripts are the only original code in this repository.
Credit for the writing belongs to the original project, not to this repo.

## Layout

| Path | What it is |
| --- | --- |
| `build_epub.py` | Fetches the index, caches each chapter page, builds the EPUB and the Markdown |
| `verify_epub.py` | Validates a built EPUB and reports its size in words and tokens |
| `verify_markdown.py` | Checks the Markdown folder for numbering, front matter, and conversion problems |
| `chapters/` | One `.md` per chapter, `chapter-0001.md` … `chapter-1108.md` |
| `sky/` | A static website that draws the myth's recurring characters as constellations in an invented night sky |
| `cache/` | Raw scraped HTML, git-ignored and regenerable |

## Usage

Everything runs on the standard library, so no dependency install is needed:

```bash
uv run python build_epub.py           # EPUB only
uv run python build_epub.py --md      # EPUB plus chapters/
uv run python build_epub.py --md --skip-epub
```

The first run fetches every chapter, eight at a time, into `cache/`. Later runs
reuse that cache and finish in seconds, so re-running after the author posts new
chapters only fetches what is actually new. Useful flags:

- `--refresh` re-fetches everything instead of trusting the cache
- `--limit N` builds only the first N chapters, as a separate book with its own
  title and identifier so it does not collide with the full one in a reader
- `--out PATH` and `--md DIR` choose where things are written

Verifying what came out:

```bash
uv run python verify_markdown.py
uv run --with tiktoken python verify_epub.py
```

## How the conversion works

Each chapter page is static and regular, with the title in an `h1.title` and the
prose in `<p>` tags between the chapter label and the footer navigation, so the
extraction takes that slice and leaves the site's header and footer out. Getting
from there to EPUB means producing well-formed XHTML: named entities like
`&middot;` become literal characters, since XML predefines only five; void tags
are self-closed; and each fragment is parsed and re-serialised through
ElementTree, which preserves the inline `<em>` the prose occasionally uses. A
plain-text fallback catches any page that fails to parse, and the verifier
reports if it ever fires.

The EPUB is version 3 with an NCX fallback, so older readers and Kindle
conversion still get a working table of contents. It ships a generated SVG cover,
because the source site has no artwork. Its metadata deliberately carries no
author or source — it is built as a plain reading copy — which is why the credit
above lives in this README instead.

## The sky

[`sky/`](sky/) is a small static site that presents the serial as a night sky
from somewhere else. Every recurring character gets a constellation of its own,
with a shape invented for it, and places such as the Arboretum and the Shroud
appear as nebulae. It opens like an old film, on a black-and-white title card
that dissolves into a verse by Claude 3 Opus, and a click irises open onto the
sky. Hovering near a figure draws it in, and selecting it opens an atlas plate
with a short account of the character across its incarnations, a few excerpts
quoted from the chapters, and a chart of where in the 1,108 chapters it
appears.

Open `sky/index.html` in a browser; it needs no server. It is plain HTML, CSS
and JavaScript, loads nothing from the network, and keeps everything it needs
inside `sky/`, so the folder can be served as a website on its own. Its
typefaces are in `sky/fonts/`: Wisteria Tale for the title, Basteleur for names
and headings, and That That New Pixel for the interface and the running text.
The title face is one CSS variable, `--script`, in `sky/sky.css`.

| Path | What it is |
| --- | --- |
| `sky/constellations.json` | The curated part: which names get a figure, the spellings that count as a mention, each figure's lines, its story, its excerpts and its neighbours |
| `sky/build_sky.py` | Reads the chapters and the JSON, and writes `sky/data.js` |
| `sky/data.js` | Generated; do not edit by hand |
| `sky/index.html`, `sky/sky.css`, `sky/sky.js` | The page |
| `sky/fonts/` | The five font files the page uses |

Everything that can be measured is measured from the text rather than written
in by hand. The build counts each name across the chapter bodies, which gives a
figure its magnitude (first magnitude from 300 mentions, second from 140, third
from 70) and the weighted-median chapter that sets how far across the sky it
sits, and it packs the figures with a seeded relaxation so the layout is the
same on every run. It also checks that every excerpt appears word for word in
the chapter it cites, and stops if one does not.

```bash
uv run python sky/build_sky.py
uv run python sky/build_sky.py --bundle sky.html   # also one self-contained file, fonts included
```

The characters were chosen by counting capitalised names and titles across the
whole corpus and then reading every chapter to see which of them are beings,
which are places and which are only words, so factions, weapons and one-off
figures with fewer than about twenty mentions are left out.
