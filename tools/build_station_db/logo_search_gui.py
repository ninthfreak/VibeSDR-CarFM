#!/usr/bin/env python3
"""
GUI to inspect the radio-station logo search — the queries it generates and the
results they return. Mirrors the app's sources (Wikidata + Wikimedia Commons +
homepage favicon; whole-web is a browser hand-off). Tkinter (stdlib); install
Pillow for thumbnails (`pip install pillow`) — without it you still get titles,
sizes, and "Open" buttons.

    python3 logo_search_gui.py

Run on a normal connection (Wikimedia blocks locked-down proxies). Needs a
display + Tk: on Debian/Mint/Ubuntu `sudo apt install python3-tk`.
"""
from __future__ import annotations

import io
import os
import sys
import threading
import webbrowser

import tkinter as tk
from tkinter import ttk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import logo_search as ls  # noqa: E402

try:
    from PIL import Image, ImageTk
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False


class LogoSearchGUI:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("CarFM — Station Logo Search")
        root.geometry("900x680")
        self._imgs: list = []   # keep PhotoImage refs alive

        # ── inputs ────────────────────────────────────────────────────────────
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
            ttk.Entry(top, textvariable=var, width=w).grid(row=0, column=col * 2 + 1, sticky="w")
        ttk.Button(top, text="Search", command=self.on_search).grid(row=0, column=6, padx=10)

        # ── generated queries (the logic) ─────────────────────────────────────
        qf = ttk.LabelFrame(root, text="Generated queries", padding=6)
        qf.pack(fill="x", padx=8)
        self.qtext = tk.Text(qf, height=6, wrap="none", font=("Menlo", 9))
        self.qtext.pack(fill="x")
        self.qtext.configure(state="disabled")

        # ── results (scrollable) ──────────────────────────────────────────────
        rf = ttk.LabelFrame(root, text="Results", padding=4)
        rf.pack(fill="both", expand=True, padx=8, pady=(6, 4))
        self.canvas = tk.Canvas(rf, highlightthickness=0)
        sb = ttk.Scrollbar(rf, orient="vertical", command=self.canvas.yview)
        self.results = ttk.Frame(self.canvas)
        self.results.bind("<Configure>", lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.create_window((0, 0), window=self.results, anchor="nw")
        self.canvas.configure(yscrollcommand=sb.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        self.status = tk.StringVar(value="Enter a callsign and Search." + ("" if HAVE_PIL else "  (no Pillow → no thumbnails)"))
        ttk.Label(root, textvariable=self.status, relief="sunken", anchor="w").pack(fill="x", side="bottom")

    # ── search ───────────────────────────────────────────────────────────────
    def on_search(self):
        cs = self.callsign.get().strip().upper()
        if not cs:
            return
        query = self.query.get().strip() or ls.default_query(cs)
        homepage = self.homepage.get().strip() or None

        _, wd_url = ls.build_wikidata(cs)
        lines = [
            f"Wikidata SPARQL : SELECT ?logo WHERE {{ ?item wdt:P2317 \"{cs}\" . ?item wdt:P154 ?logo . }}",
            f"Wikidata URL    : {wd_url}",
            f"Commons query   : {query!r}",
            f"Commons URL     : {ls.build_commons(query)}",
            f"Web (DuckDuckGo): {ls.ddg_url(cs)}",
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
        wd = ls.search_wikidata(cs)
        cm = ls.search_commons(query)
        fav = ls.search_favicon(homepage) if homepage else None
        rows = list(wd["results"]) + list(cm["results"])
        if fav and fav.get("chosen"):
            rows.append({"url": fav["chosen"], "thumb": fav["chosen"], "title": "homepage favicon",
                         "mime": None, "w": None, "h": None, "source": "favicon"})
        # Pre-download thumbnails (bytes) off the UI thread.
        for r in rows:
            r["_bytes"] = None
            if HAVE_PIL:
                st, data = ls.http_get(r.get("thumb") or r["url"], "image/*")
                if st == 200 and data[:1] not in (b"<",):   # skip HTML/SVG-ish
                    r["_bytes"] = data
        errs = [x for x in (wd["error"], cm["error"], fav["error"] if fav else None) if x]
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
            ttk.Label(meta, text=f"[{r['source']}]  {r.get('title','')}", font=("TkDefaultFont", 11, "bold")).pack(anchor="w")
            ttk.Label(meta, text=f"{r.get('mime') or ''}  {dims}", foreground="#666").pack(anchor="w")
            ttk.Label(meta, text=r["url"], foreground="#3B6FB6", wraplength=560).pack(anchor="w")
            url = r["url"]
            ttk.Button(card, text="Open", command=lambda u=url: webbrowser.open(u)).pack(side="right")
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
