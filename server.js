const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 7000);
const PUBLIC_DIR = path.join(__dirname, "public");
const REPORT_DIR = path.join(__dirname, "reports");
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function ensureReportDir() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload), "application/json; charset=utf-8");
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, "Not found");
      return;
    }
    send(res, 200, data, mimeTypes[path.extname(filePath)] || "application/octet-stream");
  });
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error("Upload is larger than the 25 MB limit."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!boundaryMatch) throw new Error("Missing multipart boundary.");

  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  const fields = {};
  let file = null;
  let position = 0;

  while (position < buffer.length) {
    const boundaryStart = buffer.indexOf(boundary, position);
    if (boundaryStart === -1) break;

    let partStart = boundaryStart + boundary.length;
    if (buffer[partStart] === 45 && buffer[partStart + 1] === 45) break;
    if (buffer[partStart] === 13 && buffer[partStart + 1] === 10) partStart += 2;

    const nextBoundary = buffer.indexOf(boundary, partStart);
    if (nextBoundary === -1) break;

    let partEnd = nextBoundary;
    if (buffer[partEnd - 2] === 13 && buffer[partEnd - 1] === 10) partEnd -= 2;

    const part = buffer.subarray(partStart, partEnd);
    const splitAt = part.indexOf(headerSeparator);
    if (splitAt === -1) {
      position = nextBoundary;
      continue;
    }

    const rawHeaders = part.subarray(0, splitAt).toString("utf8");
    const fileBuffer = part.subarray(splitAt + headerSeparator.length);

    const dispositionLine = rawHeaders.split(/\r?\n/).find((line) => /^content-disposition:/i.test(line)) || "";
    const disposition = /(?:^|;)\s*name="([^"]+)"/i.exec(dispositionLine);
    if (!disposition) {
      position = nextBoundary;
      continue;
    }

    const fieldName = disposition[1];
    const filenameMatch = /(?:^|;)\s*filename="([^"]*)"/i.exec(dispositionLine);

    if (fieldName === "file") {
      file = {
        filename: filenameMatch ? path.basename(filenameMatch[1]) : "upload.csv",
        buffer: fileBuffer,
        text: fileBuffer.toString("utf8").replace(/^\uFEFF/, ""),
      };
    } else {
      fields[fieldName] = fileBuffer.toString("utf8").trim();
    }

    position = nextBoundary;
  }

  if (!file) throw new Error("No upload field named \"file\" was found.");
  return { file, fields };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }

  row.push(value);
  if (row.some((cell) => cell.trim() !== "") || rows.length === 0) rows.push(row);

  const headers = rows.shift()?.map((header, index) => {
    const clean = header.trim();
    return clean || `Column ${index + 1}`;
  }) || [];

  const records = rows
    .filter((cells) => cells.some((cell) => cell.trim() !== ""))
    .map((cells) => headers.map((_, index) => cells[index] ?? ""));

  return { headers, records, metadata: { sourceType: "csv" } };
}

function parseWorkbook(buffer) {
  let XLSX;
  try {
    XLSX = require("xlsx");
  } catch {
    throw new Error("Excel upload support requires the xlsx package. Run npm install, then restart the app.");
  }

  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    dense: true,
  });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("The workbook does not contain any worksheets.");

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
    raw: false,
  });

  if (!rows.length) return { headers: [], records: [], metadata: { sourceType: "workbook", sheetName } };

  const title = String(rows[0]?.find((cell) => !isBlank(cell)) || "").trim();
  const headerRowIndex = detectHeaderRowIndex(rows);
  const dataRows = rows.slice(headerRowIndex + 1);
  const width = Math.max(...[rows[headerRowIndex], ...dataRows].map((row) => row.length));
  const rawHeaders = Array.from({ length: width }, (_, index) => String(rows[headerRowIndex]?.[index] ?? "").trim());
  const headers = rawHeaders.map((header, index) => header || (index === 0 ? "No" : `Column ${index + 1}`));

  let records = dataRows
    .filter((row) => row.some((cell) => !isBlank(cell)))
    .map((row) => headers.map((_, index) => String(row[index] ?? "")));

  const activeColumnIndexes = headers
    .map((header, index) => ({ header, index }))
    .filter(({ index }) => !isBlank(rawHeaders[index]) || records.some((row) => !isBlank(row[index])))
    .map(({ index }) => index);

  const trimmedHeaders = activeColumnIndexes.map((index) => headers[index]);
  records = records.map((row) => activeColumnIndexes.map((index) => row[index]));
  const summaryRows = records
    .filter((row) => isSummaryRow(row))
    .map((row) => Object.fromEntries(trimmedHeaders.map((header, index) => [header, row[index] ?? ""])));
  records = records.filter((row) => !isSummaryRow(row));

  return {
    headers: trimmedHeaders,
    records,
    metadata: {
      sourceType: "workbook",
      sheetName,
      title,
      headerRow: headerRowIndex + 1,
      summaryRows,
      inferredPeriod: inferPeriod(title),
    },
  };
}

function isSummaryRow(row) {
  const firstCell = String(row[0] || "").trim();
  const label = row.map((cell) => String(cell || "")).join(" ").toLowerCase();
  return !firstCell && /total|subtotal|grand total|sale\s*&\s*stock|summary/.test(label);
}

function detectHeaderRowIndex(rows) {
  const candidates = rows.slice(0, Math.min(rows.length, 20)).map((row, index) => {
    const textCells = row.filter((cell) => /[a-z]/i.test(String(cell))).length;
    const filledCells = row.filter((cell) => !isBlank(cell)).length;
    return { index, score: textCells * 3 + filledCells };
  });
  return candidates.sort((a, b) => b.score - a.score)[0]?.index || 0;
}

function inferPeriod(text) {
  const months = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };
  const match = String(text || "").match(new RegExp(`(${Object.keys(months).join("|")})\\s*[-, ]+\\s*(20\\d{2})`, "i"));
  if (!match) return null;
  const month = months[match[1].toLowerCase()];
  const year = Number(match[2]);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return {
    label: `${match[1]} ${year}`,
    year,
    month,
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function parseUpload(file) {
  const extension = path.extname(file.filename).toLowerCase();

  if (extension === ".csv") {
    return parseCsv(file.text);
  }

  if (extension === ".xls" || extension === ".xlsx") {
    return parseWorkbook(file.buffer);
  }

  throw new Error("Please upload a .csv, .xls, or .xlsx file.");
}

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

function toNumber(value) {
  if (isBlank(value)) return null;
  const normalized = String(value).replace(/[$,%\s]/g, "").replace(/,/g, "");
  if (normalized === "") return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function toDate(value) {
  if (isBlank(value)) return null;
  if (typeof value === "number" && value > 20000 && value < 80000) {
    return new Date(Date.UTC(1899, 11, 30 + value));
  }
  const text = String(value).trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return null;
  if (!/\d{1,4}[-/]\d{1,2}|\d{1,2}[-/]\d{1,4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(text)) {
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateKey(value) {
  const date = toDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(numbers, p) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function histogram(numbers, bucketCount = 8) {
  if (!numbers.length) return [];
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);

  if (min === max) {
    return [{ label: formatNumber(min), min, max, count: numbers.length }];
  }

  const width = (max - min) / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const start = min + width * index;
    const end = index === bucketCount - 1 ? max : start + width;
    return {
      label: `${formatNumber(start)} - ${formatNumber(end)}`,
      min: start,
      max: end,
      count: 0,
    };
  });

  for (const number of numbers) {
    const index = Math.min(bucketCount - 1, Math.floor((number - min) / width));
    buckets[index].count += 1;
  }

  return buckets;
}

function pearson(a, b) {
  const pairs = a.map((value, index) => [value, b[index]]).filter(([x, y]) => x != null && y != null);
  if (pairs.length < 3) return null;

  const avgX = pairs.reduce((sum, [x]) => sum + x, 0) / pairs.length;
  const avgY = pairs.reduce((sum, [, y]) => sum + y, 0) / pairs.length;
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (const [x, y] of pairs) {
    const dx = x - avgX;
    const dy = y - avgY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denominator = Math.sqrt(denomX * denomY);
  return denominator === 0 ? null : numerator / denominator;
}

function profileColumn(name, values, rowCount) {
  const blanks = values.filter(isBlank).length;
  const filled = rowCount - blanks;
  const uniqueValues = new Set(values.filter((value) => !isBlank(value)).map((value) => String(value).trim()));
  const numbers = values.map(toNumber);
  const validNumbers = numbers.filter((value) => value != null);
  const dates = values.map(toDate);
  const validDates = dates.filter(Boolean);

  const numericShare = filled ? validNumbers.length / filled : 0;
  const dateShare = filled ? validDates.length / filled : 0;
  const type = numericShare >= 0.85 ? "number" : dateShare >= 0.85 ? "date" : "category";

  const topValues = [...values.filter((value) => !isBlank(value)).reduce((map, value) => {
    const key = String(value).trim();
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map())]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([value, count]) => ({ value, count, share: rowCount ? count / rowCount : 0 }));

  const profile = {
    name,
    type,
    blanks,
    filled,
    missingRate: rowCount ? blanks / rowCount : 0,
    uniqueCount: uniqueValues.size,
    topValues,
  };

  if (type === "number") {
    const avg = validNumbers.reduce((sum, value) => sum + value, 0) / validNumbers.length;
    const variance = validNumbers.reduce((sum, value) => sum + (value - avg) ** 2, 0) / validNumbers.length;
    profile.stats = {
      count: validNumbers.length,
      min: Math.min(...validNumbers),
      q1: percentile(validNumbers, 0.25),
      median: median(validNumbers),
      avg,
      q3: percentile(validNumbers, 0.75),
      max: Math.max(...validNumbers),
      stdDev: Math.sqrt(variance),
    };
    profile.histogram = histogram(validNumbers);
    profile.series = numbers;
  }

  if (type === "date") {
    const timestamps = validDates.map((date) => date.getTime());
    profile.stats = {
      count: validDates.length,
      min: new Date(Math.min(...timestamps)).toISOString().slice(0, 10),
      max: new Date(Math.max(...timestamps)).toISOString().slice(0, 10),
    };
  }

  return profile;
}

function monthKeyFromDateKey(dateKey) {
  return dateKey ? dateKey.slice(0, 7) : null;
}

function compareMonthKeys(left, right) {
  if (!left || !right) return 0;
  return left.localeCompare(right);
}

function resolveMonthFilter(headers, records, metadata, options = {}) {
  const dateColumnIndex = headers.findIndex((header, index) => {
    const filled = records.filter((row) => !isBlank(row[index])).length;
    if (!filled) return false;
    const valid = records.filter((row) => toDate(row[index])).length;
    const nameLooksDate = /date|day|month|invoice|order/i.test(header);
    return valid / filled >= 0.7 || (nameLooksDate && valid / filled >= 0.4);
  });

  let startMonth = options.startMonth || null;
  let endMonth = options.endMonth || null;
  const mode = options.periodMode || "monthRange";

  if (!startMonth && !endMonth && metadata?.inferredPeriod) {
    startMonth = `${metadata.inferredPeriod.year}-${String(metadata.inferredPeriod.month).padStart(2, "0")}`;
    endMonth = startMonth;
  }

  if (dateColumnIndex === -1) {
    const inferredMonth = metadata?.inferredPeriod
      ? `${metadata.inferredPeriod.year}-${String(metadata.inferredPeriod.month).padStart(2, "0")}`
      : null;
    const inferredIncluded = inferredMonth
      && (!startMonth || compareMonthKeys(inferredMonth, startMonth) >= 0)
      && (!endMonth || compareMonthKeys(inferredMonth, endMonth) <= 0);

    return {
      records: inferredMonth && !inferredIncluded ? [] : records,
      dateColumn: null,
      requested: { mode, startMonth, endMonth },
      applied: false,
      inferredMonth,
      reason: inferredMonth
        ? "No transaction date column was found; the workbook title month was used for month range matching."
        : "No usable month or date column was found, so the full uploaded table was analyzed.",
    };
  }

  const filteredRecords = records.filter((row) => {
    const dateKey = toDateKey(row[dateColumnIndex]);
    if (!dateKey) return false;
    const monthKey = monthKeyFromDateKey(dateKey);
    if (startMonth && compareMonthKeys(monthKey, startMonth) < 0) return false;
    if (endMonth && compareMonthKeys(monthKey, endMonth) > 0) return false;
    return true;
  });

  return {
    records: filteredRecords,
    dateColumn: headers[dateColumnIndex],
    requested: { mode, startMonth, endMonth },
    applied: true,
    beforeRows: records.length,
    afterRows: filteredRecords.length,
  };
}

function findColumnIndex(headers, patterns) {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
}

function sumColumn(records, index) {
  if (index === -1) return 0;
  return records.reduce((sum, row) => sum + (toNumber(row[index]) || 0), 0);
}

function buildBranchDashboard(headers, records, metadata, monthFilter) {
  const branchIndex = findColumnIndex(headers, [/branch/i, /^name of branch$/i, /branch name/i]);
  const amountIndex = findColumnIndex(headers, [/^amount$/i, /sales amount/i, /revenue/i, /value/i]);
  const closingIndex = findColumnIndex(headers, [/closing value/i, /stock value/i]);
  const meterSaleIndex = findColumnIndex(headers, [/meter sale/i, /meter qty/i]);
  const stripSaleIndex = findColumnIndex(headers, [/strip sale/i, /strip qty/i]);
  const meterStockIndex = findColumnIndex(headers, [/meter stock/i]);
  const stripStockIndex = findColumnIndex(headers, [/strip stock/i]);

  const branchMap = new Map();
  for (const row of records) {
    const branch = branchIndex === -1 ? "All Branches" : String(row[branchIndex] || "Unknown").trim() || "Unknown";
    if (!branchMap.has(branch)) {
      branchMap.set(branch, {
        branch,
        rows: 0,
        amount: 0,
        closingValue: 0,
        meterSale: 0,
        stripSale: 0,
        meterStock: 0,
        stripStock: 0,
      });
    }
    const item = branchMap.get(branch);
    item.rows += 1;
    item.amount += amountIndex === -1 ? 0 : (toNumber(row[amountIndex]) || 0);
    item.closingValue += closingIndex === -1 ? 0 : (toNumber(row[closingIndex]) || 0);
    item.meterSale += meterSaleIndex === -1 ? 0 : (toNumber(row[meterSaleIndex]) || 0);
    item.stripSale += stripSaleIndex === -1 ? 0 : (toNumber(row[stripSaleIndex]) || 0);
    item.meterStock += meterStockIndex === -1 ? 0 : (toNumber(row[meterStockIndex]) || 0);
    item.stripStock += stripStockIndex === -1 ? 0 : (toNumber(row[stripStockIndex]) || 0);
  }

  const branches = [...branchMap.values()].sort((a, b) => b.amount - a.amount);
  for (const branch of branches) {
    branch.itemSalesTotal = branch.meterSale + branch.stripSale;
    branch.itemStockTotal = branch.meterStock + branch.stripStock;
  }
  const summary = metadata?.summaryRows?.[0] || null;
  const summaryValue = (key) => records.length && summary ? toNumber(summary[key]) : null;

  return {
    columns: {
      branch: branchIndex === -1 ? null : headers[branchIndex],
      amount: amountIndex === -1 ? null : headers[amountIndex],
      closingValue: closingIndex === -1 ? null : headers[closingIndex],
      meterSale: meterSaleIndex === -1 ? null : headers[meterSaleIndex],
      stripSale: stripSaleIndex === -1 ? null : headers[stripSaleIndex],
    },
    kpis: {
      branches: branches.length,
      rows: records.length,
      amount: sumColumn(records, amountIndex) || summaryValue(headers[amountIndex]) || 0,
      closingValue: sumColumn(records, closingIndex) || summaryValue(headers[closingIndex]) || 0,
      meterSale: sumColumn(records, meterSaleIndex) || summaryValue(headers[meterSaleIndex]) || 0,
      stripSale: sumColumn(records, stripSaleIndex) || summaryValue(headers[stripSaleIndex]) || 0,
    },
    monthRange: monthFilter.requested,
    branches: branches.slice(0, 100),
    topBranchesByAmount: branches.map((branch) => ({
      label: branch.branch,
      value: branch.amount,
      display: formatNumber(branch.amount),
    })),
    topBranchesByUnits: [...branches]
      .sort((a, b) => (b.meterSale + b.stripSale) - (a.meterSale + a.stripSale))
      .map((branch) => ({
        label: branch.branch,
        value: branch.meterSale + branch.stripSale,
        display: formatNumber(branch.meterSale + branch.stripSale),
      })),
  };
}

function buildReport(filename, headers, records, metadata = {}, options = {}) {
  if (!headers.length) throw new Error("The uploaded file does not contain headers.");

  const monthFilter = resolveMonthFilter(headers, records, metadata, options);
  const filteredRecords = monthFilter.records;
  const rowCount = filteredRecords.length;
  const columnProfiles = headers.map((header, colIndex) => {
    const values = filteredRecords.map((row) => row[colIndex] ?? "");
    return profileColumn(header, values, rowCount);
  });

  const numericColumns = columnProfiles.filter((column) => column.type === "number");
  const correlations = [];
  for (let i = 0; i < numericColumns.length; i += 1) {
    for (let j = i + 1; j < numericColumns.length; j += 1) {
      const value = pearson(numericColumns[i].series, numericColumns[j].series);
      if (value != null) {
        correlations.push({
          x: numericColumns[i].name,
          y: numericColumns[j].name,
          value,
        });
      }
    }
  }

  correlations.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  const missingCells = columnProfiles.reduce((sum, column) => sum + column.blanks, 0);
  const totalCells = rowCount * headers.length;
  const insights = [];

  if (rowCount === 0) insights.push("No data rows were found after the header row.");
  if (monthFilter.applied) {
    insights.push(`Month range applied on ${monthFilter.dateColumn}: ${monthFilter.requested.startMonth || "earliest"} to ${monthFilter.requested.endMonth || "latest"} (${monthFilter.afterRows} of ${monthFilter.beforeRows} rows).`);
  } else if (monthFilter.reason) {
    insights.push(monthFilter.reason);
  }
  if (missingCells > 0) {
    const worstMissing = [...columnProfiles].sort((a, b) => b.missingRate - a.missingRate)[0];
    insights.push(`${worstMissing.name} has the highest missing rate at ${formatPercent(worstMissing.missingRate)}.`);
  } else {
    insights.push("No missing values were found in the uploaded file.");
  }

  if (numericColumns.length) {
    const widestRange = [...numericColumns].sort((a, b) => (b.stats.max - b.stats.min) - (a.stats.max - a.stats.min))[0];
    insights.push(`${widestRange.name} has the widest numeric range (${formatNumber(widestRange.stats.min)} to ${formatNumber(widestRange.stats.max)}).`);
  }

  if (correlations.length) {
    const strongest = correlations[0];
    insights.push(`Strongest numeric relationship: ${strongest.x} and ${strongest.y} (${strongest.value.toFixed(2)} correlation).`);
  }

  return {
    id: crypto.randomUUID(),
    filename,
    createdAt: new Date().toISOString(),
    metadata,
    period: {
      requested: monthFilter.requested,
      applied: monthFilter.applied,
      dateColumn: monthFilter.dateColumn,
      beforeRows: monthFilter.beforeRows,
      afterRows: monthFilter.afterRows,
      inferredMonth: monthFilter.inferredMonth,
      reason: monthFilter.reason,
    },
    overview: {
      rows: rowCount,
      columns: headers.length,
      totalCells,
      missingCells,
      missingRate: totalCells ? missingCells / totalCells : 0,
      numericColumns: numericColumns.length,
      dateColumns: columnProfiles.filter((column) => column.type === "date").length,
      categoryColumns: columnProfiles.filter((column) => column.type === "category").length,
    },
    insights,
    charts: {
      missingByColumn: columnProfiles
        .filter((column) => column.blanks > 0)
        .sort((a, b) => b.blanks - a.blanks)
        .slice(0, 12)
        .map((column) => ({
          label: column.name,
          value: column.blanks,
          rate: column.missingRate,
        })),
      numericDistributions: numericColumns.slice(0, 4).map((column) => ({
        label: column.name,
        values: column.histogram,
      })),
      categoryBreakdowns: columnProfiles
        .filter((column) => column.type === "category" && column.topValues.length > 0)
        .slice(0, 4)
        .map((column) => ({
          label: column.name,
          values: column.topValues.slice(0, 6).map((item) => ({
            label: item.value,
            value: item.count,
            share: item.share,
          })),
        })),
    },
    dashboard: buildBranchDashboard(headers, filteredRecords, metadata, monthFilter),
    columns: columnProfiles.map(({ series, ...column }) => column),
    correlations: correlations.slice(0, 10),
    sampleRows: filteredRecords.slice(0, 25).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]))),
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatPercent(value) {
  return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

async function handleUpload(req, res, options = {}) {
  try {
    const body = await collectBody(req);
    const { file, fields } = parseMultipart(body, req.headers["content-type"]);

    const { headers, records, metadata } = parseUpload(file);
    const report = buildReport(file.filename, headers, records, metadata, fields);
    if (options.persist !== false) {
      ensureReportDir();
      const reportPath = path.join(REPORT_DIR, `${report.id}.json`);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    }
    sendJson(res, 200, report);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Unable to analyze this file." });
  }
}

function handleReport(req, res) {
  const id = new URL(req.url, `http://${req.headers.host}`).pathname.split("/").pop();
  const reportPath = path.join(REPORT_DIR, `${id}.json`);

  if (!/^[a-f0-9-]{36}$/i.test(id) || !fs.existsSync(reportPath)) {
    sendJson(res, 404, { error: "Report not found." });
    return;
  }

  send(res, 200, fs.readFileSync(reportPath), "application/json; charset=utf-8");
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/analyze") {
    handleUpload(req, res);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/reports/")) {
    handleReport(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  send(res, 405, "Method not allowed");
});

if (require.main === module) {
  ensureReportDir();
  server.listen(PORT, () => {
    console.log(`Data Analysis Reporter running at http://localhost:${PORT}`);
  });
}

module.exports = {
  handleUpload,
  server,
};
