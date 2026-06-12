# Data Analysis Reporter

A small Node application for uploading CSV and Excel files and automatically generating an analysis report.

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Open:

```text
http://localhost:7000
```

## Deploy to Vercel

This project includes a Vercel serverless function at:

```text
api/analyze.js
```

Deploy with the Vercel CLI or by importing the repository in Vercel. The static UI is served from `public/`, and uploads are handled by `POST /api/analyze`.

## Features

- Upload `.csv`, `.xls`, and `.xlsx` files from the browser.
- Automatic row, column, missing-value, and data-type summary.
- Per-column profiles for numeric, date, and category fields.
- Numeric statistics including min, quartiles, median, average, max, and standard deviation.
- Top numeric correlations.
- Graph analysis for missing values, numeric distributions, category breakdowns, and correlations.
- Month range controls for branch-wise sales review. If the file has no transaction date column, the app uses the month inferred from the workbook title when available.
- Excel title/header detection for summary-style sales statements.
- Power BI-style dashboard layout with KPI cards, branch charts, notes, and branch-wise detail.
- Sample row preview.
- JSON report export.

## Sample Data

A sample file is included at:

```text
samples/sample-sales.csv
```

## Notes

- Excel parsing uses the `xlsx` package.
- Maximum upload size is 25 MB.
- Generated report JSON files are stored in `reports/`.
