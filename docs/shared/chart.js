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

// Bar "grow-up" animation. Debounced so rapid renders (e.g. dragging the size
// slider) don't constantly re-animate. We do the animation by hand with a
// requestAnimationFrame loop rather than via Plotly.animate, because
// Plotly.animate's bar-trace transitions are flaky in Firefox.
//
// Two phases driven by one clock:
//   Phase 1 (BAR_ANIM_DURATION): bars grow 0 → score.
//   Phase 2 (ERR_ANIM_DURATION): error bars grow 0 → se. Phase 2 starts
//     PHASE_OVERLAP ms before phase 1 ends, so the tail of the bar grow-up
//     overlaps with the start of the error-bar grow-up.
// Annotation y is the clean combined formula  score*e1 + se*e2  — this is
// correct in all three regions (pre-overlap, overlap, post-phase-1).
//
// Callers can attach `_annAnim` to the layout — an array parallel to
// `layout.annotations` of `{score, se}` records giving the bar value and
// error magnitude for each label. The key is stripped before reaching Plotly.
const BAR_ANIM_DURATION = 500;
const ERR_ANIM_DURATION = 250;
const PHASE_OVERLAP = 250;   // ms by which phase 2 overlaps the tail of phase 1
const BAR_ANIM_DEBOUNCE = 250;
let lastPlotTime = 0;
let currentAnim = 0;   // monotonic id; in-flight rAF callbacks abort if outdated
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** Plotly.newPlot + register hover handlers. Bar traces animate from y=0
 *  to their target values on each render (debounced). */
export function plotChart(traces, layout, config, onHover, onUnhover) {
  const now = Date.now();
  const barIndices = [];
  traces.forEach((t, i) => { if (t.type === "bar") barIndices.push(i); });
  const shouldAnimate = barIndices.length > 0 && (now - lastPlotTime) > BAR_ANIM_DEBOUNCE;
  lastPlotTime = now;
  const animId = ++currentAnim;   // invalidate any in-flight animation

  // Pull the annotation animation metadata off the layout before handing it
  // to Plotly (which would otherwise warn about an unknown key).
  const annAnim = layout._annAnim || null;
  const plotLayout = Object.assign({}, layout);
  delete plotLayout._annAnim;

  const chartEl = document.getElementById("chart");

  if (!shouldAnimate) {
    Plotly.newPlot("chart", traces, plotLayout, config);
    if (onHover) chartEl.on("plotly_hover", onHover);
    if (onUnhover) chartEl.on("plotly_unhover", onUnhover);
    return;
  }

  // Build starting traces with y=0 (and zeroed error bars) for bar traces.
  const startTraces = traces.map((t) => {
    if (t.type !== "bar") return t;
    const start = Object.assign({}, t, { y: t.y.map(() => 0) });
    if (t.error_y && t.error_y.array) {
      start.error_y = Object.assign({}, t.error_y,
        { array: t.error_y.array.map(() => 0) });
    }
    return start;
  });

  // Start annotations at y=0 (sitting on the floor) with opacity 0; they'll
  // ride up and fade in alongside the bars during phase 1.
  const annotationsTarget = plotLayout.annotations || [];
  const startLayout = Object.assign({}, plotLayout);
  if (annotationsTarget.length) {
    startLayout.annotations = annotationsTarget.map(
      (a) => Object.assign({}, a, { y: 0, opacity: 0 }));
  }

  Plotly.newPlot("chart", startTraces, startLayout, config);
  if (onHover) chartEl.on("plotly_hover", onHover);
  if (onUnhover) chartEl.on("plotly_unhover", onUnhover);

  const barYTargets = barIndices.map((i) => traces[i].y);
  // Indices (into barIndices) of bar traces that actually carry error bars,
  // along with the target arrays — precomputed for the phase-2 loop.
  const errBarIdx = [], errBarTargets = [];
  barIndices.forEach((traceIdx) => {
    if (traces[traceIdx].error_y && traces[traceIdx].error_y.array) {
      errBarIdx.push(traceIdx);
      errBarTargets.push(traces[traceIdx].error_y.array);
    }
  });

  const hasErrBars = errBarIdx.length > 0;
  const phase2StartOffset = BAR_ANIM_DURATION - PHASE_OVERLAP;
  const totalDuration = hasErrBars
    ? phase2StartOffset + ERR_ANIM_DURATION
    : BAR_ANIM_DURATION;

  let animStart = null;
  function tick(t) {
    if (animId !== currentAnim) return;   // a newer render took over
    if (animStart === null) animStart = t;
    const elapsed = t - animStart;

    const p1 = Math.min(1, elapsed / BAR_ANIM_DURATION);
    const e1 = easeOutCubic(p1);
    const p2 = hasErrBars
      ? Math.max(0, Math.min(1, (elapsed - phase2StartOffset) / ERR_ANIM_DURATION))
      : 0;
    const e2 = easeOutCubic(p2);

    // Build a single trace update covering whichever phases are active.
    // During the overlap, both `y` and `error_y.array` ride in the same call.
    // Assumes errBarIdx === barIndices when both are active — true here, since
    // each chart's bar traces either all carry error bars or none do.
    const traceUpdate = {};
    let traceIdx = null;
    if (elapsed <= BAR_ANIM_DURATION) {
      traceUpdate.y = barYTargets.map((arr) => arr.map((v) => v == null ? null : v * e1));
      traceIdx = barIndices;
    }
    if (hasErrBars && elapsed >= phase2StartOffset) {
      traceUpdate["error_y.array"] = errBarTargets.map(
        (arr) => arr.map((v) => v == null ? 0 : v * e2));
      if (traceIdx === null) traceIdx = errBarIdx;
    }

    // Annotations — y = score*e1 + se*e2 tracks the (bar + error-bar) top.
    let layoutUpdate = null;
    if (annotationsTarget.length) {
      const newAnnotations = annotationsTarget.map((a, i) => {
        const meta = annAnim && annAnim[i];
        let y;
        if (meta) y = meta.score * e1 + meta.se * e2;
        else y = typeof a.y === "number" ? a.y * e1 : a.y;
        return Object.assign({}, a, { y, opacity: p1 });
      });
      layoutUpdate = { annotations: newAnnotations };
    }

    // One Plotly call per frame so Firefox does a single render pass.
    const hasTrace = traceIdx !== null;
    if (hasTrace && layoutUpdate) {
      Plotly.update("chart", traceUpdate, layoutUpdate, traceIdx);
    } else if (hasTrace) {
      Plotly.restyle("chart", traceUpdate, traceIdx);
    } else if (layoutUpdate) {
      Plotly.relayout("chart", layoutUpdate);
    }

    if (elapsed < totalDuration) requestAnimationFrame(tick);
  }

  // Defer one frame so the y=0 start state is painted before we begin
  // interpolating — without this, Firefox can skip the first paint and
  // appear to jump straight to the target.
  requestAnimationFrame(() => requestAnimationFrame(tick));
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
