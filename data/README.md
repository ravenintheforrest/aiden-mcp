# Fellow Drops profile dataset

`fellow-drops-profiles.csv` is a snapshot (fetched 2026-06-09) of the community-maintained
[Fellow Drops brew profile spreadsheet](https://docs.google.com/spreadsheets/d/1mi-YS6JYfbX3wN1kZd6iu_q6mFlWM4Ah6N3Ox8eqRCA/edit?gid=0)
— every Fellow Drops profile with origin, roast, process, varietal, elevation,
ratio, bloom, pulse temps, and per-grinder grind settings. All credit to the
spreadsheet's maintainer for compiling it, and to Fellow's coffee team for the
profiles themselves. The same sheet powers Gabriel G Levine's "Aiden Profile
Creator" GPT, which inspired parts of this project.

The temperature and ratio priors in `src/brewing-guidelines.ts` are derived
from this data. To re-derive the stats after updating the snapshot:

```bash
python3 scripts/drops-stats.py
```

Layout note: the sheet is transposed — profiles are columns, attributes are rows.
