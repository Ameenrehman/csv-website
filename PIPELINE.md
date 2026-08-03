# Signal Tracking Pipeline — Design, Flow and Findings

How the daily orderbook P&L tracking works, what was discovered while building it, and how to
operate it. Companion to `README.md`, which is the shorter user-facing version.

Built 2026-08-03 against 64 orderbook files / 450 signals spanning 2026-04-30 → 2026-07-31.

---

## 1. Flow

```
1. SCANNER                orderbook/orderbook2026-08-04.csv
                          Symbol, Buy/Sell, CBT, Target Price   (4 columns, that's all)
                          you commit + push

2. CRON  11:00 UTC Mon–Fri   .github/workflows/daily-update.yml
   (decoupled from your push — runs on schedule, not on it)
         │
         ├─ checkout
         ├─ pip install -r requirements.txt
         ├─ python update_signals.py --commit --push
         │     ├─ scan orderbook/ for files with open rows
         │     ├─ one batched yfinance call: OHLC for every open symbol
         │     ├─ append 6 columns per new session to every open row,
         │     │  across ALL files, not just today's
         │     ├─ detect target/stop hits → Status, ExitPrice, ExitDate
         │     └─ atomic rewrite, LF endings
         └─ git commit + push to main
                  │
3. DASHBOARD  ◄───┘   app.js fetches CSVs from the GitHub API at page load.
                      NO DEPLOY STEP. Data is live on the next page refresh.

4. PAGES      .github/workflows/pages.yml — only when HTML/CSS/JS changes.
              Explicitly ignores orderbook/**, *.csv, **/*.md.
```

Two things that are commonly assumed and are **not** true here:

- **Pushing a CSV does not trigger the update.** The cron does, on its own schedule. The two are
  independent. Push new signals any time before the next day's run.
- **Pages is never rebuilt for data.** `app.js` reads CSVs live from the GitHub API, so a data
  commit shows up on refresh with no build at all. `pages.yml` exists only for the static shell.

A useful side effect: pushes made with `GITHUB_TOKEN` do not trigger other workflows, so the daily
data commit cannot start a Pages rebuild loop even by accident.

---

## 2. Schema

### Source (what the scanner emits)

| Column | Notes |
|---|---|
| `Symbol` | US-listed ticker, no exchange suffix |
| `Buy/Sell` | `Buy` = long, `Sell` = short. Drives the sign of every metric |
| `CBT` | Entry price. Position is treated as filled here on the signal date |
| `Target Price` | Take-profit level |
| `SL` | **Optional.** When absent or blank, only the target can close a row |

### Generated (created on first run, then maintained)

| Column | Notes |
|---|---|
| `Status` | `Open`, `TP Hit`, `SL Hit`, `Expired` |
| `ExitPrice` | Echoes the level's original precision when filled at the level |
| `ExitDate` | Session the row closed |

### Per-session block, appended while the row is open

| Column | Formula (long; short inverts) |
|---|---|
| `<date>_DayMaxProfit` | `(High − CBT) / CBT × 100` — that session only |
| `<date>_DayMaxLoss` | `(Low − CBT) / CBT × 100` — that session only |
| `<date>_MaxProfit` | running `max` of DayMaxProfit since entry (MFE) |
| `<date>_MaxLoss` | running `min` of DayMaxLoss since entry (MAE) |
| `<date>_MaxDrawdown` | running `min` of `DayMaxLoss − max(0, MaxProfit)` — always ≤ 0 |
| `<date>_CurrentPnL` | `(Close − CBT) / CBT × 100` |

For a `Sell` row the favourable end of the session is the **Low**, so `DayMaxProfit` uses
`(CBT − Low)` and `DayMaxLoss` uses `(CBT − High)`.

The drawdown peak includes entry itself (0%), which is why it can never be positive: a position
that has only ever lost money is drawn down from its entry, not from a nonexistent gain.

A closed row's cells stay blank from its exit day onward, so a file stops widening once every
signal in it is done.

---

## 3. Exit conventions

These were not arbitrary — the pre-existing demo CSVs already encoded the first rule, and the
other two were forced by real failures in the live data.

**Clamp to the level.** On the day a target or stop is touched, the extreme is recorded as the
level, not the raw bar high/low, because that is where the order filled. Confirmed against the
demo data, where all six closed rows matched their TP/SL exactly:

| Row | Entry → Exit | Recorded | Check |
|---|---|---|---|
| ICICIBANK | 1450 → 1510 | `4.14` | 60/1450 = 4.138% |
| SUNPHARMA | 1700 → 1770 | `4.12` | 70/1700 = 4.118% |
| NESTLEIND | 2450 → 2400 | `-2.04` | −50/2450 = −2.041% |
| AXISBANK | 1200 → 1170 | `-2.50` | −30/1200 = −2.5% |

**Gap-through fills at the open.** If the session opens already beyond the level, the order fills
on the first tick and the session collapses to that single point. See finding 6.1.

**Contested bars.** A single daily bar cannot say whether the target or the stop came first when
both were touched. `--tie` decides (default `sl`, the conservative read) and every affected row is
printed so it can be checked against intraday data.

**Unadjusted prices.** `auto_adjust=False` is set explicitly. yfinance defaults to adjusted
prices, which would silently drift historical highs and lows away from the `CBT` recorded at
signal time. A split in an open position still invalidates its entry — that is not solved here.

---

## 4. Design decisions

| Decision | Choice | Why |
|---|---|---|
| Metric set | Both per-day and running | Requested; removes the ambiguity described in 6.4 |
| Price source | yfinance daily OHLC | Free, no key, sufficient for excursions and touch detection |
| Stop loss | Read when present | Scanner will add it; pipeline works with or without |
| CBT | Filled on signal date | Signal's own session is skipped; tracking starts next session |
| Expiry | Never, by default | Chosen deliberately; `--max-hold N` available (see 7.3) |
| Layout | `orderbook/` subfolder | Discovery is recursive; date still parses from filename |
| File I/O | stdlib `csv`, not pandas | pandas coerces blanks to NaN and rewrites `1500` as `1500.0`, producing huge meaningless diffs on untouched rows |
| Writes | temp file + `os.replace` | Atomic; a crash mid-write cannot truncate a data file |
| Line endings | LF via `lineterminator` | Keeps git diffs clean on Windows |

---

## 5. Verification

All figures below are from a clean run over the real 450 signals.

| Check | Result |
|---|---|
| Ordering invariants | **40,422 metric cells, 0 violations** |
| Exit prices | **236 TP hits, 0 filled worse than target** |
| Idempotency | Immediate re-run left all 64 files **byte-identical** |
| Synthetic fixture | Long/short × TP/SL, gaps, contested bars, missing prices — every value matched hand-computed expectations |
| Legacy migration | `Direction` backfilled, running values seeded from mixed-convention history |
| Syntax | `update_signals.py`, `app.js`, both workflow YAMLs parse |

The nine invariants asserted on every cell:

```
DayMaxLoss ≤ DayMaxProfit             MaxProfit ≥ DayMaxProfit
MaxLoss    ≤ MaxProfit                MaxLoss   ≤ DayMaxLoss
MaxDrawdown ≤ 0                       MaxProfit monotonically non-decreasing
DayMaxLoss ≤ CurrentPnL ≤ DayMaxProfit
                                      MaxLoss monotonically non-increasing
                                      MaxDrawdown monotonically non-increasing
```

---

## 6. Findings

### 6.1 Gap-through fills produced impossible values — FIXED

`RKLB` (signalled 2026-04-30, entry 82.51, target 85.45) exited with:

```
DayMaxProfit = 3.56    DayMaxLoss = 4.07     ← loss exceeds profit
```

The stock **gapped up through its target**: the session's low (+4.07%) was already above the
target (+3.56%). Clamping the favourable extreme to the target while leaving the raw low untouched
inverted the pair. The real fill on a gap is the session open, not the target.

Now: when the open is already beyond the level, the fill is the open and that session collapses to
a single point (`DayMaxProfit = DayMaxLoss = CurrentPnL = open return`). Caught by the invariant
sweep, not by inspection — it affects only rows that gap, which is a small minority.

### 6.2 Exit prices rounded against short positions — FIXED

Formatting exit prices to 4 decimals made 45 short rows read fractionally *worse* than their own
targets — e.g. `CVI` target `31.698275954203737` written as `31.6983`. Maximum discrepancy
`0.000049`, so financially irrelevant, but a short filling above its target is nonsense on its
face and would fail any audit.

Now: when the fill is at the level, the level's original string is echoed verbatim. Only gap fills
and expiries are formatted.

### 6.3 app.js inverted returns on short positions — FIXED

`returnPct` was hardcoded `(exit − entry) / entry`. With the demo data (all long) this was
invisible. The real orderbook is **223 Sell / 227 Buy**, so roughly half of all rows would have
rendered with a flipped sign — every profitable short shown as a loss, corrupting win rate,
average return, best/worst leaderboards and every chart.

`app.js` now reads `Buy/Sell` and inverts for shorts.

### 6.4 The demo CSVs mix two incompatible conventions

`RELIANCE` runs `1.20 → 2.10 → 2.67` (monotonic, cumulative). `TCS` runs `0.80 → 1.50 → 2.00 →
1.20` (non-monotonic, per-day). The same column name means different things in different rows of
the same file, so those historical numbers cannot be interpreted with confidence.

Not fixable retroactively — the underlying per-day values are unrecoverable from a running series.
The six explicit columns remove the ambiguity going forward. `seed_running()` derives running
extremes by taking max/min over whatever is stored, which is correct under either reading.

### 6.5 Three upstream rows have targets on the wrong side of entry — NEEDS YOUR ATTENTION

| File | Symbol | Side | Entry | Target |
|---|---|---|---|---|
| `orderbook2026-07-02.csv` | META | Sell | 582.90 | 583.877 |
| `orderbook2026-07-09.csv` | RVLV | Buy | 23.13 | 23.11 |
| `orderbook2026-07-24.csv` | COHR | Sell | 282.39 | 285.427 |

A short whose target is *above* its entry, or a long whose target is *below* it, is satisfied the
instant it is evaluated. These are almost certainly scanner bugs. The pipeline reports them on
every run rather than silently booking free wins.

Aggregate target distances for context: Buy median **+8.26%** (range −0.09% to +42.27%), Sell
median **−6.63%** (range −30.94% to +1.08%). The signed extremes at each end are these rows.

### 6.6 `.gitlab-ci.yml` never deployed GitHub Pages

It is GitLab CI syntax and is inert on GitHub — it has been doing nothing. Pages has been running
off "Deploy from a branch". `pages.yml` now provides the GitHub Actions equivalent. The GitLab
file is kept for reference and can be deleted.

Related drift, now corrected: `README.md` documented `source: 'gitlab'` while `app.js` had been
switched to `'github'` some time ago.

### 6.7 Two orderbook files are header-only

`orderbook2026-06-24.csv` and `orderbook2026-07-21.csv` contain a header and no rows — days the
scanner produced nothing. Handled: they are skipped, not treated as errors.

### 6.8 Symbols recur across files

366 unique symbols across 450 rows; **73 appear in more than one file** (`WMS`, `CRM`, `PATH`,
`ADBE`, `VECO`, `TEX` each appear 3×). Each row is tracked as its own independent position, which
is correct — the same ticker can legitimately be signalled twice with different entries. Worth
knowing if you ever aggregate by symbol, because those are not one position.

---

## 7. Operations

### 7.1 Setup

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Linux/macOS: .venv/bin/pip
```

### 7.2 Daily commands

```bash
python update_signals.py                    # catch up to the latest close
python update_signals.py --dry-run          # show what would change, write nothing
python update_signals.py --date 2026-08-03  # one specific session
python update_signals.py --commit --push    # update, commit, push
```

Backfilling a fresh orderbook needs the lookback guard raised — it defaults to 30 days so a
routine run never accidentally refetches months of history:

```bash
python update_signals.py --max-lookback-days 120
```

### 7.3 Flags

| Flag | Default | Purpose |
|---|---|---|
| `--data-dir` | `orderbook/` | Directory of dated CSVs |
| `--suffix` | *(empty)* | yfinance ticker suffix; `.NS` for NSE |
| `--tie` | `sl` | Which level wins when a session touches both |
| `--max-lookback-days` | `30` | Cap on catch-up backfill |
| `--max-hold` | `0` | Close unresolved rows after N sessions (`0` = never) |
| `--offline-prices` | — | Read OHLC from a `Symbol,Date,Open,High,Low,Close` CSV |
| `--force` | off | Recompute sessions whose columns already exist |
| `--no-add-direction` | off | Skip inserting `Direction` into files lacking one |

### 7.4 Safety properties

- **Idempotent.** A session already present is skipped, so a retried, duplicated or overlapping
  job cannot corrupt data. Verified byte-identical on re-run.
- **Atomic writes.** Temp file plus `os.replace`; a crash cannot leave a truncated CSV.
- **Concurrency-guarded.** The workflow uses a `concurrency` group so two runs never rewrite the
  same files simultaneously.
- **Retried fetches.** yfinance is retried 3× with backoff; it is intermittently flaky on CI.
- **Fails safe on missing data.** A symbol with no bar is left blank and reported, never guessed.

### 7.5 Required one-time setup

`pages.yml` needs **Settings → Pages → Source = "GitHub Actions"**. If it is left on "Deploy from
a branch" the deploy step fails, because only one source can be active at a time. If you would
rather keep branch-deploy, delete `pages.yml` — everything else is unaffected.

---

## 8. Known limitations

**File growth is unbounded by design.** Signals never expire, so open rows accumulate 6 columns
per session forever. The widest file is already **367 columns**. Every visitor downloads every CSV
on first load, so this becomes a page-load problem before it becomes a storage problem.
`--max-hold 30` bounds it whenever you want; nothing else needs to change.

**Daily bars cannot resolve intraday ordering.** When one session touches both target and stop,
`--tie` guesses. Switching to 15-minute bars would resolve it properly, at the cost of yfinance's
~60-day history limit.

**Splits invalidate open positions.** Prices are fetched unadjusted so they match the recorded
`CBT`, but a split during an open position makes that `CBT` meaningless. Not detected.

**No position sizing.** Everything is percentages. There is no quantity, capital, or currency P&L
anywhere in the schema, so there is no portfolio-level equity curve — only per-signal returns.

**The five demo CSVs still count.** `2026-06-*.csv` at the repo root are synthetic and are mixed
into every dashboard aggregate. Delete them when you want the statistics to reflect only real
signals.
