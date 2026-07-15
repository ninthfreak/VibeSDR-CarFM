#!/usr/bin/env python3
"""
Single-file GUI to inspect the radio-station logo search — the queries it
generates and the results they return — mirroring the app's sources
(src/services/logoWikidata.ts, logoSiteFavicon.ts, stationFinder.ts):

  - Wikidata : exact call-sign (P2317) -> logo (P154)
  - Commons  : keyword image search
  - Favicon  : best icon from a station homepage (optional)
  - Web      : the non-Google (DuckDuckGo) browser URL the app would open

    python3 logo_search.py

Tkinter (stdlib). `pip install pillow` for thumbnails; without it you still get
titles, sizes, and Open buttons. Run on a normal connection — Wikimedia requires
a descriptive User-Agent (sent below) and blocks locked-down proxies. On
Debian/Mint/Ubuntu the GUI needs `sudo apt install python3-tk`.
"""
from __future__ import annotations

import io
import re
import threading
import webbrowser
from urllib.parse import urlencode, urljoin
from urllib.request import urlopen, Request

import tkinter as tk
from tkinter import ttk

try:
    from PIL import Image, ImageTk
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False

UA = "VibeSDR-CarFM/1.0 (logo-search inspector; https://github.com/ninthfreak/VibeSDR-CarFM)"


# ── search logic (mirrors the app's source modules) ──────────────────────────
def http_get(url: str, accept: str = "application/json") -> tuple[int, bytes]:
    try:
        with urlopen(Request(url, headers={"User-Agent": UA, "Accept": accept}), timeout=20) as r:
            return r.status, r.read()
    except Exception as e:
        return getattr(e, "code", 0) or 0, str(e).encode()


def default_query(callsign: str) -> str:
    return f"{callsign.upper()} radio logo"


def build_wikidata(callsign: str, limit: int = 6) -> tuple[str, str]:
    cs = callsign.upper().split("-")[0].strip()
    sparql = f'SELECT ?logo WHERE {{ ?item wdt:P2317 "{cs}" . ?item wdt:P154 ?logo . }} LIMIT {limit}'
    return sparql, "https://query.wikidata.org/sparql?" + urlencode({"format": "json", "query": sparql})


def search_wikidata(callsign: str, limit: int = 6) -> dict:
    import json
    sparql, url = build_wikidata(callsign, limit)
    out = {"sparql": sparql, "url": url, "results": [], "error": None}
    status, body = http_get(url, "application/sparql-results+json")
    if status != 200:
        out["error"] = f"HTTP {status}: {body[:120].decode(errors='replace')}"
        return out
    try:
        for b in json.loads(body)["results"]["bindings"]:
            out["results"].append({"url": b["logo"]["value"], "thumb": b["logo"]["value"],
                                   "title": "Wikidata P154 logo", "mime": None, "w": None, "h": None,
                                   "source": "wikidata"})
    except Exception as e:
        out["error"] = f"parse error: {e}"
    return out


def build_commons(query: str, limit: int = 12) -> str:
    return "https://commons.wikimedia.org/w/api.php?" + urlencode({
        "action": "query", "format": "json", "generator": "search",
        "gsrsearch": query, "gsrnamespace": "6", "gsrlimit": str(limit),
        "prop": "imageinfo", "iiprop": "url|size|mime", "iiurlwidth": "256",
    })


def search_commons(query: str, limit: int = 12) -> dict:
    import json
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
            "url": ii["url"], "thumb": ii.get("thumburl") or ii["url"], "title": p.get("title", ""),
            "mime": ii.get("mime"), "w": ii.get("width"), "h": ii.get("height"), "source": "commons",
        })
    return out


def search_favicon(homepage: str) -> dict:
    out = {"homepage": homepage, "chosen": None, "error": None}
    status, body = http_get(homepage, "text/html")
    if status != 200:
        out["error"] = f"HTTP {status}"
        return out
    html = body.decode(errors="replace")
    links = re.findall(r"<link\b[^>]*>", html, re.I)

    def by_rel(rx):
        for tag in links:
            rel = re.search(r'rel\s*=\s*["\']([^"\']+)["\']', tag, re.I)
            if rel and re.search(rx, rel.group(1), re.I):
                h = re.search(r'href\s*=\s*["\']([^"\']+)["\']', tag, re.I)
                if h:
                    return urljoin(homepage, h.group(1))
        return None

    apple = by_rel(r"apple-touch-icon")
    ogm = re.search(r'<meta[^>]+property\s*=\s*["\']og:image["\'][^>]*>', html, re.I)
    og = re.search(r'content\s*=\s*["\']([^"\']+)["\']', ogm.group(0), re.I).group(1) if ogm else None
    icon = by_rel(r"(^|\s)icon(\s|$)")
    out["chosen"] = apple or (urljoin(homepage, og) if og else None) or icon or urljoin(homepage, "/favicon.ico")
    return out


def ddg_url(callsign: str) -> str:
    return "https://duckduckgo.com/?" + urlencode(
        {"iax": "images", "ia": "images", "q": f"{callsign.upper()} radio station logo"})


# ── GUI ──────────────────────────────────────────────────────────────────────
class LogoSearchGUI:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("CarFM — Station Logo Search")
        root.geometry("900x680")
        self._imgs: list = []   # keep PhotoImage refs alive

        top = ttk.Frame(root, padding=8)
        top.pack(fill="x")
        self.callsign = tk.StringVar(value="KQED")
        self.query = tk.StringVar()
        self.homepage = tk.StringVar()
        for col, (lbl, var, w) in enumerate([
            ("Callsign", self.callsign, 12), ("Query (optional)", self.query, 26),
            ("Homepage (optional)", self.homepage, 30),
        ]):
            ttk.Label(top, text=lbl).grid(row=0, column=col * 2, sticky="e", padx=(8, 2))
            e = ttk.Entry(top, textvariable=var, width=w)
            e.grid(row=0, column=col * 2 + 1, sticky="w")
        ttk.Button(top, text="Search", command=self.on_search).grid(row=0, column=6, padx=10)
        root.bind("<Return>", lambda _e: self.on_search())

        qf = ttk.LabelFrame(root, text="Generated queries", padding=6)
        qf.pack(fill="x", padx=8)
        self.qtext = tk.Text(qf, height=6, wrap="none")
        self.qtext.pack(fill="x")
        self.qtext.configure(state="disabled")

        rf = ttk.LabelFrame(root, text="Results", padding=4)
        rf.pack(fill="both", expand=True, padx=8, pady=(6, 4))
        self.canvas = tk.Canvas(rf, highlightthickness=0)
        sb = ttk.Scrollbar(rf, orient="vertical", command=self.canvas.yview)
        self.results = ttk.Frame(self.canvas)
        self.results.bind("<Configure>", lambda _e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.create_window((0, 0), window=self.results, anchor="nw")
        self.canvas.configure(yscrollcommand=sb.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        self.status = tk.StringVar(value="Enter a callsign and Search." + ("" if HAVE_PIL else "  (no Pillow → no thumbnails)"))
        ttk.Label(root, textvariable=self.status, relief="sunken", anchor="w").pack(fill="x", side="bottom")

    def on_search(self):
        cs = self.callsign.get().strip().upper()
        if not cs:
            return
        query = self.query.get().strip() or default_query(cs)
        homepage = self.homepage.get().strip() or None

        sparql, wd_url = build_wikidata(cs)
        lines = [
            f"Wikidata SPARQL : {sparql}",
            f"Wikidata URL    : {wd_url}",
            f"Commons query   : {query!r}",
            f"Commons URL     : {build_commons(query)}",
            f"Web (DuckDuckGo): {ddg_url(cs)}",
        ]
        if homepage:
            lines.append(f"Favicon of      : {homepage}")
        self._set_queries("\n".join(lines))

        for w in self.results.winfo_children():
            w.destroy()
        self._imgs.clear()
        self.status.set("Searching…")
        threading.Thread(target=self._work, args=(cs, query, homepage), daemon=True).start()

    def _work(self, cs, query, homepage):
        wd = search_wikidata(cs)
        cm = search_commons(query)
        fav = search_favicon(homepage) if homepage else None
        rows = list(wd["results"]) + list(cm["results"])
        if fav and fav.get("chosen"):
            rows.append({"url": fav["chosen"], "thumb": fav["chosen"], "title": "homepage favicon",
                         "mime": None, "w": None, "h": None, "source": "favicon"})
        for r in rows:
            r["_bytes"] = None
            if HAVE_PIL:
                st, data = http_get(r.get("thumb") or r["url"], "image/*")
                if st == 200 and not data[:1] == b"<":   # skip HTML/SVG-ish
                    r["_bytes"] = data
        errs = [x for x in (wd["error"], cm["error"], (fav or {}).get("error")) if x]
        self.root.after(0, lambda: self._render(rows, errs))

    def _render(self, rows, errs):
        if not rows:
            ttk.Label(self.results, text="No results." + (("  " + errs[0]) if errs else "")).pack(anchor="w", padx=8, pady=8)
            self.status.set("Done — 0 results" + (f"  ({errs[0]})" if errs else ""))
            return
        for r in rows:
            card = ttk.Frame(self.results, padding=6)
            card.pack(fill="x", anchor="w")
            if r.get("_bytes"):
                try:
                    im = Image.open(io.BytesIO(r["_bytes"]))
                    im.thumbnail((96, 96))
                    ph = ImageTk.PhotoImage(im)
                    self._imgs.append(ph)
                    tk.Label(card, image=ph, width=100).pack(side="left")
                except Exception:
                    tk.Label(card, text="[img]", width=12).pack(side="left")
            else:
                tk.Label(card, text="[no preview]", width=12, foreground="#888").pack(side="left")
            dims = f"{r['w']}x{r['h']}" if r.get("w") else ""
            meta = ttk.Frame(card)
            meta.pack(side="left", fill="x", expand=True, padx=8)
            ttk.Label(meta, text=f"[{r['source']}]  {r.get('title', '')}", font=("TkDefaultFont", 11, "bold")).pack(anchor="w")
            ttk.Label(meta, text=f"{r.get('mime') or ''}  {dims}", foreground="#666").pack(anchor="w")
            ttk.Label(meta, text=r["url"], foreground="#3B6FB6", wraplength=560).pack(anchor="w")
            ttk.Button(card, text="Open", command=lambda u=r["url"]: webbrowser.open(u)).pack(side="right")
        self.status.set(f"Done — {len(rows)} results" + (f"  (some errors: {errs[0]})" if errs else ""))

    def _set_queries(self, text):
        self.qtext.configure(state="normal")
        self.qtext.delete("1.0", "end")
        self.qtext.insert("1.0", text)
        self.qtext.configure(state="disabled")


def main():
    root = tk.Tk()
    LogoSearchGUI(root)
    root.mainloop()


if __name__ == "__main__":
    main()
