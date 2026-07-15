#!/usr/bin/env python3
"""
Logo-search logic + results, mirroring the app's source chain
(src/services/logoWikidata.ts, logoSiteFavicon.ts, stationFinder.ts).

This module exposes the query-BUILDING and query-RUNNING functions used by both
the CLI here and the GUI (logo_search_gui.py). For a station it shows the query
generated for each source and what the API-based ones return.

CLI:
    python3 logo_search.py KQED
    python3 logo_search.py KQED --query "KQED San Francisco" --homepage https://www.kqed.org
GUI:
    python3 logo_search_gui.py        (Tkinter; pip install pillow for thumbnails)

Run on a normal connection — Wikimedia requires a descriptive User-Agent (sent
below) and blocks locked-down proxies.
"""
from __future__ import annotations

import argparse
import json
import re
from urllib.parse import urlencode, urljoin
from urllib.request import urlopen, Request

UA = "VibeSDR-CarFM/1.0 (logo-search inspector; https://github.com/ninthfreak/VibeSDR-CarFM)"


def http_get(url: str, accept: str = "application/json") -> tuple[int, bytes]:
    try:
        with urlopen(Request(url, headers={"User-Agent": UA, "Accept": accept}), timeout=20) as r:
            return r.status, r.read()
    except Exception as e:
        return getattr(e, "code", 0) or 0, str(e).encode()


def default_query(callsign: str) -> str:
    return f"{callsign.upper()} radio logo"


# ── Wikidata (mirror of logoWikidata.ts buildSparql) ─────────────────────────
def build_wikidata(callsign: str, limit: int = 6) -> tuple[str, str]:
    cs = callsign.upper().split("-")[0].strip()
    sparql = f'SELECT ?logo WHERE {{ ?item wdt:P2317 "{cs}" . ?item wdt:P154 ?logo . }} LIMIT {limit}'
    url = "https://query.wikidata.org/sparql?" + urlencode({"format": "json", "query": sparql})
    return sparql, url


def search_wikidata(callsign: str, limit: int = 6) -> dict:
    sparql, url = build_wikidata(callsign, limit)
    out = {"sparql": sparql, "url": url, "results": [], "error": None}
    status, body = http_get(url, "application/sparql-results+json")
    if status != 200:
        out["error"] = f"HTTP {status}: {body[:120].decode(errors='replace')}"
        return out
    try:
        for b in json.loads(body)["results"]["bindings"]:
            out["results"].append({"url": b["logo"]["value"], "title": "Wikidata P154 logo",
                                   "mime": None, "w": None, "h": None, "source": "wikidata"})
    except Exception as e:
        out["error"] = f"parse error: {e}"
    return out


# ── Commons keyword image search (mirror of searchLogoImages) ────────────────
def build_commons(query: str, limit: int = 12) -> str:
    return "https://commons.wikimedia.org/w/api.php?" + urlencode({
        "action": "query", "format": "json", "generator": "search",
        "gsrsearch": query, "gsrnamespace": "6", "gsrlimit": str(limit),
        "prop": "imageinfo", "iiprop": "url|size|mime", "iiurlwidth": "256",
    })


def search_commons(query: str, limit: int = 12) -> dict:
    url = build_commons(query, limit)
    out = {"query": query, "url": url, "results": [], "error": None}
    status, body = http_get(url)
    if status != 200:
        out["error"] = f"HTTP {status}: {body[:120].decode(errors='replace')}"
        return out
    pages = (json.loads(body).get("query") or {}).get("pages") or {}
    for p in pages.values():
        ii = (p.get("imageinfo") or [{}])[0]
        if not ii.get("url"):
            continue
        out["results"].append({
            "url": ii["url"], "thumb": ii.get("thumburl") or ii["url"],
            "title": p.get("title", ""), "mime": ii.get("mime"),
            "w": ii.get("width"), "h": ii.get("height"), "source": "commons",
        })
    return out


# ── Favicon from a homepage (mirror of logoSiteFavicon.pickIconUrl) ──────────
def search_favicon(homepage: str) -> dict:
    out = {"homepage": homepage, "candidates": {}, "chosen": None, "error": None}
    status, body = http_get(homepage, "text/html")
    if status != 200:
        out["error"] = f"HTTP {status}"
        return out
    html = body.decode(errors="replace")
    absu = lambda href: urljoin(homepage, href)
    links = re.findall(r"<link\b[^>]*>", html, re.I)

    def by_rel(rx):
        for tag in links:
            rel = re.search(r'rel\s*=\s*["\']([^"\']+)["\']', tag, re.I)
            if rel and re.search(rx, rel.group(1), re.I):
                h = re.search(r'href\s*=\s*["\']([^"\']+)["\']', tag, re.I)
                if h:
                    return absu(h.group(1))
        return None

    apple = by_rel(r"apple-touch-icon")
    ogm = re.search(r'<meta[^>]+property\s*=\s*["\']og:image["\'][^>]*>', html, re.I)
    og = re.search(r'content\s*=\s*["\']([^"\']+)["\']', ogm.group(0), re.I).group(1) if ogm else None
    icon = by_rel(r"(^|\s)icon(\s|$)")
    out["candidates"] = {"apple-touch-icon": apple, "og:image": absu(og) if og else None, "icon": icon}
    out["chosen"] = apple or (absu(og) if og else None) or icon or absu("/favicon.ico")
    return out


def ddg_url(callsign: str) -> str:
    return "https://duckduckgo.com/?" + urlencode(
        {"iax": "images", "ia": "images", "q": f"{callsign.upper()} radio station logo"})


# ── CLI ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Inspect logo-search queries + results.")
    ap.add_argument("callsign")
    ap.add_argument("--query", help="override the keyword query (default '<CALL> radio logo')")
    ap.add_argument("--homepage", help="also derive a favicon from this station homepage")
    ap.add_argument("--limit", type=int, default=8)
    args = ap.parse_args()

    cs = args.callsign.upper()
    query = args.query or default_query(cs)
    print(f"Station: {cs}   keyword query: {query!r}\n")

    wd = search_wikidata(cs, args.limit)
    print("== Wikidata ==")
    print(f"  SPARQL: {wd['sparql']}")
    print(f"  URL   : {wd['url']}")
    if wd["error"]:
        print(f"  -> {wd['error']}")
    elif not wd["results"]:
        print("  -> no logo for that call sign")
    else:
        for r in wd["results"]:
            print(f"  -> {r['url']}")

    cm = search_commons(query, args.limit)
    print("\n== Wikimedia Commons ==")
    print(f"  query : {query!r}")
    print(f"  URL   : {cm['url']}")
    if cm["error"]:
        print(f"  -> {cm['error']}")
    elif not cm["results"]:
        print("  -> no results")
    else:
        for r in cm["results"]:
            print(f"  -> {r['title']}  [{r['mime']} {r['w']}x{r['h']}]\n       {r['url']}")

    if args.homepage:
        fav = search_favicon(args.homepage)
        print("\n== Homepage favicon ==")
        if fav["error"]:
            print(f"  -> {fav['error']}")
        else:
            for k, v in fav["candidates"].items():
                print(f"  {k:16}: {v}")
            print(f"  chosen          : {fav['chosen']}")

    print("\n== Web search (browser hand-off, non-Google) ==")
    print(f"  opens: {ddg_url(cs)}")
    print("  (results are the browser's image grid; long-press + share back to the app)")


if __name__ == "__main__":
    main()
