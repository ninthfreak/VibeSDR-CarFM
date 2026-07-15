#!/usr/bin/env python3
"""
Simulate EXACTLY what the app will auto-search for a station's logo, over REAL
stations, so you can eyeball whether the results are usable. No typing: the query
is derived from station data the way the app derives it — you just press Run.

What the app intends to search on (the thing being evaluated here):
  - Wikidata : the call sign, exact structured match (P2317) -> logo (P154)
  - Commons  : auto-built keyword string  ==  "<callsign> <city> <state> radio logo"
               (the app has callsign/city/state/freq from the FCC DB; the branded
                RDS name isn't known until a station is tuned, so it's not used.)
  - Web      : the same keyword handed to a non-Google (DuckDuckGo) browser search.

Stations come from a real stations.sqlite if one is loaded (File > Load), else a
built-in set of well-known US FM stations so it's useful before the FCC DB build.

    python3 logo_search.py            # Tkinter; `pip install pillow` for thumbnails

Run on a normal connection (Wikimedia blocks locked-down proxies). Needs Tk
(`sudo apt install python3-tk`).
"""
from __future__ import annotations

import io
import json
import sqlite3
import threading
import time
import webbrowser
from urllib.parse import urlencode
from urllib.request import urlopen, Request

try:
    import tkinter as tk
    from tkinter import ttk, filedialog
    HAVE_TK = True
except Exception:
    HAVE_TK = False

try:
    from PIL import Image, ImageTk
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False

UA = "VibeSDR-CarFM/1.0 (logo-search inspector; https://github.com/ninthfreak/VibeSDR-CarFM)"

# Well-known real US FM stations so the sim shows real logos before the FCC build.
# (callsign, city, state, MHz) — frequency is display-only; it isn't in the query.
BUILTIN_STATIONS = [
    ("KQED", "San Francisco", "CA", 88.5), ("KCRW", "Santa Monica", "CA", 89.9),
    ("KEXP", "Seattle", "WA", 90.3), ("WNYC", "New York", "NY", 93.9),
    ("WXPN", "Philadelphia", "PA", 88.5), ("WFMU", "Jersey City", "NJ", 91.1),
    ("WBEZ", "Chicago", "IL", 91.5), ("KUTX", "Austin", "TX", 98.9),
    ("WAMU", "Washington", "DC", 88.5), ("KUOW", "Seattle", "WA", 94.9),
    ("WBUR", "Boston", "MA", 90.9), ("WWOZ", "New Orleans", "LA", 90.7),
    ("KUSC", "Los Angeles", "CA", 91.5), ("WHYY", "Philadelphia", "PA", 90.9),
    ("KROQ", "Los Angeles", "CA", 106.7), ("WXRT", "Chicago", "IL", 93.1),
]


# ── the app's intended query construction (single source of truth for the sim) ──
def wikidata_url(callsign: str) -> tuple[str, str]:
    cs = callsign.upper().split("-")[0].strip()
    sparql = f'SELECT ?logo WHERE {{ ?item wdt:P2317 "{cs}" . ?item wdt:P154 ?logo . }} LIMIT 3'
    return sparql, "https://query.wikidata.org/sparql?" + urlencode({"format": "json", "query": sparql})


def keyword_query(callsign: str, city: str | None, state: str | None) -> str:
    return " ".join(x for x in [callsign.upper(), city or "", state or "", "radio logo"] if x)


def commons_url(query: str, limit: int = 5) -> str:
    return "https://commons.wikimedia.org/w/api.php?" + urlencode({
        "action": "query", "format": "json", "generator": "search", "gsrsearch": query,
        "gsrnamespace": "6", "gsrlimit": str(limit), "prop": "imageinfo",
        "iiprop": "url|size|mime", "iiurlwidth": "128",
    })


def ddg_url(query: str) -> str:
    return "https://duckduckgo.com/?" + urlencode({"iax": "images", "ia": "images", "q": query})


# ── fetch ─────────────────────────────────────────────────────────────────────
def http_get(url: str, accept: str = "application/json") -> tuple[int, bytes]:
    try:
        with urlopen(Request(url, headers={"User-Agent": UA, "Accept": accept}), timeout=20) as r:
            return r.status, r.read()
    except Exception as e:
        return getattr(e, "code", 0) or 0, str(e).encode()


def run_searches(callsign: str, city: str | None, state: str | None) -> dict:
    """Run the app's intended searches for one station; return results + queries."""
    hits: list[dict] = []
    _, wd_url = wikidata_url(callsign)
    st, body = http_get(wd_url, "application/sparql-results+json")
    if st == 200:
        try:
            for b in json.loads(body)["results"]["bindings"]:
                hits.append({"url": b["logo"]["value"], "source": "wikidata"})
        except Exception:
            pass
    kw = keyword_query(callsign, city, state)
    st, body = http_get(commons_url(kw))
    if st == 200:
        pages = (json.loads(body).get("query") or {}).get("pages") or {}
        for p in pages.values():
            ii = (p.get("imageinfo") or [{}])[0]
            if ii.get("url"):
                hits.append({"url": ii["url"], "thumb": ii.get("thumburl") or ii["url"], "source": "commons"})
    return {"keyword": kw, "ddg": ddg_url(kw), "hits": hits}


# ── GUI ──────────────────────────────────────────────────────────────────────
class Sim:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("CarFM — Logo Search Simulation (what the app will search for)")
        root.geometry("980x720")
        self._imgs: list = []
        self.stations = list(BUILTIN_STATIONS)
        self.running = False

        bar = ttk.Frame(root, padding=8)
        bar.pack(fill="x")
        self.run_btn = ttk.Button(bar, text="Run simulation", command=self.run)
        self.run_btn.pack(side="left")
        ttk.Button(bar, text="Load stations.sqlite…", command=self.load_db).pack(side="left", padx=8)
        self.src = tk.StringVar(value=f"source: {len(self.stations)} built-in real stations")
        ttk.Label(bar, textvariable=self.src).pack(side="left", padx=8)

        ttk.Label(root, padding=(8, 0), foreground="#555", justify="left",
                  text='Query per station = "<callsign> <city> <state> radio logo"  •  '
                       'Wikidata = exact call sign.  No manual input — this is what the app auto-searches.'
                  ).pack(fill="x")

        wrap = ttk.Frame(root, padding=4)
        wrap.pack(fill="both", expand=True)
        self.canvas = tk.Canvas(wrap, highlightthickness=0)
        sb = ttk.Scrollbar(wrap, orient="vertical", command=self.canvas.yview)
        self.body = ttk.Frame(self.canvas)
        self.body.bind("<Configure>", lambda _e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.create_window((0, 0), window=self.body, anchor="nw")
        self.canvas.configure(yscrollcommand=sb.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        self.status = tk.StringVar(value="Press Run." + ("" if HAVE_PIL else "  (pip install pillow for thumbnails)"))
        ttk.Label(root, textvariable=self.status, relief="sunken", anchor="w").pack(fill="x", side="bottom")

    def load_db(self):
        f = filedialog.askopenfilename(filetypes=[("SQLite", "*.sqlite *.db"), ("All", "*.*")])
        if not f:
            return
        try:
            con = sqlite3.connect(f)
            con.row_factory = sqlite3.Row
            rows = con.execute("SELECT callsign, city, state, frequency_mhz FROM stations "
                               "WHERE service='FM' ORDER BY callsign LIMIT 40").fetchall()
            con.close()
            self.stations = [(r["callsign"], r["city"], r["state"], r["frequency_mhz"]) for r in rows]
            self.src.set(f"source: {len(self.stations)} FM stations from {f.split('/')[-1]}")
        except Exception as e:
            self.status.set(f"could not read DB: {e}")

    def run(self):
        if self.running:
            return
        self.running = True
        self.run_btn.configure(state="disabled")
        for w in self.body.winfo_children():
            w.destroy()
        self._imgs.clear()
        threading.Thread(target=self._work, daemon=True).start()

    def _work(self):
        n = len(self.stations)
        for i, (cs, city, state, freq) in enumerate(self.stations, 1):
            self.root.after(0, lambda i=i, cs=cs: self.status.set(f"Searching {i}/{n}: {cs}…"))
            res = run_searches(cs, city, state)
            for h in res["hits"][:6]:
                if HAVE_PIL:
                    st, data = http_get(h.get("thumb") or h["url"], "image/*")
                    h["_bytes"] = data if (st == 200 and data[:1] != b"<") else None
            self.root.after(0, lambda cs=cs, city=city, state=state, freq=freq, res=res: self._row(cs, city, state, freq, res))
            time.sleep(0.4)  # be polite to the APIs
        self.root.after(0, lambda: (self.status.set(f"Done — {n} stations."), self.run_btn.configure(state="normal")))
        self.running = False

    def _row(self, cs, city, state, freq, res):
        card = ttk.Frame(self.body, padding=(8, 6))
        card.pack(fill="x", anchor="w")
        head = ttk.Frame(card); head.pack(fill="x")
        ttk.Label(head, text=f"{cs}", font=("TkDefaultFont", 12, "bold")).pack(side="left")
        ttk.Label(head, text=f"  {city}, {state}   {freq} MHz", foreground="#555").pack(side="left")
        ttk.Button(head, text="open web search", command=lambda u=res["ddg"]: webbrowser.open(u)).pack(side="right")
        ttk.Label(card, text=f'query: "{res["keyword"]}"', foreground="#777").pack(anchor="w")
        strip = ttk.Frame(card); strip.pack(fill="x", pady=2)
        if not res["hits"]:
            ttk.Label(strip, text="— no results —", foreground="#a00").pack(side="left")
        for h in res["hits"][:6]:
            cell = ttk.Frame(strip, padding=2); cell.pack(side="left")
            if h.get("_bytes"):
                try:
                    im = Image.open(io.BytesIO(h["_bytes"])); im.thumbnail((72, 72))
                    ph = ImageTk.PhotoImage(im); self._imgs.append(ph)
                    b = tk.Button(cell, image=ph, command=lambda u=h["url"]: webbrowser.open(u), bd=1)
                    b.pack()
                except Exception:
                    tk.Button(cell, text="[img]", command=lambda u=h["url"]: webbrowser.open(u)).pack()
            else:
                tk.Button(cell, text=h["source"], command=lambda u=h["url"]: webbrowser.open(u)).pack()
            ttk.Label(cell, text=h["source"], foreground="#888", font=("TkDefaultFont", 8)).pack()
        ttk.Separator(card, orient="horizontal").pack(fill="x", pady=(6, 0))


def main():
    if not HAVE_TK:
        print("Tkinter isn't available. On Debian/Mint/Ubuntu: sudo apt install python3-tk")
        return
    root = tk.Tk()
    Sim(root)
    root.mainloop()


if __name__ == "__main__":
    main()
