// Shared Plotly helpers — layout, modebar, export, color utilities, band traces.

import { state } from "./state.js";

// ─────────────────────────────────────────────────────────────
// Color utilities
// ─────────────────────────────────────────────────────────────

export function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
}

export function lightenColor(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}

export function darkenColor(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

export function hexToRgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─────────────────────────────────────────────────────────────
// Plotly config factory
// ─────────────────────────────────────────────────────────────

export const JSON_DOWNLOAD_ICON = {
  width: 24,
  height: 24,
  path: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
};

/** Export the current chart's data as JSON.
 *  `metadata` provides dashboard-specific fields to include in the export. */
export function exportChartDataAsJSON(gd, metadata, filename) {
  const exportData = {
    metadata: {
      ...metadata,
      title: gd.layout.title?.text || "",
      y_axis: gd.layout.yaxis?.title?.text || gd.layout.yaxis?.title || "",
      exported_at: new Date().toISOString(),
    },
    series: [],
  };
  for (const trace of gd.data) {
    if (trace.fill === "toself") continue;  // skip SE band traces
    const series = {
      name: trace.name || null,
      x: Array.from(trace.x),
      y: Array.from(trace.y),
    };
    if (trace.error_y?.array) series.error = Array.from(trace.error_y.array);
    exportData.series.push(series);
  }
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "chart-data.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Build a Plotly config with the standard PNG/SVG/JSON download buttons.
 *  `filenamePrefix` is used for downloaded chart files.
 *  `getJsonMetadata` is a callback that returns dashboard-specific export metadata. */
export function makePlotlyConfig(filenamePrefix, getJsonMetadata) {
  return {
    responsive: true,
    displaylogo: false,
    modeBarButtons: [
      [
        {
          name: "Download plot as PNG",
          icon: Plotly.Icons.camera,
          click: (gd) => Plotly.downloadImage(gd, {
            format: "png", width: 1600, height: 900, scale: 3, filename: filenamePrefix,
          }),
        },
        {
          name: "Download plot as SVG",
          icon: Plotly.Icons.camera,
          click: (gd) => Plotly.downloadImage(gd, {
            format: "svg", width: 1600, height: 900, filename: filenamePrefix,
          }),
        },
      ],
      [
        {
          name: "Export data as JSON",
          icon: JSON_DOWNLOAD_ICON,
          click: (gd) => exportChartDataAsJSON(gd, getJsonMetadata ? getJsonMetadata() : {}, filenamePrefix + "-data.json"),
        },
      ],
    ],
  };
}

// ─────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────

/** Standard Plotly layout with sensible defaults; merge with overrides. */
export function getPlotlyLayout(overrides) {
  const result = Object.assign({
    font: { family: "Inter, system-ui, sans-serif", size: 13 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    margin: { l: 60, r: 20, t: 50, b: 80 },
    autosize: true,
    hovermode: "closest",
  }, overrides);
  const axisDefaults = { showline: false, zeroline: false, gridcolor: "#d8dce3" };
  result.xaxis = Object.assign({ automargin: true }, axisDefaults, result.xaxis);
  result.yaxis = Object.assign({}, axisDefaults, result.yaxis);
  return result;
}

/** Plotly.newPlot + register hover handlers. */
export function plotChart(traces, layout, config, onHover, onUnhover) {
  Plotly.newPlot("chart", traces, layout, config);
  const chartEl = document.getElementById("chart");
  if (onHover) chartEl.on("plotly_hover", onHover);
  if (onUnhover) chartEl.on("plotly_unhover", onUnhover);
}

// ─────────────────────────────────────────────────────────────
// Bar-chart helpers (used by noreval comparison views)
// ─────────────────────────────────────────────────────────────

/** Compute the minimum tick rotation angle so that x-axis labels don't overlap.
 *  Models 2-D rectangle collision for rotated labels: returns 0 (horizontal)
 *  when labels fit, else a negative angle in [-5, -90]. */
export function computeTickAngle(labels) {
  if (!labels || labels.length <= 1) return 0;
  const chartEl = document.getElementById("chart");
  const margins = 80;
  const plotWidth = (chartEl ? chartEl.clientWidth : 1200) - margins;
  const fontSize = 13;
  const fontHeight = fontSize * 1.2;
  let labelWidth;
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = fontSize + "px Inter, system-ui, sans-serif";
    labelWidth = Math.max(...labels.map((l) => ctx.measureText(l).width));
  } catch (_) {
    labelWidth = Math.max(...labels.map((l) => l.length)) * fontSize * 0.55;
  }
  const slotWidth = plotWidth / labels.length;
  const gap = 4;
  if (labelWidth + gap <= slotWidth) return 0;
  for (let deg = 5; deg < 90; deg += 5) {
    const rad = (deg * Math.PI) / 180;
    if (slotWidth * Math.sin(rad) >= fontHeight + gap) return -deg;
  }
  return -90;
}

/** Compute annotation font size that shrinks when labels get crowded. */
export function computeAnnotationFontSize(totalPositions) {
  const chartEl = document.getElementById("chart");
  const margins = 80;
  const plotWidth = (chartEl ? chartEl.clientWidth : 1200) - margins;
  const availablePerLabel = plotWidth / totalPositions;
  const maxChars = state.currentNormalization === "zscore" ? 6 : 5;
  const fittedSize = availablePerLabel / (maxChars * 0.6);
  return Math.max(8, Math.min(13, Math.floor(fittedSize)));
}

// ─────────────────────────────────────────────────────────────
// Line-chart helpers (progress views)
// ─────────────────────────────────────────────────────────────

/** Create a shaded band trace around a line for ±SE visualization.
 *  Pass the matching line trace's `name` as `legendGroup` so legend clicks
 *  toggle the band along with its line. */
export function makeBandTrace(xValues, yValues, seValues, color, legendGroup) {
  const upper = [], lower = [], xs = [];
  for (let i = 0; i < xValues.length; i++) {
    if (yValues[i] != null && seValues[i] != null) {
      xs.push(xValues[i]);
      upper.push(yValues[i] + seValues[i]);
      lower.push(yValues[i] - seValues[i]);
    }
  }
  if (xs.length === 0) return null;
  const trace = {
    x: xs.concat(xs.slice().reverse()),
    y: upper.concat(lower.slice().reverse()),
    fill: "toself",
    fillcolor: hexToRgba(color, 0.15),
    line: { color: "transparent" },
    showlegend: false,
    hoverinfo: "skip",
  };
  if (legendGroup != null) trace.legendgroup = legendGroup;
  return trace;
}

// ─────────────────────────────────────────────────────────────
// Y-range computations
// ─────────────────────────────────────────────────────────────

/** Compute [yMin, yMax] padding for non-negative or zscore data. */
export function computeYRange(values) {
  if (!values.length) return state.currentNormalization === "zscore" ? [-2, 2] : [0, 100];
  const mx = Math.max(...values);
  const mn = Math.min(...values);
  if (state.currentNormalization === "zscore") {
    const pad = Math.max((mx - mn) * 0.15, 0.3);
    return [mn - pad, mx + pad];
  }
  return [0, Math.min(mx + Math.max(mx * 0.15, 2), 115)];
}

/** Compute a single yMax for raw, non-normalized data. */
export function computeYMax(values) {
  if (!values.length) return 100;
  const mx = Math.max(...values);
  return Math.min(mx + Math.max(mx * 0.15, 2), 115);
}
