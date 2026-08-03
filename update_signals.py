#!/usr/bin/env python3
"""Daily in-place updater for the signal CSVs served by the dashboard.

Each CSV in the data directory is named for the day its signals were issued
(``orderbook2026-04-30.csv``) and holds one row per signal.  The upstream
scanner only has to emit ``Symbol, Buy/Sell, CBT, Target Price``; the Status,
ExitPrice and ExitDate columns are created here on first run.

This script appends one block of six columns per trading day, for every row
that is still open:

    <date>_DayMaxProfit   best % move in favour, that session only
    <date>_DayMaxLoss     worst % move against, that session only
    <date>_MaxProfit      running best since entry  (MFE)
    <date>_MaxLoss        running worst since entry (MAE)
    <date>_MaxDrawdown    running worst decline from the running peak
    <date>_CurrentPnL     % at the close

Rows that have already hit TP or SL are left blank from their exit day
onward, so a file stops growing once every signal in it is closed.

All percentages are relative to CBT and direction-aware: a ``Sell`` row profits
when price falls.  On the day a target or stop is touched the extreme is
clamped to that level rather than the raw bar high/low, because that is where
the order would have filled -- unless price gapped straight through the level,
in which case the fill is the session open and the day collapses to a point.

A stop loss is optional: when the SL column is absent or blank, only the target
can close a row.

Only ``Symbol`` is strictly required by the dashboard; every other column
degrades gracefully.  Column lookup here is by name (matching app.js), so
column order is never load-bearing.

Usage
-----
    python update_signals.py                      # catch up to the latest close
    python update_signals.py --date 2026-08-03    # one specific session
    python update_signals.py --dry-run            # show the diff, write nothing
    python update_signals.py --commit --push      # update, commit and push
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# --------------------------------------------------------------------------
# Schema
# --------------------------------------------------------------------------

FILE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})\.csv$", re.IGNORECASE)

# Mirrors DAILY_RE in app.js, widened to the six metrics we now emit.
DAILY_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[_ ]?(.+)$")

# Order matters: this is the order columns are appended in each daily block.
METRICS = [
    "DayMaxProfit",
    "DayMaxLoss",
    "MaxProfit",
    "MaxLoss",
    "MaxDrawdown",
    "CurrentPnL",
]
METRIC_BY_KEY = {m.replace("_", "").lower(): m for m in METRICS}

# Canonical column -> accepted header spellings (lowercased).  Kept in sync
# with HEADER_ALIASES in app.js so the writer and the reader agree.
ALIASES = {
    "Symbol": ["symbol", "ticker", "stock"],
    # The orderbook expresses direction as Buy/Sell.
    "Direction": ["direction", "side", "dir", "buy/sell", "buysell", "buy / sell"],
    # CBT is the orderbook's fill price.
    "Entry": ["entry", "entry price", "entryprice", "entry_price", "cbt"],
    "SL": ["sl", "stop loss", "stoploss", "stop_loss", "stop"],
    "TP": ["tp", "target", "target price", "targetprice", "target_price", "tp price"],
    "Status": ["status", "state"],
    "ExitPrice": ["exit price", "exitprice", "exit_price", "exit"],
    "ExitDate": ["exit date", "exitdate", "exit_date"],
}

# Written into any source file that lacks them, so the orderbook generator
# only ever has to emit Symbol, Buy/Sell, CBT, Target Price (and optionally SL).
TRACKING_COLUMNS = ["Status", "ExitPrice", "ExitDate"]

NUM_CLEAN_RE = re.compile(r"[%,\s₹$]")


def num(value):
    """Parse a CSV cell to float, tolerating %, thousands commas and currency."""
    if value is None:
        return None
    text = NUM_CLEAN_RE.sub("", str(value))
    if not text:
        return None
    try:
        result = float(text)
    except ValueError:
        return None
    return result if result == result else None  # reject NaN


def fmt(value):
    if value is None:
        return ""
    return f"{0.0 if value == 0 else value:.2f}"  # avoid a signed "-0.00"


def fmt_price(value):
    """Prices keep up to 4 decimals, without trailing-zero noise."""
    return f"{value:.4f}".rstrip("0").rstrip(".")


def norm_status(value):
    """Classify a Status cell exactly the way app.js normStatus() does."""
    text = str(value or "").strip().lower()
    if text == "" or "open" in text or "active" in text:
        return "open"
    if "tp" in text or "target" in text:
        return "tp"
    if "sl" in text or "stop" in text:
        return "sl"
    return "closed"


def norm_direction(value):
    """Absent or unrecognised means long, matching normDirection() in app.js."""
    text = str(value or "").strip().lower()
    if text.startswith("sell") or text.startswith("short") or text == "-1":
        return "short"
    return "long"


# --------------------------------------------------------------------------
# CSV model
# --------------------------------------------------------------------------


class SignalFile:
    """A single ``YYYY-MM-DD.csv``, held as raw cells so nothing is reformatted.

    pandas is deliberately not used for the file round-trip: it would coerce
    blanks to NaN and rewrite ``1500`` as ``1500.0``, producing enormous and
    meaningless git diffs on rows the run never touched.
    """

    def __init__(self, path):
        self.path = Path(path)
        match = FILE_RE.search(self.path.name)
        self.signal_date = match.group(1) if match else None
        with self.path.open("r", encoding="utf-8-sig", newline="") as handle:
            rows = [r for r in csv.reader(handle) if any(c.strip() for c in r)]
        if not rows:
            raise ValueError(f"{self.path.name} is empty")
        self.headers = [h.strip() for h in rows[0]]
        width = len(self.headers)
        # Pad ragged rows so index access is always safe.
        self.rows = [r + [""] * (width - len(r)) for r in rows[1:]]
        self.dirty = False

    # -- column access -----------------------------------------------------

    def index_of(self, canonical):
        wanted = ALIASES[canonical]
        lower = [h.lower() for h in self.headers]
        for i, header in enumerate(lower):
            if header in wanted:
                return i
        return -1

    def get(self, row, canonical):
        i = self.index_of(canonical)
        return row[i].strip() if 0 <= i < len(row) else ""

    def set(self, row, canonical, value):
        i = self.index_of(canonical)
        if i < 0:
            raise KeyError(canonical)
        row[i] = value
        self.dirty = True

    def daily_columns(self):
        """-> {date: {metric: column index}} for every recognised daily column."""
        found = {}
        for i, header in enumerate(self.headers):
            match = DAILY_RE.match(header)
            if not match:
                continue
            metric = METRIC_BY_KEY.get(match.group(2).replace("_", "").replace(" ", "").lower())
            if metric:
                found.setdefault(match.group(1), {})[metric] = i
        return found

    def daily_dates(self):
        return sorted(self.daily_columns().keys())

    def first_daily_index(self):
        for i, header in enumerate(self.headers):
            match = DAILY_RE.match(header)
            if match and METRIC_BY_KEY.get(
                    match.group(2).replace("_", "").replace(" ", "").lower()):
                return i
        return len(self.headers)

    def ensure_columns(self, names, default=""):
        """Insert any missing columns just ahead of the first daily block."""
        at = self.first_daily_index()
        added = []
        for name in names:
            if self.index_of(name) >= 0:
                continue
            self.headers.insert(at, name)
            for row in self.rows:
                row.insert(at, default)
            at += 1
            added.append(name)
        if added:
            self.dirty = True
        return added

    def add_direction_column(self, default="LONG"):
        """Insert Direction after Symbol, defaulting existing rows to LONG.

        A no-op for the orderbook, whose Buy/Sell column already aliases to
        Direction; only the older demo CSVs need this.
        """
        if self.index_of("Direction") >= 0:
            return False
        at = self.index_of("Symbol") + 1
        self.headers.insert(at, "Direction")
        for row in self.rows:
            row.insert(at, default)
        self.dirty = True
        return True

    def append_day(self, date):
        """Append the six columns for ``date`` and return {metric: index}."""
        existing = self.daily_columns().get(date)
        if existing and len(existing) == len(METRICS):
            return existing
        indices = dict(existing or {})
        for metric in METRICS:
            if metric in indices:
                continue
            self.headers.append(f"{date}_{metric}")
            for row in self.rows:
                row.append("")
            indices[metric] = len(self.headers) - 1
        self.dirty = True
        return indices

    def write(self):
        """Atomically replace the file; LF endings keep git diffs clean."""
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle, lineterminator="\n")
                writer.writerow(self.headers)
                writer.writerows(self.rows)
            os.replace(tmp, self.path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise


# --------------------------------------------------------------------------
# Metric maths
# --------------------------------------------------------------------------


def ret_pct(price, entry, direction):
    """Return of ``price`` relative to ``entry``, signed for the direction."""
    if entry in (None, 0) or price is None:
        return None
    raw = (price - entry) / entry * 100.0
    return -raw if direction == "short" else raw


def session_metrics(bar, entry, direction):
    """Per-session excursions from one daily OHLC bar."""
    high = ret_pct(bar["High"], entry, direction)
    low = ret_pct(bar["Low"], entry, direction)
    close = ret_pct(bar["Close"], entry, direction)
    if direction == "short":
        # A short profits as price falls, so the session Low is the favourable end.
        high, low = low, high
    return high, low, close


def check_exit(bar, tp, sl, direction, tie):
    """-> ('tp'|'sl'|None, contested) for a single session.

    ``contested`` flags a bar that touched both levels; daily bars cannot say
    which came first, so the tie rule decides and the row is reported.
    """
    if direction == "short":
        tp_hit = tp is not None and bar["Low"] <= tp
        sl_hit = sl is not None and bar["High"] >= sl
    else:
        tp_hit = tp is not None and bar["High"] >= tp
        sl_hit = sl is not None and bar["Low"] <= sl
    if tp_hit and sl_hit:
        return tie, True
    if tp_hit:
        return "tp", False
    if sl_hit:
        return "sl", False
    return None, False


def seed_running(sf, row, dates):
    """Recover running MaxProfit / MaxLoss / MaxDrawdown from prior columns.

    Files written before this script existed carry only running MaxProfit and
    MaxLoss.  MaxDrawdown is reconstructed from those two series, which is the
    best available estimate without refetching the whole price history; from
    the first run onward it is carried forward exactly.
    """
    cols = sf.daily_columns()
    best = worst = drawdown = None
    for date in dates:
        idx = cols.get(date, {})
        stored_dd = num(row[idx["MaxDrawdown"]]) if "MaxDrawdown" in idx else None
        profit = num(row[idx["MaxProfit"]]) if "MaxProfit" in idx else None
        loss = num(row[idx["MaxLoss"]]) if "MaxLoss" in idx else None
        if profit is not None:
            best = profit if best is None else max(best, profit)
        if loss is not None:
            worst = loss if worst is None else min(worst, loss)
        if stored_dd is not None:
            drawdown = stored_dd if drawdown is None else min(drawdown, stored_dd)
        elif loss is not None:
            # Peak includes entry itself (0%), so drawdown is never positive.
            candidate = loss - max(0.0, best if best is not None else 0.0)
            drawdown = candidate if drawdown is None else min(drawdown, candidate)
    return best, worst, drawdown


# --------------------------------------------------------------------------
# Price source
# --------------------------------------------------------------------------


def fetch_prices_yf(symbols, start, end, suffix):
    """Batch one yfinance call -> {symbol: {date: {Open,High,Low,Close}}}."""
    import pandas as pd
    import yfinance as yf

    tickers = {f"{s}{suffix}": s for s in symbols}
    frame = None
    for attempt in range(3):  # yfinance is intermittently flaky on CI runners
        try:
            frame = yf.download(
                tickers=list(tickers),
                start=start.isoformat(),
                end=(end + dt.timedelta(days=1)).isoformat(),  # end is exclusive
                interval="1d",
                group_by="ticker",
                auto_adjust=False,  # entries were recorded at unadjusted prices
                progress=False,
                threads=True,
            )
            break
        except Exception as exc:  # noqa: BLE001 - network layer raises broadly
            if attempt == 2:
                raise
            print(f"! yfinance attempt {attempt + 1} failed ({exc}); retrying")
            time.sleep(5 * (attempt + 1))
    out = {}
    if frame is None or frame.empty:
        return out
    for ticker, symbol in tickers.items():
        if isinstance(frame.columns, pd.MultiIndex):
            if ticker not in frame.columns.get_level_values(0):
                continue
            sub = frame[ticker]
        else:
            sub = frame  # single-ticker download returns flat columns
        sub = sub.dropna(subset=["High", "Low", "Close"])
        bars = {}
        for stamp, bar in sub.iterrows():
            bars[stamp.date().isoformat()] = {
                "Open": float(bar["Open"]),
                "High": float(bar["High"]),
                "Low": float(bar["Low"]),
                "Close": float(bar["Close"]),
            }
        if bars:
            out[symbol] = bars
    return out


def fetch_prices_csv(path):
    """Offline source: a CSV of Symbol,Date,Open,High,Low,Close."""
    out = {}
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        for record in csv.DictReader(handle):
            keyed = {k.strip().lower(): v for k, v in record.items() if k}
            symbol = (keyed.get("symbol") or "").strip()
            date = (keyed.get("date") or "").strip()
            if not symbol or not date:
                continue
            try:
                bar = {f: float(keyed[f.lower()]) for f in ("Open", "High", "Low", "Close")}
            except (KeyError, TypeError, ValueError):
                continue
            out.setdefault(symbol, {})[date] = bar
    return out


# --------------------------------------------------------------------------
# Main update
# --------------------------------------------------------------------------


def process(args):
    data_dir = Path(args.data_dir).resolve()
    files = sorted(p for p in data_dir.glob("*.csv") if FILE_RE.search(p.name))
    if not files:
        print(f"No YYYY-MM-DD.csv files found in {data_dir}")
        return 0, []

    loaded, open_symbols, earliest = [], set(), None
    degenerate = []
    for path in files:
        try:
            sf = SignalFile(path)
        except ValueError as exc:
            print(f"  {path.name}: skipped ({exc})")
            continue
        if not sf.rows:
            continue  # header-only: a day the scanner produced no signals
        if args.add_direction:
            sf.add_direction_column()
        sf.ensure_columns(TRACKING_COLUMNS)
        # Spell "Open" out rather than leaving the cell blank.  Both readers
        # treat blank as open, but a self-describing file is worth the bytes.
        for row in sf.rows:
            if sf.get(row, "Symbol") and not sf.get(row, "Status"):
                sf.set(row, "Status", "Open")
        has_open = False
        for row in sf.rows:
            symbol = sf.get(row, "Symbol")
            if not symbol:
                continue
            if norm_status(sf.get(row, "Status")) == "open":
                has_open = True
                open_symbols.add(symbol)
                entry, tp = num(sf.get(row, "Entry")), num(sf.get(row, "TP"))
                direction = norm_direction(sf.get(row, "Direction"))
                # A target on the wrong side of entry fills the instant it is
                # checked, which is almost always a bad upstream row.
                if entry and tp is not None and (
                        (direction == "long" and tp <= entry)
                        or (direction == "short" and tp >= entry)):
                    degenerate.append((path.name, symbol, direction, entry, tp))
        if not has_open:
            # Every signal closed: file is final, but still persist a
            # Direction backfill if one was just inserted.
            if sf.dirty and not args.dry_run:
                sf.write()
            print(f"  {path.name}: all signals closed, skipping")
            continue
        seen = sf.daily_dates()
        last = seen[-1] if seen else sf.signal_date
        if last and (earliest is None or last < earliest):
            earliest = last
        loaded.append(sf)

    if not loaded:
        print("Nothing open to update.")
        return 0, []

    # Window: the day after the most stale file, bounded by --max-lookback-days.
    start = dt.date.fromisoformat(earliest) + dt.timedelta(days=1)
    end = dt.date.fromisoformat(args.date) if args.date else dt.date.today()
    floor = end - dt.timedelta(days=args.max_lookback_days)
    if start < floor:
        print(f"! Oldest open file trails {start}; clamping to {floor} "
              f"(raise --max-lookback-days to backfill further)")
        start = floor
    # Deliberately not an early return: schema work done during load (new
    # tracking columns, Direction, an explicit Open status) must still be
    # written even when there is no new session to apply.
    prices, sessions = {}, []
    if start > end:
        print(f"Already current through {end}.")
    else:
        print(f"Fetching {len(open_symbols)} symbols, {start} -> {end}")
        if args.offline_prices:
            prices = fetch_prices_csv(args.offline_prices)
        else:
            prices = fetch_prices_yf(sorted(open_symbols), start, end, args.suffix)

        missing = sorted(open_symbols - set(prices))
        if missing:
            print(f"! No price data for {len(missing)} symbol(s): {', '.join(missing[:10])}"
                  + (" ..." if len(missing) > 10 else ""))

        sessions = sorted({d for bars in prices.values() for d in bars
                           if start.isoformat() <= d <= end.isoformat()})
        if sessions:
            print(f"Sessions to apply: {', '.join(sessions)}")
        else:
            print("No trading sessions in range (weekend or holiday?).")

    changed, contested, exits = [], [], []
    for sf in loaded:
        applied = 0
        for date in sessions:
            if sf.signal_date and date <= sf.signal_date:
                continue  # a signal cannot have a session before it was issued
            if date in sf.daily_columns() and not args.force:
                continue
            if apply_session(sf, date, prices, args, contested, exits):
                applied += 1
        if sf.dirty:
            if not args.dry_run:
                sf.write()
            changed.append(sf.path)
            print(f"  {sf.path.name}: "
                  + (f"+{applied} session(s)" if applied else "schema update only"))

    for symbol, date, why in exits:
        print(f"  exit  {symbol} {why} on {date}")
    if degenerate:
        print(f"! {len(degenerate)} open row(s) have a target on the wrong side "
              f"of entry and will resolve on the first session checked:")
        for name, symbol, direction, entry, tp in degenerate[:10]:
            print(f"    {name} {symbol} {direction} entry={entry:g} tp={tp:g}")
    if contested:
        print(f"! {len(contested)} row(s) touched TP and SL in the same session; "
              f"resolved as '{args.tie}' per --tie. Verify with intraday data:")
        for symbol, date in contested:
            print(f"    {symbol} {date}")
    return len(changed), changed


def apply_session(sf, date, prices, args, contested, exits):
    """Write one day's block into every still-open row.  -> True if anything set.

    Values are computed before any column is appended, so a session with no
    data for this file (holiday, every symbol delisted) leaves it untouched
    rather than tacking on six empty columns.
    """
    prior = [d for d in sf.daily_dates() if d < date]
    pending = []
    for row in sf.rows:
        symbol = sf.get(row, "Symbol")
        if not symbol or norm_status(sf.get(row, "Status")) != "open":
            continue  # closed rows stay blank from their exit day onward
        bar = prices.get(symbol, {}).get(date)
        if not bar:
            continue
        entry = num(sf.get(row, "Entry"))
        if not entry:
            continue
        direction = norm_direction(sf.get(row, "Direction"))
        tp_raw, sl_raw = sf.get(row, "TP"), sf.get(row, "SL")
        tp, sl = num(tp_raw), num(sl_raw)

        best, worst, drawdown = seed_running(sf, row, prior)
        day_high, day_low, close = session_metrics(bar, entry, direction)
        hit, both = check_exit(bar, tp, sl, direction, args.tie)
        if both:
            contested.append((symbol, date))

        exit_status = exit_text = None
        if hit:
            level = tp if hit == "tp" else sl
            level_ret = ret_pct(level, entry, direction)
            open_ret = ret_pct(bar["Open"], entry, direction)
            gapped = open_ret >= level_ret if hit == "tp" else open_ret <= level_ret
            if gapped:
                # Price opened beyond the level: the order fills at the open on
                # the first tick, so the session collapses to that single point.
                exit_text = fmt_price(bar["Open"])
                day_high = day_low = close = open_ret
            else:
                # Echo the level exactly as the source wrote it; reformatting
                # can round a short's fill to look worse than its own target.
                exit_text = (tp_raw if hit == "tp" else sl_raw).strip()
                close = level_ret
                if hit == "tp":
                    # Ran until the target printed; the low may have come first.
                    day_high, day_low = level_ret, min(day_low, level_ret)
                else:
                    day_low, day_high = level_ret, max(day_high, level_ret)
            exit_status = "TP Hit" if hit == "tp" else "SL Hit"
        elif args.max_hold and len(prior) + 1 >= args.max_hold:
            # Held the full window without resolving: close at this session.
            exit_status, exit_text = "Expired", fmt_price(bar["Close"])

        best = day_high if best is None else max(best, day_high)
        worst = day_low if worst is None else min(worst, day_low)
        # The peak includes entry itself (0%), so drawdown is never positive.
        candidate = day_low - max(0.0, best)
        drawdown = candidate if drawdown is None else min(drawdown, candidate)

        pending.append((row, {
            "DayMaxProfit": day_high, "DayMaxLoss": day_low,
            "MaxProfit": best, "MaxLoss": worst,
            "MaxDrawdown": drawdown, "CurrentPnL": close,
        }, exit_status, exit_text, symbol))

    if not pending:
        return False

    indices = sf.append_day(date)
    for row, values, exit_status, exit_text, symbol in pending:
        for metric, value in values.items():
            row[indices[metric]] = fmt(value)
        if exit_status:
            sf.set(row, "Status", exit_status)
            sf.set(row, "ExitPrice", exit_text)
            sf.set(row, "ExitDate", date)
            exits.append((symbol, date, exit_status))
    sf.dirty = True
    return True


# --------------------------------------------------------------------------
# Git
# --------------------------------------------------------------------------


def git(args_list, cwd):
    return subprocess.run(["git"] + args_list, cwd=str(cwd),
                          capture_output=True, text=True)


def commit_and_push(paths, repo, message, push):
    result = git(["add", "--"] + [str(p) for p in paths], repo)
    if result.returncode:
        print(f"git add failed: {result.stderr.strip()}", file=sys.stderr)
        return 1
    if not git(["diff", "--cached", "--quiet"], repo).returncode:
        print("No staged changes; nothing to commit.")
        return 0
    result = git(["commit", "-m", message], repo)
    if result.returncode:
        print(f"git commit failed: {result.stderr.strip()}", file=sys.stderr)
        return 1
    print(f"Committed: {message}")
    if not push:
        print("Not pushed (pass --push).")
        return 0
    result = git(["push"], repo)
    if result.returncode:
        print(f"git push failed: {result.stderr.strip()}", file=sys.stderr)
        return 1
    print("Pushed to origin. The dashboard reads CSVs live, so it updates on next load.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Append daily P&L columns to open signal CSVs, in place.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--data-dir", default=str(Path(__file__).parent / "orderbook"),
                        help="directory holding the dated orderbook CSVs")
    parser.add_argument("--date", help="process up to this session (default: today)")
    parser.add_argument("--suffix", default="",
                        help="exchange suffix for yfinance tickers; the orderbook "
                             "is US-listed so this is empty by default (use .NS for NSE)")
    parser.add_argument("--max-hold", type=int, default=0,
                        help="close an unresolved signal after this many tracked "
                             "sessions (default 0 = never expire)")
    parser.add_argument("--tie", choices=["sl", "tp"], default="sl",
                        help="which level wins when one session touches both "
                             "(default: sl, the conservative read)")
    parser.add_argument("--max-lookback-days", type=int, default=30,
                        help="cap on how far back a catch-up run will backfill")
    parser.add_argument("--offline-prices",
                        help="read OHLC from a Symbol,Date,Open,High,Low,Close CSV "
                             "instead of yfinance")
    parser.add_argument("--force", action="store_true",
                        help="recompute sessions whose columns already exist")
    parser.add_argument("--no-add-direction", dest="add_direction",
                        action="store_false",
                        help="do not insert a Direction column into files lacking one")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would change without writing")
    parser.add_argument("--commit", action="store_true", help="git commit the changes")
    parser.add_argument("--push", action="store_true",
                        help="git push after committing (implies --commit)")
    args = parser.parse_args(argv)
    if args.push:
        args.commit = True

    count, changed = process(args)
    if args.dry_run:
        print(f"\nDry run: {count} file(s) would change.")
        return 0
    if not count:
        return 0
    print(f"\nUpdated {count} file(s).")
    if args.commit:
        stamp = args.date or dt.date.today().isoformat()
        return commit_and_push(changed, Path(args.data_dir).resolve(),
                               f"data: daily signal update {stamp}", args.push)
    return 0


if __name__ == "__main__":
    sys.exit(main())
