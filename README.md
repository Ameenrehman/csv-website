# Trading Signals Dashboard

A fully static trading analytics dashboard that visualizes signals stored as CSV files in this
repository. No backend: the site reads the CSVs live via the GitHub API directly in the browser.

## How it works

- `orderbook/` is the source of truth. One CSV per signal date, named `orderbookYYYY-MM-DD.csv`,
  produced daily by the upstream scanner.
- `update_signals.py` runs after each US close, appends that session's P&L columns to every row
  that is still open, and marks rows that reached their target.
- The dashboard discovers every `.csv` in the repo tree, parses the dynamic date columns, and
  computes all analytics client-side.
- New or modified CSVs are picked up on the next page load. **No redeploy is needed for data
  changes** — only for changes to the HTML/CSS/JS shell.

## CSV format

The scanner only has to emit the first four columns. Everything else is added and maintained by
`update_signals.py`.

| Column | Description |
|---|---|
| `Symbol` | Ticker (US-listed; no exchange suffix) |
| `Buy/Sell` | `Buy` = long, `Sell` = short. Drives the sign of every metric below |
| `CBT` | Entry price. The position is treated as filled here on the signal date |
| `Target Price` | Take-profit level |
| `SL` | Stop loss. Optional — when absent or blank, only the target can close a row |
| `Status` | `Open`, `TP Hit`, `SL Hit`, or `Expired` |
| `ExitPrice` / `ExitDate` | Filled when the row closes |

Then six columns per tracked session, appended while the row is open:

| Column | Description |
|---|---|
| `<date>_DayMaxProfit` | Best % move in favour, that session only |
| `<date>_DayMaxLoss` | Worst % move against, that session only |
| `<date>_MaxProfit` | Running best since entry (MFE) |
| `<date>_MaxLoss` | Running worst since entry (MAE) |
| `<date>_MaxDrawdown` | Running worst decline from the running peak (always ≤ 0) |
| `<date>_CurrentPnL` | % at the close |

All percentages are relative to `CBT` and direction-aware: a `Sell` row profits when price falls.
Once a row closes, its cells stay blank from the exit day onward, so a file stops growing when
every signal in it is closed. The signal date comes from the filename.

### Exit conventions

- A target/stop counts as hit when the session's High (or Low, for a short) reaches the level.
- On the exit day the extreme is clamped to the level rather than the raw bar, because that is
  where the order would have filled.
- If price **gaps** through the level — the session opens already beyond it — the fill is the
  open, not the level, and that session collapses to a single point.
- If one session touches both the target and the stop, daily bars cannot say which came first.
  `--tie` decides (default `sl`, the conservative read) and every affected row is printed so you
  can check it against intraday data.

## The daily updater

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt        # Linux/macOS: .venv/bin/pip

python update_signals.py                              # catch up to the latest close
python update_signals.py --dry-run                    # show what would change
python update_signals.py --date 2026-08-03            # one specific session
python update_signals.py --commit --push              # update, commit and push
```

Useful flags:

| Flag | Default | Purpose |
|---|---|---|
| `--data-dir` | `orderbook/` | Directory of dated CSVs |
| `--suffix` | *(empty)* | yfinance ticker suffix; use `.NS` for NSE |
| `--tie` | `sl` | Which level wins when a session touches both |
| `--max-lookback-days` | `30` | Cap on how far back a catch-up run backfills |
| `--max-hold` | `0` | Close unresolved rows after N sessions (`0` = never expire) |
| `--offline-prices` | — | Read OHLC from a `Symbol,Date,Open,High,Low,Close` CSV instead of yfinance |
| `--force` | off | Recompute sessions whose columns already exist |

The script is idempotent: re-running for a session that is already present is a no-op, so a
retried or duplicated job cannot corrupt the data. Prices are fetched unadjusted so they stay
comparable to the `CBT` recorded at signal time.

To backfill a brand-new orderbook from scratch, raise the lookback:

```bash
python update_signals.py --max-lookback-days 120
```

## Automation

| Workflow | Trigger | Does |
|---|---|---|
| `.github/workflows/daily-update.yml` | Push to `orderbook/**`, 11:00 UTC Mon–Fri, or manual | Runs the updater, commits, pushes |
| `.github/workflows/pages.yml` | Push to `main` (data commits ignored) | Publishes the site to GitHub Pages |

To run the updater by hand without committing anything: **Actions → Daily signal update → Run
workflow**, with `dry_run` set to `true`. It performs the whole job and reports what it would
change.

The updater cannot re-trigger itself: its own commit is pushed with `GITHUB_TOKEN`, and
`GITHUB_TOKEN` pushes never start workflows.

`pages.yml` requires **Settings → Pages → Source = "GitHub Actions"**. If it is left on
"Deploy from a branch", the deploy step fails — only one source can be active.

`.gitlab-ci.yml` is GitLab-only syntax and does nothing on GitHub. It is kept for reference and
can be deleted.

## Adding new signals

**Add new dated files. Never overwrite one the pipeline has already written to.**

```
orderbook/orderbook2026-08-04.csv    new file, 4 columns   -> safe
orderbook/orderbook2026-05-06.csv    already tracked       -> do not touch
```

The updater is additive: it appends the newest session and never re-derives the past. Once a file
carries tracking columns, that file *is* the record of its own history. Overwriting it with fresh
scanner output destroys that history, and only the last `--max-lookback-days` of it can be
rebuilt — so exits that happened earlier are lost or, worse, re-dated to whatever the price did
inside the shortened window. The script warns loudly (`! Oldest open file trails …`) when it has
to clamp, which is the signal that a tracked file was reset.

A newly added file is picked up on push, and starts accumulating columns from the **next**
session — its own signal day is skipped, because the position opens at `CBT` that day.

## Pages

- `index.html` — KPI dashboard, active signal summary, open-trade age chart, latest trading days,
  performance charts, analytics, leaderboards, repository activity.
- `active-signals.html` — Live watchlist of open trades showing side, current P&L, the latest
  session's day max profit/loss, the running max profit/loss and max drawdown; every column
  sortable, plus search, pagination and CSV export.
- `signals.html` — Browser for every CSV file with per-file statistics.
- Clicking any trade opens a detail modal with the full six-metric daily table and a progression
  chart.

## Configuration

Data-source settings live at the top of `app.js`:

```js
const CONFIG = {
  source: 'github',              // 'gitlab' or 'github'
  github: { owner: 'Ameenrehman', repo: 'csv-website', branch: 'main' },
};
```

Column lookup is by name, not position, so columns can be reordered or added freely. Avoid naming
a new column with a reserved alias (`Stop`, `Target`, `Exit`, `State`, `Stock`, `Ticker`, `Side`,
`CBT`) or it will be captured as one of the known fields.

## Performance

- File contents are cached in `localStorage`, keyed by each file's git blob SHA, so unchanged CSVs
  are never re-downloaded.
- Files are fetched with bounded concurrency; tables are paginated and the homepage loads day
  sections incrementally.
- Note that every visitor downloads every CSV on first load. Signals never expire by default, so
  long-running files keep widening by six columns per session; if load time becomes a problem,
  set `--max-hold` to bound it.

## Current data

64 files, 450 signals, 2026-04-30 → 2026-07-31. **227 Buy / 223 Sell**, **236 TP Hit / 214 Open**.

The five synthetic `2026-06-*.csv` demo files that used to sit at the repo root have been removed,
so every dashboard statistic now reflects real signals only. `app.js` still understands that older
NSE-style layout (`Entry`/`SL`/`TP` with no `Buy/Sell`), so dropping such a file back in would
still render correctly.
