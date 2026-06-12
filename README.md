# Trading Signals Dashboard

A fully static, professional trading analytics dashboard that visualizes trading signals stored as CSV files in this repository. No backend required: the site reads the CSVs live via the GitLab API directly in the browser.

## How it works

- One CSV file per signal date (e.g. `2026-06-14.csv`), stored anywhere in this repository.
- Each CSV is published with new trade calls and updated daily until all trades are closed.
- While a trade is open, daily columns are appended: `YYYY-MM-DD_MaxProfit` and `YYYY-MM-DD_MaxLoss`.
- The dashboard automatically discovers all `.csv` files, parses the dynamic date columns, and computes all analytics client-side.
- New or modified CSVs are picked up automatically on the next page load. **No redeploy is needed for data changes.**

## CSV format

| Column | Description |
|---|---|
| `Symbol` | Instrument symbol |
| `Entry` | Entry price |
| `SL` | Stop loss price |
| `TP` | Target price |
| `Status` | `Open`, `TP Hit`, `SL Hit`, or `Closed` |
| `Exit Price` | Filled when the trade closes |
| `Exit Date` | Filled when the trade closes |
| `YYYY-MM-DD_MaxProfit` | Max favorable move (%) on that day (appended daily while open) |
| `YYYY-MM-DD_MaxLoss` | Max adverse move (%) on that day (appended daily while open) |

The signal date is taken from the filename (`YYYY-MM-DD.csv`).

## Pages

- `index.html` - KPI dashboard, active signal summary, open-trade age chart, latest trading days (incremental loading), performance charts, analytics, leaderboards, repository activity, transparency section.
- `active-signals.html` - Live watchlist of all open trades with search, sorting, filtering, pagination, and CSV export.
- `signals.html` - Browser for every CSV file with per-file statistics and expandable signal tables.
- Clicking any trade opens a detail modal with daily performance table and an interactive Max Profit / Max Loss progression chart.

## Deployment (GitLab Pages)

1. Merge to the default branch. The included `.gitlab-ci.yml` copies the static files into `public/` and publishes them.
2. After the first successful pipeline, the site is available at:
   `https://devops26071-group.gitlab.io/csv-website/`
   (see **Deploy > Pages** in the project for the exact URL).
3. The project must be **public** (or Pages access configured) so the GitLab API can be read anonymously by visitors' browsers.

## Configuration

All data-source settings live at the top of `app.js` in the `CONFIG` object:

```js
const CONFIG = {
  source: 'gitlab',              // 'gitlab' or 'github'
  gitlab: { baseUrl: 'https://gitlab.com', projectPath: 'devops26071-group/csv-website', ref: 'main' },
  github: { owner: 'YOUR_USER', repo: 'YOUR_REPO', branch: 'main' },
};
```

## Migrating to GitHub Pages later

The data layer is abstracted behind a `DataSource` adapter in `app.js`. To migrate:

1. Push the same files to a GitHub repository and enable GitHub Pages.
2. In `app.js`, set `CONFIG.source = 'github'` and fill in `CONFIG.github` (owner, repo, branch).
3. Delete `.gitlab-ci.yml` (GitHub Pages serves files directly).

Everything else works unchanged.

## Performance

- File contents are cached in `localStorage`, keyed by each file's git blob SHA, so unchanged CSVs are never re-downloaded.
- Files are fetched with bounded concurrency; tables are paginated and the homepage loads day sections incrementally.
