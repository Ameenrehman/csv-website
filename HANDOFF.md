# Handoff

Everything needed to own this repo. Read this first; `README.md` is the reference and
`PIPELINE.md` is the design rationale plus the full findings log.

Handed off 2026-08-03.

---

## What it is

A static dashboard on GitHub Pages that tracks how trading signals performed after they were
issued. A scanner drops one CSV per day into `orderbook/`. A scheduled job then appends six
performance columns to every still-open row, every trading session, until the row hits its target.
The dashboard reads those CSVs straight from the GitHub API in the browser — there is no backend
and no database.

## Current state

| | |
|---|---|
| Repo | `github.com/Ameenrehman/csv-website`, branch `main` |
| Live at | GitHub Pages, source = **GitHub Actions** |
| Data | 64 files, 450 signals, 2026-04-30 → 2026-07-31 |
| Split | 227 Buy / 223 Sell · 236 TP Hit / 214 Open |
| Widest file | 367 columns (`orderbook2026-05-05.csv`) |
| Last verified | 40,422 metric cells, all invariants hold; re-run byte-identical |

Both workflows have run green on push. The five synthetic demo CSVs that used to sit at the repo
root were removed, so every dashboard statistic now reflects real signals only.

## Repo map

```
orderbook/                    THE DATA. 64 dated CSVs. Source of truth.
update_signals.py             The updater. ~700 lines, stdlib + pandas/yfinance.
requirements.txt              pandas, yfinance
app.js                        Whole front-end. Parsing, analytics, all three pages.
index.html                    Dashboard
active-signals.html           Open positions watchlist
signals.html                  Per-file browser
styles.css                    Themes, tables, badges
.github/workflows/
  daily-update.yml            Runs the updater, commits, pushes
  pages.yml                   Publishes the static shell
.gitlab-ci.yml                DEAD. GitLab syntax, inert on GitHub. Safe to delete.
README.md                     Reference: schema, flags, conventions
PIPELINE.md                   Design decisions, findings log, open suggestions
```

## The daily loop

```
scanner writes orderbook/orderbook2026-08-04.csv   (Symbol, Buy/Sell, CBT, Target Price)
        │  you commit + push
        ▼
daily-update.yml fires  ── also on cron 11:00 UTC Mon–Fri, and manually
        │  yfinance OHLC for every open symbol
        │  append 6 columns per new session to every open row, all files
        │  mark target/stop hits → Status, ExitPrice, ExitDate
        │  commit + push back to main
        ▼
dashboard shows it on next page refresh — no deploy involved
```

## Three rules

**1. Never overwrite a file the pipeline has written to.** Add new dated files only. The updater
is additive — it appends the newest session and never re-derives the past, so a tracked file *is*
the record of its own history. This was hit for real: `orderbook2026-05-06.csv` was replaced with
raw scanner output and lost 59 sessions plus two recorded exits. Rebuilding is capped by
`--max-lookback-days`, so anything older is gone, and closed rows can get re-stamped with wrong
exit dates. `PIPELINE.md` §6.8.

**2. Hard-refresh after front-end changes.** `Ctrl+Shift+R`. `app.js` is browser-cached. CSVs
refetch on their own — that cache is keyed by git blob SHA.

**3. A new file gets no columns on its own signal day.** The position opens at `CBT` that day, so
tracking starts the next session. A same-day file looking "empty" is correct, not broken.

## Running it by hand

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Linux/macOS: .venv/bin/pip

python update_signals.py --dry-run                 # safe: reports, writes nothing
python update_signals.py                           # update locally
python update_signals.py --commit --push           # update, commit, push
python update_signals.py --max-lookback-days 120   # deep backfill
```

Without touching a terminal: **Actions → Daily signal update → Run workflow**, `dry_run` = `true`.
Runs the whole job and reports what it would change.

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| Dashboard lists files, shows no data | You're on the OMA network — `raw.githubusercontent.com` is blocked there | Works elsewhere. Permanent fix in `PIPELINE.md` §9 |
| `No trading sessions in range` | Weekend, holiday, or bar not published yet | Normal. Nothing to do |
| `! Oldest open file trails …` | A tracked file was reset to scanner output | **Stop.** Restore it from git before pushing. Rule 1 |
| `! N open row(s) have a target on the wrong side of entry` | Scanner emitted a bad row | 3 known: META, RVLV, COHR. Fix upstream |
| `! N row(s) touched TP and SL in the same session` | Daily bars can't order intraday events | `--tie` decided it. Check against intraday data if it matters |
| Front-end changes not showing | Browser cache | Rule 2 |
| Pages deploy fails | Pages source flipped off "GitHub Actions" | Settings → Pages → Source |
| New columns missing after a schema change | — | Was a bug (§6.9), fixed. Schema writes always persist now |

## Decisions already made

Changing any of these is a real decision, not a tweak.

| Decision | Choice | Reversal cost |
|---|---|---|
| Metrics | Both per-day and running (6/session) | Low — additive |
| Expiry | **Never** — signals track indefinitely | Low — set `--max-hold N` |
| Prices | yfinance daily, unadjusted | Medium — intraday caps history at 60 days |
| Stop loss | Read when present; you're adding it upstream | Low — already supported |
| Entry | Filled at `CBT` on signal date | High — changes every historical number |
| File I/O | stdlib `csv`, not pandas | Low, but pandas would wreck git diffs |

## Outstanding

**Yours:** add the `SL` column to the scanner output — the pipeline already reads it and will
start closing rows on stops the moment it appears. Fix the three bad rows in §6.5.

**Suggested, not done** (`PIPELINE.md` §9): make the updater *refuse* rather than warn when a
tracked file has been reset; serve CSVs same-origin to fix the blocked-host issue and drop the API
rate-limit exposure; delete `.gitlab-ci.yml`.

**Watch:** file width. Signals never expire, so open rows gain 6 columns per session forever and
every visitor downloads every CSV on first load. This becomes a page-load problem long before a
storage one. `--max-hold 30` bounds it whenever you want.

## If you change the schema

Column lookup is by name in both `update_signals.py` (`ALIASES`) and `app.js` (`HEADER_ALIASES`),
so order never matters — but **the two must stay in sync.** Avoid naming a new column with a
reserved alias (`Stop`, `Target`, `Exit`, `State`, `Stock`, `Ticker`, `Side`, `CBT`) or it will be
silently captured as an existing field.

Before trusting any change, re-run the invariant sweep in `PIPELINE.md` §5. It caught two real
bugs that reading the code did not.
