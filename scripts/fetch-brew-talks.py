#!/usr/bin/env python3
"""Harvest Fellow's Brew Talks posts into a profile dataset.

This is the PRIMARY source of truth for expert Aiden profiles: Fellow's own
blog (every Fellow Drops recipe is published there), discovered via
https://fellowproducts.com/tools/sitemap. Each post embeds a brew.link code,
and Fellow's API resolves codes to exact profile JSON unauthenticated via
GET /shared/{bid} — so the whole chain is machine-readable with no manual
transcription (the community spreadsheet that previously seeded our priors
is a hand-copied subset of these posts).

Writes data/brew-talks-profiles.csv and prints the prior-relevant medians.
Re-run any time Fellow publishes new Drops to refresh the dataset.
"""

import csv
import json
import re
import statistics as st
import time
import urllib.request
from pathlib import Path

SITE = "https://fellowproducts.com"
SITEMAP = SITE + "/tools/sitemap"
SHARED_API = "https://l8qtmnc692.execute-api.us-west-2.amazonaws.com/v1/shared/{bid}"
UA = {"User-Agent": "Mozilla/5.0 (aiden-mcp dataset refresh; github.com/ravenintheforrest/aiden-mcp)"}
OUT = Path(__file__).resolve().parent.parent / "data" / "brew-talks-profiles.csv"


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def strip_tags(html):
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", "\n", text)
    return re.sub(r"[ \t]+", " ", text)


def classify(text, pattern):
    """Posts describe coffee in prose ('A medium roast washed coffee from
    Cusco, Peru...'), not labeled fields — keyword-match the whole text."""
    m = re.search(pattern, text, re.I)
    return m.group(1).lower().replace("-", " ") if m else ""


def main():
    sitemap = get(SITEMAP)
    posts = sorted(set(re.findall(r'href="(/blogs/brew-talks/[^"#?]+)"', sitemap)))
    print(f"{len(posts)} Brew Talks posts in sitemap")

    rows, no_link = [], []
    for i, path in enumerate(posts):
        url = SITE + path
        try:
            html = get(url)
        except Exception as e:
            print(f"  fetch failed: {path} ({e})")
            continue
        codes = sorted(set(re.findall(r"brew\.link/p/([A-Za-z0-9]+)", html)))
        # Classify ONLY within the curated meta description + title — body
        # text is full of incidental "natural"s (nav, marketing copy).
        desc = re.search(r'<meta name=.description. content=.([^"\']+)', html)
        title = re.search(r"<title>([^<]+)</title>", html)
        summary = f"{title.group(1) if title else ''} {desc.group(1) if desc else ''}"
        meta = {
            "post": path,
            "roast": classify(summary, r"\b(medium[- ]light|medium[- ]dark|light|medium|dark)\s+roast"),
            "process": classify(
                summary,
                r"\b(anaerobic|carbonic|co[- ]?ferment(?:ed)?|honey[- ]processed|honey|washed|natural(?:ly)?[- ]processed|natural)\b",
            ),
        }
        if not codes:
            no_link.append(path)
            continue
        for bid in codes:
            try:
                profile = json.loads(get(SHARED_API.format(bid=bid)))
            except Exception as e:
                print(f"  brew.link {bid} failed ({e})")
                continue
            rows.append(
                {
                    **meta,
                    "bid": bid,
                    "title": profile.get("title", ""),
                    "ratio": profile.get("ratio"),
                    "bloomRatio": profile.get("bloomRatio"),
                    "bloomDuration": profile.get("bloomDuration"),
                    "bloomTemperature": profile.get("bloomTemperature"),
                    "ssPulsesNumber": profile.get("ssPulsesNumber"),
                    "ssPulsesInterval": profile.get("ssPulsesInterval"),
                    "ssPulseTemperatures": json.dumps(profile.get("ssPulseTemperatures")),
                    "batchPulsesNumber": profile.get("batchPulsesNumber"),
                    "batchPulsesInterval": profile.get("batchPulsesInterval"),
                    "batchPulseTemperatures": json.dumps(profile.get("batchPulseTemperatures")),
                }
            )
        if (i + 1) % 20 == 0:
            print(f"  ...{i + 1}/{len(posts)} posts")
        time.sleep(0.2)

    OUT.parent.mkdir(exist_ok=True)
    with open(OUT, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\nwrote {len(rows)} profiles -> {OUT.name}; {len(no_link)} posts had no brew.link")

    # Prior-relevant medians (mirrors scripts/drops-stats.py groupings)
    def med(vals, label):
        vals = [v for v in vals if v is not None]
        if vals:
            print(f"  {label:24} median {st.median(vals):5.1f}  range {min(vals):.1f}-{max(vals):.1f}  n={len(vals)}")

    print("\nbloom °C by roast:")
    for tier in ("light", "medium", "dark"):
        med([r["bloomTemperature"] for r in rows if tier in r["roast"].lower()], tier)
    print("bloom °C by process:")
    for proc, pat in (("washed", "washed"), ("natural", "natural"), ("anaerobic/cofer", "anaerobic|ferment|carbonic"), ("honey", "honey")):
        med([r["bloomTemperature"] for r in rows if re.search(pat, r["process"], re.I)], proc)
    print("ratio overall:")
    med([r["ratio"] for r in rows], "all profiles")


if __name__ == "__main__":
    main()
