# Expert profile datasets

Two datasets back the priors in `src/brewing-guidelines.ts`. Their medians agree on the headline findings (no washed-vs-natural temperature split; roast level and density are the real temp drivers; ratios cluster at 1:16).

## brew-talks-profiles.csv — primary source

Harvested end-to-end from Fellow's own publishing: the [sitemap](https://fellowproducts.com/tools/sitemap) lists every Brew Talks post, each post embeds a brew.link code, and Fellow's API resolves codes to exact profile JSON (unauthenticated `GET /shared/{bid}`). 145 profiles as of June 2026, no manual transcription anywhere.

```bash
python3 scripts/fetch-brew-talks.py   # refresh after Fellow publishes new Drops
```

## fellow-drops-profiles.csv — curated community index

Snapshot (2026-06-09) of the community-maintained
[Fellow Drops spreadsheet](https://docs.google.com/spreadsheets/d/1mi-YS6JYfbX3wN1kZd6iu_q6mFlWM4Ah6N3Ox8eqRCA/edit?gid=0)
(transposed layout: profiles are columns). It hand-curates what the blog doesn't state: elevation, varietals, and per-grinder grind settings. All credit to the spreadsheet's maintainer; the same sheet powers Gabriel G Levine's "Aiden Profile Creator" GPT, which inspired parts of this project.

```bash
python3 scripts/drops-stats.py        # re-derive priors from the snapshot
```
