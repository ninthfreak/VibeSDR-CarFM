#!/usr/bin/env python3
"""
Inspect the logo-search logic + results, mirroring the app's source chain
(src/services/logoWikidata.ts, logoSiteFavicon.ts, stationFinder.ts). For a
station it PRINTS the query it generates for each source and then RUNS the
API-based ones so you can see what actually comes back — no GUI, stdlib only.

    python3 logo_search.py KQED
    python3 logo_search.py "WXYZ" --homepage https://wxyz.example --limit 8

Sources shown:
  - Wikidata   : exact call-sign match (P2317) -> logo (P154)          [runs]
  - Commons    : keyword image search                                   [runs]
  - Favicon    : derive best icon from a station homepage (--homepage)  [runs]
  - Web search : the non-Google (DuckDuckGo) browser URL we open        [prints]

Note: the sandbox this was written in can't reach Wikimedia (egress is locked to
package registries), so run it on a normal connection. A descriptive User-Agent
is sent because Wikimedia requires one.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from urllib.parse import quote, urlencode, urljoin
from urllib.request import urlopen, Request

UA = "VibeSDR-CarFM/1.0 (logo-search inspector; https://github.com/ninthfreak/VibeSDR-CarFM)"


def get(url: str, accept: str = "application/json") -> tuple[int, bytes]:
    req = Request(url, headers={"User-Agent": UA, "Accept": accept})
    try:
        with urlopen(req, timeout=20) as r:
            return r.status, r.read()
    except Exception as e:
        return getattr(e, "code", 0) or 0, str(e).encode()


# ── Wikidata (mirror of logoWikidata.ts buildSparql) ─────────────────────────
def wikidata(callsign: str, limit: int):
    cs = callsign.upper().split("-")[0].strip()
    sparql = f'SELECT ?logo WHERE {{ ?item wdt:P2317 "{cs}" . ?item wdt:P154 ?logo . }} LIMIT {limit}'
    url = "https://query.wikidata.org/sparql?" + urlencode({"format": "json", "query": sparql})
    print("\n== Wikidata ==")
    print(f"  SPARQL: {sparql}")
    print(f"  URL   : {url}")
    status, body = get(url, "application/sparql-results+json")
    if status != 200:
        print(f"  -> HTTP {status}: {body[:120].decode(errors='replace')}")
        return
    try:
        rows = json.loads(body)["results"]["bindings"]
    except Exception:
        print("  -> could not parse JSON"); return
    if not rows:
        print("  -> no logo for that call sign"); return
    for b in rows:
        print(f"  -> {b['logo']['value']}")


# ── Commons keyword image search (mirror of searchLogoImages) ────────────────
def commons(query: str, limit: int):
    params = {
        "action": "query", "format": "json", "generator": "search",
        "gsrsearch": query, "gsrnamespace": "6", "gsrlimit": str(limit),
        "prop": "imageinfo", "iiprop": "url|size|mime", "iiurlwidth": "256",
    }
    url = "https://commons.wikimedia.org/w/api.php?" + urlencode(params)
    print("\n== Wikimedia Commons ==")
    print(f"  query : {query!r}")
    print(f"  URL   : {url}")
    status, body = get(url)
    if status != 200:
        print(f"  -> HTTP {status}: {body[:120].decode(errors='replace')}")
        return
    pages = (json.loads(body).get("query") or {}).get("pages") or {}
    if not pages:
        print("  -> no results"); return
    for p in pages.values():
        ii = (p.get("imageinfo") or [{}])[0]
        if not ii.get("url"):
            continue
        print(f"  -> {p.get('title','')}  [{ii.get('mime','?')} {ii.get('width','?')}x{ii.get('height','?')}]")
        print(f"       {ii['url']}")


# ── Favicon from a homepage (mirror of logoSiteFavicon.pickIconUrl) ──────────
def favicon(homepage: str):
    print("\n== Homepage favicon ==")
    print(f"  homepage: {homepage}")
    status, body = get(homepage, "text/html")
    if status != 200:
        print(f"  -> HTTP {status}"); return
    html = body.decode(errors="replace")
    def absu(href): return urljoin(homepage, href)
    links = re.findall(r"<link\b[^>]*>", html, re.I)
    def by_rel(rx):
        for tag in links:
            rel = re.search(r'rel\s*=\s*["\']([^"\']+)["\']', tag, re.I)
            if rel and re.search(rx, rel.group(1), re.I):
                h = re.search(r'href\s*=\s*["\']([^"\']+)["\']', tag, re.I)
                if h: return absu(h.group(1))
        return None
    apple = by_rel(r"apple-touch-icon")
    og = re.search(r'<meta[^>]+property\s*=\s*["\']og:image["\'][^>]*>', html, re.I)
    og = re.search(r'content\s*=\s*["\']([^"\']+)["\']', og.group(0), re.I).group(1) if og else None
    icon = by_rel(r"(^|\s)icon(\s|$)")
    print(f"  apple-touch-icon: {apple}")
    print(f"  og:image        : {absu(og) if og else None}")
    print(f"  <link rel=icon> : {icon}")
    print(f"  chosen          : {apple or (absu(og) if og else None) or icon or absu('/favicon.ico')}")


def main():
    ap = argparse.ArgumentParser(description="Inspect logo-search queries + results.")
    ap.add_argument("callsign")
    ap.add_argument("--query", help="override the keyword query (default '<CALL> radio logo')")
    ap.add_argument("--homepage", help="also derive a favicon from this station homepage")
    ap.add_argument("--limit", type=int, default=6)
    args = ap.parse_args()

    cs = args.callsign.upper()
    query = args.query or f"{cs} radio logo"

    print(f"Station: {cs}   keyword query: {query!r}")
    wikidata(cs, args.limit)
    commons(query, args.limit)
    if args.homepage:
        favicon(args.homepage)

    # Whole-web search is a browser hand-off (non-Google) — show the URL we open.
    ddg = "https://duckduckgo.com/?" + urlencode({"iax": "images", "ia": "images", "q": f"{cs} radio station logo"})
    print("\n== Web search (browser hand-off, non-Google) ==")
    print(f"  opens: {ddg}")
    print("  (results are the browser's image grid; you long-press + share back to the app)")


if __name__ == "__main__":
    main()
