#!/usr/bin/env python3
"""Derive brewing priors from the Fellow Drops profile dataset.

Reads data/fellow-drops-profiles.csv (see data/README.md for provenance) and
prints temperature / bloom / ratio distributions grouped by process, roast,
and elevation. The medians printed here are the source of the priors encoded
in src/brewing-guidelines.ts — re-run after updating the snapshot.
"""

import csv
import re
import statistics as st
from pathlib import Path

CSV_PATH = Path(__file__).resolve().parent.parent / "data" / "fellow-drops-profiles.csv"

rows = list(csv.reader(open(CSV_PATH)))
attrs = {r[0].strip(): i for i, r in enumerate(rows) if r[0].strip()}


def cell(col, label):
    i = attrs.get(label)
    return rows[i][col].strip() if i is not None and col < len(rows[i]) else ""


def parse_temps(s):
    """Return temps in Celsius. Prefer explicit '(93.5 C)'; values >110 are F."""
    cs = re.findall(r"\(([\d.]+)\s*C\)", s)
    if cs:
        return [float(x) for x in cs]
    nums = [float(x) for x in re.findall(r"\d+\.?\d*", s)]
    return [round((n - 32) * 5 / 9, 1) if n > 110 else n for n in nums if 60 <= n <= 212]


def classify_process(s):
    s = s.lower()
    if not s:
        return "unknown"
    if "anaerobic" in s or "carbonic" in s or "ferment" in s:
        return "anaerobic/co-ferment"
    if "honey" in s:
        return "honey"
    if "natural" in s or "dry" in s:
        return "natural"
    if "washed" in s:
        return "washed"
    return "other"


def classify_roast(s):
    s = s.lower()
    if "light" in s:
        return "light"
    if "dark" in s:
        return "dark"
    if "med" in s:
        return "medium"
    return "unknown"


profiles = []
for c in range(1, len(rows[0])):
    name = rows[0][c].strip()
    if not name:
        continue
    bloom = parse_temps(cell(c, "Bloom Temp"))
    single = parse_temps(cell(c, "Single Pulse Temps"))
    elev = re.findall(r"\d{3,4}", cell(c, "Elevation").replace(",", ""))
    ratio = re.findall(r"1\s*:\s*([\d.]+)", cell(c, "Brew Ratio"))
    bloom_s = re.findall(r"\d+", cell(c, "Bloom Time"))
    profiles.append(
        {
            "process": classify_process(cell(c, "Processing")),
            "roast": classify_roast(cell(c, "Roast")),
            "bloom": bloom[0] if bloom else None,
            "pulse_hi": max(single) if single else None,
            "elev": max((int(e) for e in elev), default=None),
            "ratio": float(ratio[0]) if ratio else None,
            "bloom_s": int(bloom_s[0]) if bloom_s else None,
        }
    )


def fmt(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return "n/a"
    return f"median {st.median(vals):5.1f}  range {min(vals):.1f}-{max(vals):.1f}  n={len(vals)}"


def group_stats(key, field, label):
    groups = {}
    for p in profiles:
        groups.setdefault(p[key], []).append(p[field])
    print(f"\n{label}")
    for g, vals in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        print(f"  {g:22} {fmt(vals)}")


print(f"{len(profiles)} profiles parsed from {CSV_PATH.name}")
group_stats("roast", "bloom", "bloom °C by roast (primary temperature driver):")
group_stats("process", "bloom", "bloom °C by process:")
group_stats("process", "bloom_s", "bloom seconds by process:")
group_stats("process", "ratio", "brew ratio by process:")

for proc in ("washed", "natural"):
    sub = [p for p in profiles if p["process"] == proc and p["elev"]]
    hi = [p["pulse_hi"] for p in sub if p["elev"] >= 1800]
    lo = [p["pulse_hi"] for p in sub if p["elev"] < 1800]
    print(f"\n{proc} top pulse °C by elevation:")
    print(f"  >=1800m  {fmt(hi)}")
    print(f"  <1800m   {fmt(lo)}")
