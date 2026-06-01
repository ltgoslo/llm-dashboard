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
    // Mirror the page's --font-sans (see shared/style.css) so chart text
    // matches the rest of the dashboard.
    font: { family: "'Mona Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif", size: 13 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    margin: { l: 60, r: 20, t: 50, b: 80 },
    autosize: true,
    hovermode: "closest",
  }, overrides);
  const axisDefaults = { showline: false, zeroline: false, gridcolor: "#d8dce3" };
  result.xaxis = Object.assign({ automargin: true }, axisDefaults, result.xaxis);
  // Y-axis tick labels match .control-group label styling in shared/style.css:
  // 0.85rem (≈13.6px), weight 500, --fg-muted colour (#64748b).
  result.yaxis = Object.assign({
    tickfont: { size: 13.6, color: "#64748b", weight: 500 },
  }, axisDefaults, result.yaxis);
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

// Peak scale applied to a bar when the cursor is directly on it; matched
// in style.css's transition.
const BAR_HOVER_SCALE = 1.5;
// Attention kernel: 1 when the cursor is on (or inside) a bar's rect,
// decaying smoothly with distance to that rect. Lorentzian: 1/(1+(d/σ)²)
// over distance in bar-width units.
const HOVER_KERNEL_SIGMA = 0.25;
const hoverKernel = (d) => 1 / (1 + (d / HOVER_KERNEL_SIGMA) ** 2);
// Shortest distance from a point to a rectangle's interior; 0 if inside.
function distPointToRect(x, y, rect) {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}

// Every element the dock-hover moves needs a cached natural rect. Bars are
// the `.points` paths ONLY — deliberately NOT the sibling `.errorbar` paths,
// which Plotly nests in the same `.trace.bars` group; we track those
// separately so they ride along as their own group rather than being
// mistaken for extra bars.
const BAR_RECT_SELECTOR = ".barlayer .trace.bars .points path";
// Aux elements that follow the bars horizontally (translate only, no scale).
// Each is centred on the same x as its bar, so a shift that's a pure function
// of centre-x moves the whole column by an identical amount.
const AUX_SELECTORS = [
  ".barlayer .trace.bars .errorbar",   // error-bar I-beams (the <g>)
  ".imagelayer image",                 // org logos
  ".xtick",                            // x-axis tick labels
  ".annotation",                       // score labels
];
// Subset of AUX_SELECTORS that is genuinely centred on its column (upright,
// text-anchor middle), so each element's own bbox centre-x is the column x
// and a pure shiftAt(cx) is exact. x-tick labels are EXCLUDED: they may be
// angled (see computeTickAngle), which displaces their bbox centre away from
// the column, so they're shifted by their model column's value instead.
const CX_AUX_SELECTORS = [
  ".barlayer .trace.bars .errorbar",
  ".annotation",
];

// Cache one element's natural (pre-CSS-transform) screen rect + centre-x.
// We briefly clear any inline scale/translate (transitions blocked) inside a
// synchronous read so getBoundingClientRect sees the resting geometry and the
// browser never paints the cleared state.
function capRect(el) {
  const savedScale = el.style.scale;
  const savedTranslate = el.style.translate;
  const savedTransition = el.style.transition;
  const dirty = savedScale || savedTranslate;
  if (dirty) {
    el.style.transition = "none";
    el.style.scale = "";
    el.style.translate = "";
  }
  // getBoundingClientRect flushes pending style+layout, so the read reflects
  // the cleared transforms even though we set them a statement ago.
  const r = el.getBoundingClientRect();
  el._natRect = (r.width > 0 && r.height > 0)
    ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
        width: r.width, height: r.height, cx: (r.left + r.right) / 2 }
    : null;
  if (dirty) {
    el.style.scale = savedScale;
    el.style.translate = savedTranslate;
    // Flush the restored transforms while transitions are still off, so they
    // snap back rather than animating from the natural state.
    el.getBoundingClientRect();
    el.style.transition = savedTransition;
  }
}

// We DO NOT measure inside the hover handler — that path is hostile (an
// element may already carry inline scale/translate from the previous frame,
// and measuring then would fold the CSS into the rect, or return a
// partial-height rect if seeded mid-grow-up). Instead this runs at known
// clean points (after a fresh layout / after the grow-up completes).
function captureNaturalRects(chartEl) {
  chartEl.querySelectorAll(BAR_RECT_SELECTOR).forEach(capRect);
  AUX_SELECTORS.forEach((sel) =>
    chartEl.querySelectorAll(sel).forEach(capRect));
}

// Hover handlers ask this. Returns the captured natural rect or null. If
// null, the bar is skipped this frame — better to do nothing than guess.
function getBarNatRect(el) {
  return el._natRect || null;
}


/** SVG z-order is purely DOM order — later siblings render on top. With
 *  the plot clip-path disabled, bars/logos can now overflow into the
 *  y-axis label area on hover, but Plotly emits `.yaxislayer-above` AFTER
 *  `.overplot` (where bars live), so the labels paint on top.
 *  Lifting `.barlayer` out of `.overplot` is unsafe — `.overplot > .xy`
 *  carries the subplot's positioning transform that places the bars
 *  inside the plot rectangle, so moving barlayer out makes bars render
 *  at the wrong coordinates.
 *  Instead, do the reverse: move `.yaxislayer-above` to *before*
 *  `.overplot` in the subplot. That preserves all transforms and just
 *  reorders the painting so bars/logos paint on top. */
function liftBarsAndLogos(chartEl) {
  chartEl.querySelectorAll(".subplot.xy").forEach((subplot) => {
    const overplot = subplot.querySelector(".overplot");
    if (!overplot) return;
    const yaxisLabels = subplot.querySelector(":scope > .yaxislayer-above");
    if (yaxisLabels) subplot.insertBefore(yaxisLabels, overplot);
  });
  // UiO logo: pivot-point fix needs a reliable selector. Plotly inlines
  // the PNG as a base64 data URL on the DOM element, so we can't match
  // by `href` or by rendered dimensions (every logo gets the same sizex/
  // sizey). Instead, look up the original `source` from layout.images by
  // DOM index — that order is the same as the order images render in.
  const sources = (chartEl.layout && chartEl.layout.images) || [];
  chartEl.querySelectorAll(".imagelayer image").forEach((img, i) => {
    const src = (sources[i] && sources[i].source) || "";
    if (src.endsWith("uio.png")) img.classList.add("logo-uio");
    else img.classList.remove("logo-uio");
  });
}

/** Minimal continuous bar-hover: SCALE ONLY. No shifts, no aux movement.
 *
 *  Two passes per rAF-throttled mousemove tick:
 *    1. For every bar, derive { scale } from cursor's 2-D distance to the
 *       bar's NATURAL rect (cached, set once per layout in captureNaturalRects).
 *    2. Apply each bar's scale. Nothing else moves.
 *
 *  Boldness is the only side effect on aux elements — same as today:
 *  bold the xtick + annotation of the bar the cursor is inside. */
function attachBarHoverHighlight(chartEl) {
  if (chartEl._barHoverBound) return;
  chartEl._barHoverBound = true;

  let rafId = null;
  let lastEv = null;
  let currentBoldBar = null;

  function schedule(ev) {
    lastEv = ev;
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      apply(lastEv.clientX, lastEv.clientY);
    });
  }

  function apply(cursorX, cursorY) {
    // ── Pass 1 — scale per bar from the cursor's distance to it ──
    const traces = chartEl.querySelectorAll(".barlayer .trace.bars");
    if (!traces.length) return;
    const bars = [];
    let N = 0;
    traces.forEach((tr, traceIdx) => {
      const paths = tr.querySelectorAll(".points path");
      if (N === 0) N = paths.length;
      paths.forEach((bar, modelIdx) => {
        const rect = getBarNatRect(bar);
        if (!rect) return;
        bars.push({ el: bar, traceIdx, modelIdx, rect });
      });
    });
    if (!bars.length || N === 0) return;
    const refWidth = bars[0].rect.width;
    bars.forEach((b) => {
      b.dist = distPointToRect(cursorX, cursorY, b.rect);
      b.weight = hoverKernel(b.dist / refWidth);
      b.scale = 1 + (BAR_HOVER_SCALE - 1) * b.weight;
    });

    // ── Pass 1b — dock spread: shift everything so the gaps stay constant ──
    // A bar at scale s grows by e = (s−1)·width, half to each side. To keep
    // the resting gap between two neighbours, the relative shift between
    // adjacent columns must equal the average of their growths — i.e. a
    // cumulative sum of growths along x. We then sample that sum at the cursor
    // and subtract it, making the cursor the pivot: columns to its left slide
    // left, columns to its right slide right (the macOS dock). Because the
    // shift is a pure function of horizontal centre, a bar and its logo /
    // tick / score label / error bar — all centred on the same x — move by
    // the exact same amount.
    const colMap = new Map();
    bars.forEach((b) => {
      const key = Math.round(b.rect.cx);
      let c = colMap.get(key);
      if (!c) colMap.set(key, (c = { cx: b.rect.cx, exp: 0 }));
      c.exp = Math.max(c.exp, (b.scale - 1) * b.rect.width);
    });
    const cols = [...colMap.values()].sort((p, q) => p.cx - q.cx);
    const cum = [0];
    for (let k = 1; k < cols.length; k++) {
      cum[k] = cum[k - 1] + (cols[k - 1].exp + cols[k].exp) / 2;
    }
    // Cumulative offset at any x: linear between column centres, flat beyond
    // the ends (no growth past the last bar, so no extra spreading).
    const offsetAt = (x) => {
      if (x <= cols[0].cx) return cum[0];
      if (x >= cols[cols.length - 1].cx) return cum[cols.length - 1];
      let k = 1;
      while (k < cols.length && cols[k].cx < x) k++;
      const f = (x - cols[k - 1].cx) / (cols[k].cx - cols[k - 1].cx);
      return cum[k - 1] + f * (cum[k] - cum[k - 1]);
    };
    const anchor = offsetAt(cursorX);
    const shiftAt = (x) => offsetAt(x) - anchor;

    // ── Pass 2 — scale (bars only) + translate (bars AND every aux group) ──
    // Per-model column shift + scale, accumulated from the bars so that
    // index-matched aux (the angled x-tick labels, and the logos which also
    // magnify) can borrow their column's exact values rather than re-deriving
    // them from their own geometry.
    const modelShiftSum = new Array(N).fill(0);
    const modelShiftCnt = new Array(N).fill(0);
    const modelScale = new Array(N).fill(1);
    bars.forEach((b) => {
      const shift = shiftAt(b.rect.cx);
      b.el.style.scale = `${b.scale} 1`;
      b.el.style.translate = `${shift}px 0`;
      modelShiftSum[b.modelIdx] += shift;
      modelShiftCnt[b.modelIdx] += 1;
      if (b.scale > modelScale[b.modelIdx]) modelScale[b.modelIdx] = b.scale;
    });
    // Upright aux (score labels, error bars) are centred on their bar, so
    // their own centre-x gives the exact same shift as the bar.
    CX_AUX_SELECTORS.forEach((sel) => {
      chartEl.querySelectorAll(sel).forEach((el) => {
        const r = el._natRect;
        if (r) el.style.translate = `${shiftAt(r.cx)}px 0`;
      });
    });
    // Logos: shift AND magnify with their bar (matched by index). Scale is
    // uniform so the logo grows like a dock icon rather than stretching;
    // style.css anchors it bottom-centre so it grows up off the bar top.
    chartEl.querySelectorAll(".imagelayer image").forEach((el, i) => {
      if (i < N && modelShiftCnt[i]) {
        el.style.translate = `${modelShiftSum[i] / modelShiftCnt[i]}px 0`;
        el.style.scale = `${modelScale[i]} ${modelScale[i]}`;
      }
    });
    // x-tick labels: shift by the model column's value (matched by index to
    // the bar), since an angled label's bbox centre is offset from the column.
    chartEl.querySelectorAll(".xtick").forEach((el, i) => {
      if (i < N && modelShiftCnt[i]) {
        el.style.translate = `${modelShiftSum[i] / modelShiftCnt[i]}px 0`;
      }
    });

    // Boldness — bold the xtick + annotation of the bar the cursor is inside.
    chartEl.classList.add("hover-active");
    let inside = null;
    for (const b of bars) if (b.dist === 0) { inside = b; break; }
    if ((inside && inside.el) !== currentBoldBar) {
      chartEl.querySelectorAll(".bar-hover-bold").forEach((el) =>
        el.classList.remove("bar-hover-bold"));
      if (inside) {
        const xticks = chartEl.querySelectorAll(".xtick");
        const xt = xticks[inside.modelIdx];
        if (xt) xt.classList.add("bar-hover-bold");
        const annotations = chartEl.querySelectorAll(".annotation");
        const annPerModel = annotations.length
          ? Math.max(1, Math.round(annotations.length / N)) : 0;
        if (annPerModel > 0) {
          const annIdx = annPerModel === 1
            ? inside.modelIdx
            : inside.modelIdx * annPerModel
              + Math.min(inside.traceIdx, annPerModel - 1);
          const an = annotations[annIdx];
          if (an) an.classList.add("bar-hover-bold");
        }
      }
      currentBoldBar = inside ? inside.el : null;
    }
  }

  function reset() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    chartEl.querySelectorAll(BAR_RECT_SELECTOR).forEach((bar) => {
      bar.style.scale = "";
      bar.style.translate = "";
    });
    AUX_SELECTORS.forEach((sel) =>
      chartEl.querySelectorAll(sel).forEach((el) => { el.style.translate = ""; }));
    // Logos also magnify on hover, so drop their scale too.
    chartEl.querySelectorAll(".imagelayer image").forEach((el) => {
      el.style.scale = "";
    });
    chartEl.querySelectorAll(".bar-hover-bold").forEach((el) =>
      el.classList.remove("bar-hover-bold"));
    chartEl.classList.remove("hover-active");
    currentBoldBar = null;
  }

  chartEl.addEventListener("mousemove", schedule);
  chartEl.addEventListener("mouseleave", reset);
}

/** Scatter-mode hover: scale up the (disk + logo) the cursor is over.
 *
 *  Previously this hooked into Plotly's plotly_hover/unhover, which fire
 *  off the trace's invisible marker hit-test — a different geometry than
 *  the visible composite — and don't reliably fire unhover on slow exits.
 *  The tooltip uses those events fine because it tolerates flicker, but
 *  the animation needs a guaranteed reset when the cursor leaves a glyph.
 *
 *  Instead: pure DOM mousemove on the chart, hit-testing the cursor
 *  against the layout.image bboxes; topmost (last in paint order) wins.
 *  mouseleave on the chart container is the safety reset. The tooltip
 *  stays on plotly_hover/unhover, unchanged. */
function attachScatterHoverHighlight(chartEl) {
  const SCATTER_HOVER_SCALE = "1.4 1.4";
  let activeModel = null;
  let activeImgs = [];

  function applyModel(targetModel) {
    if (targetModel === activeModel) return;
    activeImgs.forEach((img) => { img.style.scale = ""; });
    activeImgs = [];
    activeModel = targetModel;
    if (targetModel == null) return;
    const map = chartEl._scatterImageMap || [];
    chartEl.querySelectorAll(".imagelayer image").forEach((img, i) => {
      if (map[i] === targetModel) {
        img.style.scale = SCATTER_HOVER_SCALE;
        activeImgs.push(img);
      }
    });
  }

  function pickModelFromCursor(ev) {
    const map = chartEl._scatterImageMap;
    if (!map) return null;
    const cx = ev.clientX, cy = ev.clientY;
    const imgs = chartEl.querySelectorAll(".imagelayer image");
    let pick = null;
    // Last hit wins → topmost in paint order.
    for (let i = 0; i < imgs.length; i++) {
      const r = imgs[i].getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
        pick = map[i];
      }
    }
    return pick;
  }

  // Idempotently bind: avoid stacking listeners on every re-render.
  // (Plotly.newPlot doesn't clear DOM listeners added via addEventListener.)
  if (chartEl._scatterHoverBound) return;
  chartEl._scatterHoverBound = true;
  chartEl.addEventListener("mousemove", (ev) => {
    applyModel(pickModelFromCursor(ev));
  });
  chartEl.addEventListener("mouseleave", () => applyModel(null));
}

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
  // Scatter-mode flag: lets style.css swap the logo transform-origin from
  // bottom-centre (bar-mode default, where logos sit at the chart floor)
  // to centre (scatter, where the logo is the data marker itself).
  const isScatterMode = barIndices.length === 0
    && traces.some((t) => t.type === "scatter" && t.mode && t.mode.indexOf("markers") !== -1);
  chartEl.classList.toggle("scatter-mode", isScatterMode);

  if (!shouldAnimate) {
    Plotly.newPlot("chart", traces, plotLayout, config).then(() => {
      liftBarsAndLogos(chartEl);
      // Bars are at full height immediately (no grow-up). Capture their
      // natural geometry now so the hover handler has a stable cache from
      // the first mousemove.
      if (barIndices.length) captureNaturalRects(chartEl);
    });
    liftBarsAndLogos(chartEl);
    if (onHover) chartEl.on("plotly_hover", onHover);
    if (onUnhover) chartEl.on("plotly_unhover", onUnhover);
    if (barIndices.length) attachBarHoverHighlight(chartEl);
    if (isScatterMode) attachScatterHoverHighlight(chartEl);
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

  Plotly.newPlot("chart", startTraces, startLayout, config).then(
    () => liftBarsAndLogos(chartEl));
  liftBarsAndLogos(chartEl);
  if (onHover) chartEl.on("plotly_hover", onHover);
  if (onUnhover) chartEl.on("plotly_unhover", onUnhover);
  attachBarHoverHighlight(chartEl);

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

    if (elapsed < totalDuration) {
      requestAnimationFrame(tick);
    } else {
      // Grow-up done. Capture the natural rects right now, while the
      // bars are at their final geometry and (if the user happened to
      // mouse over during the animation) any inline CSS gets cleared
      // briefly inside the capture function. After this point the hover
      // handler has a locked, correct cache.
      captureNaturalRects(chartEl);
    }
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

/** Create a shaded band trace around a line for asymmetric CI visualization.
 *  `ciValues` is an array of {loDist, hiDist} | null per x — distances below
 *  and above the line respectively. Pass the matching line trace's `name` as
 *  `legendGroup` so legend clicks toggle the band along with its line. */
export function makeBandTrace(xValues, yValues, ciValues, color, legendGroup) {
  const upper = [], lower = [], xs = [];
  for (let i = 0; i < xValues.length; i++) {
    if (yValues[i] != null && ciValues[i] != null) {
      xs.push(xValues[i]);
      upper.push(yValues[i] + (ciValues[i].hiDist ?? 0));
      lower.push(yValues[i] - (ciValues[i].loDist ?? 0));
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
