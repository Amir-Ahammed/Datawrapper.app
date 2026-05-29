const form = document.querySelector("#uploadForm");
const fileInput = document.querySelector("#csvFile");
const fileName = document.querySelector("#fileName");
const statusEl = document.querySelector("#status");
const reportEl = document.querySelector("#report");
const analyzeButton = document.querySelector("#analyzeButton");
const downloadButton = document.querySelector("#downloadReport");
const periodMode = document.querySelector("#periodMode");
const periodControls = document.querySelectorAll("[data-mode-control]");

let currentReport = null;
const expandedCharts = new Set();

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

fileInput.addEventListener("change", () => {
  fileName.textContent = fileInput.files[0]?.name || "Maximum upload size: 25 MB";
});

periodMode.addEventListener("change", updatePeriodControls);
updatePeriodControls();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);
  formData.append("periodMode", periodMode.value);
  formData.append("startMonth", document.querySelector("#startMonth").value);
  formData.append("endMonth", document.querySelector("#endMonth").value);
  setStatus("Analyzing file...");
  analyzeButton.disabled = true;
  downloadButton.disabled = true;

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      body: formData,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Analysis failed.");

    currentReport = payload;
    expandedCharts.clear();
    renderReport(payload);
    setStatus(`Report generated for ${payload.filename}.`);
    downloadButton.disabled = false;
  } catch (error) {
    currentReport = null;
    setStatus(error.message, true);
    reportEl.className = "report is-empty";
    reportEl.innerHTML = `<div class="empty-state"><h2>No report generated</h2><p>${escapeHtml(error.message)}</p></div>`;
  } finally {
    analyzeButton.disabled = false;
  }
});

downloadButton.addEventListener("click", () => {
  if (!currentReport) return;
  const blob = new Blob([JSON.stringify(currentReport, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${currentReport.filename.replace(/\.(csv|xls|xlsx)$/i, "")}-analysis-report.json`;
  link.click();
  URL.revokeObjectURL(url);
});

function renderReport(report) {
  const dashboard = report.dashboard || {};
  const kpis = dashboard.kpis || {};
  reportEl.className = "report";
  reportEl.innerHTML = `
    <section class="dashboard-title panel">
      <div>
        <h2>Branch Sales Overview</h2>
        <p>${escapeHtml(report.filename)}</p>
      </div>
      ${renderPeriod(report)}
    </section>

    <section class="metric-grid">
      ${metric("Total Amount", money(kpis.amount))}
      ${metric("Closing Value", money(kpis.closingValue))}
      ${metric("Meter Sale", numberFormat.format(kpis.meterSale || 0))}
      ${metric("Strip Sale", numberFormat.format(kpis.stripSale || 0))}
      ${metric("Branches", numberFormat.format(kpis.branches || 0))}
    </section>

    <section class="dashboard-grid">
      ${chartCard("amountByBranch", "Branches by Amount", report.dashboard?.topBranchesByAmount?.length)}
      ${chartCard("unitsByBranch", "Branches by Unit Sales", report.dashboard?.topBranchesByUnits?.length)}
      ${chartCard("itemSalesByBranch", "Branch by Item Wise Sales", report.dashboard?.branches?.length)}
      ${chartCard("itemStockByBranch", "Branch by Item Stock", report.dashboard?.branches?.length)}
      ${chartCard("meterSalesStockByBranch", "Branch Wise Meter Sales and Stock", report.dashboard?.branches?.length)}
      ${chartCard("stripSalesStockByBranch", "Branch Wise Strip Sales and Stock", report.dashboard?.branches?.length)}
    </section>

    ${renderSourceSummaryGraph(report)}
  `;
  drawCharts(report);
}

reportEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-chart-toggle]");
  if (!button || !currentReport) return;

  const chartId = button.dataset.chartToggle;
  if (expandedCharts.has(chartId)) {
    expandedCharts.delete(chartId);
  } else {
    expandedCharts.add(chartId);
  }

  renderReport(currentReport);
});

function renderSourceSummaryGraph(report) {
  const rows = report.metadata?.summaryRows || [];
  if (!rows.length) return "";
  return `
    <section class="panel">
      <h2>Monthly Summary</h2>
      ${chartCard("monthlySummary", "Sales and Stock Summary")}
    </section>
  `;
}

function updatePeriodControls() {
  const selected = periodMode.value;
  periodControls.forEach((control) => {
    const active = control.dataset.modeControl === selected;
    control.hidden = !active;
    control.querySelector("input").disabled = !active;
  });
}

function renderPeriod(report) {
  const inferred = report.metadata?.inferredPeriod;
  const period = report.period;
  const details = [];

  if (report.metadata?.title) details.push(["Source title", report.metadata.title]);
  if (inferred) details.push(["Inferred month", `${inferred.label} (${inferred.start} to ${inferred.end})`]);
  if (period?.applied) {
    details.push(["Applied month range", `${period.dateColumn}: ${period.requested.startMonth || "earliest"} to ${period.requested.endMonth || "latest"}`]);
  } else if (period?.reason) {
    const requested = period?.requested;
    const range = requested?.startMonth || requested?.endMonth ? `${requested.startMonth || "earliest"} to ${requested.endMonth || "latest"}` : "Auto";
    details.push(["Month range", range]);
    details.push(["Filter note", period.reason]);
  }

  if (!details.length) return "";

  return `
    <dl class="period-summary">
      ${details.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
    </dl>
  `;
}

function metric(label, value) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function money(value) {
  return numberFormat.format(value || 0);
}

function renderColumn(column) {
  const stats = column.stats || {};
  const common = column.topValues?.[0];
  const fields = [
    ["Filled", numberFormat.format(column.filled)],
    ["Missing", percentFormat.format(column.missingRate)],
    ["Unique", numberFormat.format(column.uniqueCount)],
    ["Top value", common ? `${common.value} (${numberFormat.format(common.count)})` : "None"],
  ];

  if (column.type === "number") {
    fields.push(
      ["Average", formatValue(stats.avg)],
      ["Median", formatValue(stats.median)],
      ["Minimum", formatValue(stats.min)],
      ["Maximum", formatValue(stats.max)],
      ["Std. dev.", formatValue(stats.stdDev)],
    );
  }

  if (column.type === "date") {
    fields.push(["Earliest", stats.min || "N/A"], ["Latest", stats.max || "N/A"]);
  }

  return `
    <article class="column-card">
      <header>
        <h3>${escapeHtml(column.name)}</h3>
        <span class="pill">${escapeHtml(column.type)}</span>
      </header>
      <dl class="field-list">
        ${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
      </dl>
    </article>
  `;
}

function renderCharts(report) {
  const chartCount = [
    report.charts?.missingByColumn?.length,
    report.charts?.numericDistributions?.length,
    report.charts?.categoryBreakdowns?.length,
    report.correlations?.length,
  ].filter(Boolean).length;

  if (!chartCount) return "";

  return `
    <section class="panel">
      <h2>Graph Analysis</h2>
      <div class="chart-grid">
        ${report.charts?.missingByColumn?.length ? chartCard("missingChart", "Missing Values by Column") : ""}
        ${report.charts?.numericDistributions?.map((chart, index) => chartCard(`histogram-${index}`, `${escapeHtml(chart.label)} Distribution`)).join("") || ""}
        ${report.charts?.categoryBreakdowns?.map((chart, index) => chartCard(`category-${index}`, `${escapeHtml(chart.label)} Breakdown`)).join("") || ""}
        ${report.correlations?.length ? chartCard("correlationChart", "Strongest Numeric Correlations") : ""}
      </div>
    </section>
  `;
}

function chartCard(id, title, itemCount = 0) {
  const toggleLabel = itemCount > 10
    ? expandedCharts.has(id)
      ? "Show top 10"
      : `Show all ${itemCount - 10}`
    : "";
  return `
    <article class="chart-card">
      <header class="chart-card-header">
        <h3>${title}</h3>
        ${itemCount > 10 ? `<button class="chart-toggle" type="button" data-chart-toggle="${id}">${toggleLabel}</button>` : ""}
      </header>
      <canvas id="${id}" height="260" aria-label="${title}" role="img"></canvas>
    </article>
  `;
}

function renderCorrelations(correlations) {
  if (!correlations.length) return "";
  return `
    <section class="panel">
      <h2>Top Numeric Correlations</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Column 1</th><th>Column 2</th><th>Correlation</th></tr></thead>
          <tbody>
            ${correlations.map((item) => `
              <tr>
                <td>${escapeHtml(item.x)}</td>
                <td>${escapeHtml(item.y)}</td>
                <td>${item.value.toFixed(3)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <p class="small-note">Correlation values range from -1 to 1 and only use rows where both numeric values are present.</p>
    </section>
  `;
}

function drawCharts(report) {
  if (report.dashboard?.topBranchesByAmount?.length) {
    drawBarChart("amountByBranch", visibleRows("amountByBranch", report.dashboard.topBranchesByAmount), { color: "#f2c811", compactLabels: true, horizontal: true });
  }

  if (report.dashboard?.topBranchesByUnits?.length) {
    drawBarChart("unitsByBranch", visibleRows("unitsByBranch", report.dashboard.topBranchesByUnits), { color: "#118dff", compactLabels: true, horizontal: true });
  }

  if (report.dashboard?.branches?.length) {
    drawStackedBarChart("itemSalesByBranch", visibleRows("itemSalesByBranch", [...report.dashboard.branches]
      .sort((a, b) => (b.itemSalesTotal || 0) - (a.itemSalesTotal || 0))
      .map((branch) => ({
        label: branch.branch,
        values: [
          { label: "Meter", value: branch.meterSale || 0, color: "#118dff" },
          { label: "Strip", value: branch.stripSale || 0, color: "#f2c811" },
        ],
      }))), { heightPerRow: 34 });

    drawStackedBarChart("itemStockByBranch", visibleRows("itemStockByBranch", [...report.dashboard.branches]
      .sort((a, b) => (b.itemStockTotal || 0) - (a.itemStockTotal || 0))
      .map((branch) => ({
        label: branch.branch,
        values: [
          { label: "Meter", value: branch.meterStock || 0, color: "#22a06b" },
          { label: "Strip", value: branch.stripStock || 0, color: "#ff8b00" },
        ],
      }))), { heightPerRow: 34 });

    drawStackedBarChart("meterSalesStockByBranch", visibleRows("meterSalesStockByBranch", [...report.dashboard.branches]
      .sort((a, b) => ((b.meterSale || 0) + (b.meterStock || 0)) - ((a.meterSale || 0) + (a.meterStock || 0)))
      .map((branch) => ({
        label: branch.branch,
        values: [
          { label: "Sale", value: branch.meterSale || 0, color: "#118dff" },
          { label: "Stock", value: branch.meterStock || 0, color: "#22a06b" },
        ],
      }))), { heightPerRow: 34 });

    drawStackedBarChart("stripSalesStockByBranch", visibleRows("stripSalesStockByBranch", [...report.dashboard.branches]
      .sort((a, b) => ((b.stripSale || 0) + (b.stripStock || 0)) - ((a.stripSale || 0) + (a.stripStock || 0)))
      .map((branch) => ({
        label: branch.branch,
        values: [
          { label: "Sale", value: branch.stripSale || 0, color: "#f2c811" },
          { label: "Stock", value: branch.stripStock || 0, color: "#ff8b00" },
        ],
      }))), { heightPerRow: 34 });
  }

  if (report.metadata?.summaryRows?.length) {
    const summary = report.metadata.summaryRows[0];
    drawBarChart("monthlySummary", [
      { label: "Meter Sale", value: Number(String(summary["Meter Sale"] || "0").replace(/,/g, "")), display: summary["Meter Sale"] || "0" },
      { label: "Strip Sale", value: Number(String(summary["Strip Sale"] || "0").replace(/,/g, "")), display: summary["Strip Sale"] || "0" },
      { label: "Meter Stock", value: Number(String(summary["Meter Stock"] || "0").replace(/,/g, "")), display: summary["Meter Stock"] || "0" },
      { label: "Strip Stock", value: Number(String(summary["Strip Stock"] || "0").replace(/,/g, "")), display: summary["Strip Stock"] || "0" },
    ], { color: "#394651", compactLabels: true });
  }

  return;

  if (report.charts?.missingByColumn?.length) {
    drawBarChart("missingChart", report.charts.missingByColumn.map((item) => ({
      label: item.label,
      value: item.value,
      display: `${numberFormat.format(item.value)} (${percentFormat.format(item.rate)})`,
    })), { color: "#b45309" });
  }

  report.charts?.numericDistributions?.forEach((chart, index) => {
    drawBarChart(`histogram-${index}`, chart.values.map((item) => ({
      label: item.label,
      value: item.count,
      display: numberFormat.format(item.count),
    })), { color: "#0f766e", compactLabels: true });
  });

  report.charts?.categoryBreakdowns?.forEach((chart, index) => {
    drawBarChart(`category-${index}`, chart.values.map((item) => ({
      label: item.label,
      value: item.value,
      display: `${numberFormat.format(item.value)} (${percentFormat.format(item.share)})`,
    })), { color: "#2563eb" });
  });

  if (report.correlations?.length) {
    drawBarChart("correlationChart", report.correlations.slice(0, 8).map((item) => ({
      label: `${item.x} / ${item.y}`,
      value: Math.abs(item.value),
      display: item.value.toFixed(3),
    })), { color: "#7c3aed", maxValue: 1 });
  }
}

function visibleRows(chartId, rows) {
  return expandedCharts.has(chartId) ? rows : rows.slice(0, 10);
}

function drawStackedBarChart(id, rows, options = {}) {
  const canvas = document.getElementById(id);
  if (!canvas || !rows.length) return;

  const context = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(300, rows.length * (options.heightPerRow || 30) + 52);
  canvas.style.height = `${height}px`;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const totals = rows.map((row) => row.values.reduce((sum, item) => sum + item.value, 0));
  const maxValue = Math.max(...totals, 1);
  const labelWidth = Math.min(145, Math.max(92, width * 0.32));
  const valueWidth = 150;
  const rowGap = 9;
  const rowHeight = Math.max(15, (height - 48 - rowGap * (rows.length - 1)) / rows.length);
  const barLeft = labelWidth;
  const barMaxWidth = width - labelWidth - valueWidth - 16;

  rows.forEach((row, index) => {
    const y = 34 + index * (rowHeight + rowGap);
    const total = totals[index];
    let x = barLeft;

    context.fillStyle = "#53606a";
    context.font = "11px system-ui, sans-serif";
    context.textAlign = "right";
    context.textBaseline = "middle";
    context.fillText(truncateLabel(row.label), labelWidth - 8, y + rowHeight / 2);

    context.fillStyle = "#e7edf0";
    context.fillRect(barLeft, y, barMaxWidth, rowHeight);

    row.values.forEach((item) => {
      const segmentWidth = maxValue ? (item.value / maxValue) * barMaxWidth : 0;
      context.fillStyle = item.color;
      context.fillRect(x, y, segmentWidth, rowHeight);
      if (segmentWidth >= 56 && item.value > 0) {
        context.fillStyle = "#ffffff";
        context.font = "700 10px system-ui, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(numberFormat.format(item.value), x + segmentWidth / 2, y + rowHeight / 2);
      }
      x += segmentWidth;
    });

    context.fillStyle = "#172026";
    context.font = "700 10px system-ui, sans-serif";
    context.textAlign = "left";
    context.fillText(row.values.map((item) => `${item.label} ${numberFormat.format(item.value)}`).join("  /  "), barLeft + barMaxWidth + 8, y + rowHeight / 2);
  });

  drawLegend(context, rows[0].values, labelWidth, 8);
}

function drawLegend(context, items, x, y) {
  let cursor = x;
  items.forEach((item) => {
    context.fillStyle = item.color;
    context.fillRect(cursor, y, 10, 10);
    context.fillStyle = "#53606a";
    context.font = "11px system-ui, sans-serif";
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(item.label, cursor + 14, y + 5);
    cursor += 72;
  });
}

function drawBarChart(id, rows, options = {}) {
  const canvas = document.getElementById(id);
  if (!canvas || !rows.length) return;

  const context = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width));
  const baseHeight = Number(canvas.getAttribute("height")) || 260;
  const height = options.horizontal ? Math.max(baseHeight, rows.length * 28 + 28) : baseHeight;
  canvas.style.height = `${height}px`;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const maxValue = options.maxValue || Math.max(...rows.map((row) => row.value), 1);
  const left = 12;
  const right = 18;
  const top = 12;
  const bottom = options.compactLabels ? 54 : 78;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const gap = 8;
  const barWidth = Math.max(16, (chartWidth - gap * (rows.length - 1)) / rows.length);

  context.strokeStyle = "#d8e0e3";
  context.lineWidth = 1;

  if (options.horizontal) {
    const labelWidth = Math.min(145, Math.max(92, width * 0.32));
    const valueWidth = 76;
    const rowGap = 8;
    const rowHeight = Math.max(14, (height - 28 - rowGap * (rows.length - 1)) / rows.length);
    const barLeft = labelWidth;
    const barMaxWidth = width - labelWidth - valueWidth - 16;

    rows.forEach((row, index) => {
      const y = 14 + index * (rowHeight + rowGap);
      const barWidth = maxValue ? (row.value / maxValue) * barMaxWidth : 0;

      context.fillStyle = "#53606a";
      context.font = "11px system-ui, sans-serif";
      context.textAlign = "right";
      context.textBaseline = "middle";
      context.fillText(truncateLabel(row.label), labelWidth - 8, y + rowHeight / 2);

      context.fillStyle = "#e7edf0";
      context.fillRect(barLeft, y, barMaxWidth, rowHeight);
      context.fillStyle = options.color || "#0f766e";
      context.fillRect(barLeft, y, barWidth, rowHeight);

      context.fillStyle = "#172026";
      context.font = "700 11px system-ui, sans-serif";
      context.textAlign = "left";
      context.fillText(row.display, barLeft + barWidth + 6, y + rowHeight / 2);
    });
    return;
  }

  context.beginPath();
  context.moveTo(left, top + chartHeight);
  context.lineTo(width - right, top + chartHeight);
  context.stroke();

  rows.forEach((row, index) => {
    const x = left + index * (barWidth + gap);
    const barHeight = maxValue ? (row.value / maxValue) * (chartHeight - 18) : 0;
    const y = top + chartHeight - barHeight;

    context.fillStyle = options.color || "#0f766e";
    context.fillRect(x, y, barWidth, barHeight);

    context.fillStyle = "#172026";
    context.font = "700 11px system-ui, sans-serif";
    context.textAlign = "center";
    context.fillText(row.display, x + barWidth / 2, Math.max(12, y - 5));

    context.save();
    context.translate(x + barWidth / 2, top + chartHeight + 8);
    context.rotate(options.compactLabels ? -0.65 : -0.85);
    context.fillStyle = "#61717a";
    context.font = "11px system-ui, sans-serif";
    context.textAlign = "right";
    context.fillText(truncateLabel(row.label), 0, 0);
    context.restore();
  });
}

function truncateLabel(label) {
  const text = String(label ?? "");
  return text.length > 22 ? `${text.slice(0, 19)}...` : text;
}

function renderSample(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return `
    <section class="panel">
      <h2>Sample Rows</h2>
      <div class="table-wrap">
        <table>
          <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
          <tbody>
            ${rows.map((row) => `<tr>${headers.map((header) => `<td>${escapeHtml(row[header])}</td>`).join("")}</tr>`).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function formatValue(value) {
  return value == null || Number.isNaN(value) ? "N/A" : numberFormat.format(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
