// Shared Plotly helpers — layout, modebar, export, color utilities, band traces.

import { state } from "./state.js";
import { isAggregateSelection, getAggregatedTasks, scoreScaleText } from "./core.js";

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

/** Trigger a client-side download of `data` as a pretty-printed JSON file. */
export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** The y-axis's tick labels. */
export const Y_TICK_FONT = { size: 13.6, color: "#535d6a", weight: 500 };

/** A number as an export gives it: at most 4 decimals (an integer, a token
 *  count, as it is). */
function exportNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v) ? +v.toFixed(4) : v ?? null;
}

/** An axis's title, if it has one. */
function axisTitle(axis) {
  const t = axis?.title;
  return (typeof t === "string" ? t : t?.text) || "";
}

/** Export the current chart's data as JSON: what it shows and how (the
 *  dashboard, the chart's title, what y and x are, the page's settings:
 *  `metadata`, from the page), then its values — on a comparison chart a
 *  record per model ({model, score, ci_95: [low, high]}, and on the scatter
 *  by size its parameters), on a progress chart a series per line, each a
 *  list of points ({x, y, ci_95}). Numbers to 4 decimals. */
export function exportChartDataAsJSON(gd, metadata, filename) {
  const { title, y_axis, x_axis, ...given } = metadata || {};
  const out = {
    dashboard: document.title,
    url: window.location.href,
    exported_at: new Date().toISOString(),
    chart: title ?? (document.getElementById("chart-title")?.textContent.trim() || axisTitle({ title: gd.layout.title })),
    y: y_axis ?? (axisTitle(gd.layout.yaxis) || scoreScaleText()),
  };
  const x = x_axis ?? axisTitle(gd.layout.xaxis);
  if (x) out.x = x;
  // The page's settings, without the empty ones; a task selection as the
  // tasks it averages over (or the one task).
  const settings = {};
  for (const [k, v] of Object.entries(given)) {
    if (v == null) continue;
    if (k === "task_selection") settings.tasks = isAggregateSelection(v) ? getAggregatedTasks().sort() : [v];
    else settings[k === "normalization" ? "rescaling" : k] = v;
  }
  out.settings = settings;
  const shown = (t) => t.visible !== false && t.visible !== "legendonly";
  const lines = gd.data.filter((t) => t.fill !== "toself" && shown(t));
  const bands = gd.data.filter((t) => t.fill === "toself" && shown(t));
  const ci = (y, hi, lo) => (y == null || hi == null ? undefined : [exportNumber(y - (lo ?? hi)), exportNumber(y + hi)]);
  const labelled = lines.filter((t) => Array.isArray(t.customdata) && t.customdata.some((d) => d?.label != null));
  if (labelled.length) {
    const seen = new Set();
    out.models = [];
    for (const t of labelled) {
      const horiz = t.orientation === "h";
      const valArr = horiz ? t.x : t.y;
      const errObj = horiz ? t.error_x : t.error_y;
      t.customdata.forEach((d, i) => {
        if (d?.label == null || seen.has(d.label)) return;
        seen.add(d.label);
        const score = valArr[i];
        const rec = { model: d.label, score: exportNumber(score) };
        if (t.type !== "bar") rec.parameters_b = exportNumber(t.x[i]);
        const range = ci(score, errObj?.array?.[i], errObj?.arrayminus?.[i]);
        if (range) rec.ci_95 = range;
        out.models.push(rec);
      });
    }
  } else {
    out.series = lines.map((t) => {
      // A line's band (its legend group's): its upper edge, then its lower
      // edge backwards, over the same xs.
      const band = bands.find((b) => b.legendgroup != null && b.legendgroup === t.legendgroup);
      const bandAt = new Map();
      if (band) {
        const n = band.x.length / 2;
        for (let i = 0; i < n; i++) bandAt.set(band.x[i], [band.y[2 * n - 1 - i], band.y[i]]);
      }
      const points = [];
      Array.from(t.x).forEach((xv, i) => {
        const y = t.y[i];
        if (y == null) return;
        const p = { x: exportNumber(xv), y: exportNumber(y) };
        const b = bandAt.get(xv);
        if (b) p.ci_95 = b.map(exportNumber);
        points.push(p);
      });
      return { name: t.name || null, points };
    });
  }
  downloadJSON(out, filename || "chart-data.json");
}

/** Build a Plotly config with the one download button: the chart's data
 *  as JSON. `filenamePrefix` names the file; `getJsonMetadata` is a
 *  callback that returns dashboard-specific export metadata. */
export function makePlotlyConfig(filenamePrefix, getJsonMetadata) {
  return {
    responsive: true,
    displaylogo: false,
    modeBarButtons: [
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
  const axisDefaults = { showline: false, zeroline: false, gridcolor: "#e2e8ef" };
  result.xaxis = Object.assign({ automargin: true }, axisDefaults, result.xaxis);
  // Y-axis tick labels match .control-group label styling in shared/style.css:
  // 0.85rem (≈13.6px), weight 500, --fg-muted colour (#535d6a).
  result.yaxis = Object.assign({ tickfont: { ...Y_TICK_FONT } }, axisDefaults, result.yaxis);
  return result;
}

/** The y-axis fragment shared by every dashboard chart: fixed range, grid
 *  lines only (no ticks), zeroline only under z-score normalization. */
export function makeYAxis(range) {
  return {
    title: "", range,
    showgrid: true, gridcolor: "#e2e8ef", zerolinecolor: "#cbd4df", automargin: false, ticks: "", ticklen: 0,
    zeroline: state.currentNormalization === "zscore",
  };
}

/** Plotly error_y fragment from an array of {loDist, hiDist}|null CI values;
 *  undefined when `ciValues` is null (CIs off). */
export function makeErrorY(ciValues) {
  if (!ciValues) return undefined;
  return {
    type: "data", symmetric: false,
    array: ciValues.map((c) => c?.hiDist ?? 0),
    arrayminus: ciValues.map((c) => c?.loDist ?? 0),
    visible: true,
    color: "rgba(0,0,0,0.5)", thickness: 2.4, width: 5,
  };
}

// Bar "grow-up" animation. Debounced so rapid renders (e.g. dragging the size
// slider) don't constantly re-animate. Instead of calling Plotly.update() on
// every frame (which rebuilds the SVG and forces layout reflows), we render
// the final geometry once via Plotly.react/newPlot and drive the already-drawn
// bar paths, error bars, and score annotations with pure CSS transforms and
// opacity inside requestAnimationFrame.
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
let plotRevision = 0;
/** The next plotChart draws the bars at once (a re-layout of the same
 *  chart, not a new one). */
export function holdBarAnimation() { lastPlotTime = Date.now(); }
let currentAnim = 0;   // monotonic id; in-flight rAF callbacks abort if outdated
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// Peak scale applied to a bar when the cursor is directly on it; matched
// in style.css's transition.
const BAR_HOVER_SCALE = 1.75;
// A click's pop: the clicked bar (its logo with it) grows BAR_POP_GROWTH of
// its width past its hover width at once (in BAR_POP_RISE_MS, a frame or
// two) and settles back to it (to rest, with no hover: a tap) over
// BAR_POP_FALL_MS; the other bars make room as they do for the hover. None
// where the reader asks for less motion.
const BAR_POP_GROWTH = 0.35;
const BAR_POP_RISE_MS = 30;
const BAR_POP_FALL_MS = 280;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
// Attention kernel: 1 when the cursor is on (or inside) a bar's rect,
// decaying smoothly with distance to that rect. Lorentzian: 1/(1+(d/σ)²)
// over distance in bar-width units.
const HOVER_KERNEL_SIGMA = 0.25;
const hoverKernel = (d) => 1 / (1 + (d / HOVER_KERNEL_SIGMA) ** 2);
// Dock-motion damping. ONLY the horizontal SHIFT is damped — the scale (the
// magnification itself) tracks the cursor directly, exactly like the dock.
// The shift is eased with an exponential smoother parameterised by a HALF-LIFE
// (ms to close half the remaining gap) and driven by the real frame
// delta-time, so the feel is identical at 60 / 120 / 144 Hz instead of running
// N× faster on a faster display. The per-frame factor is
//   alpha = 1 − 2^(−dt / halfLife).
// The half-life grades with the column's distance to the cursor: a bar under
// the cursor tracks it almost rigidly, distant bars trail — the soft "drag"
// the macOS dock has. On exit everything glides back at one rate.
const EMA_HALFLIFE_NEAR = 10;      // ms — column at the cursor (near-instant)
const EMA_HALFLIFE_FAR = 500;    // ms — column far from the cursor (trails)
const EMA_HALFLIFE_RETURN = 55;   // ms — easing back to rest after exit
// dt is clamped to this (ms) so a stutter or a backgrounded tab can't make the
// smoother jump in one giant step.
const EMA_MAX_DT = 64;
// Stop the loop once every column's shift is within this many px of target.
const EMA_SETTLE = 0.3;
const emaAlpha = (dt, halfLife) => 1 - Math.pow(2, -dt / halfLife);
// Falloff (in bar-width units) that grades the damping half-life with distance.
// This is DELIBERATELY MUCH BROADER than HOVER_KERNEL_SIGMA: that kernel is
// razor-sharp so only the hovered bar magnifies, but as a speed gradient it's
// near-binary — every non-hovered bar would collapse to the same FAR half-life
// and they'd all move at one speed. A wide falloff makes the trail-speed vary
// smoothly across many columns. Bigger ⇒ the slowness reaches further out.
const DAMP_SIGMA = 12;
const dampWeight = (d) => 1 / (1 + (d / DAMP_SIGMA) ** 2);
// Let the dock spread RELAX with distance so far bars don't carry the full
// push: their gaps compress slightly to absorb it. The gap-preserving shift is
// multiplied by a factor that fades from 1 (at the cursor — keep the magnified
// bar cleanly separated) toward SPREAD_FLOOR far away. SPREAD_RANGE (bar-width
// units) sets how quickly it relaxes. FLOOR = 1 ⇒ rigid, no compression (old
// behaviour); FLOOR = 0 ⇒ gaps absorb everything and far bars stay put.
const SPREAD_RANGE = 4;
const SPREAD_FLOOR = 0.5;
const spreadAtten = (d) => SPREAD_FLOOR + (1 - SPREAD_FLOOR) / (1 + (d / SPREAD_RANGE) ** 2);
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

// Batch-measure every bar's natural (pre-CSS-transform) screen rect + centre-x
// in a single layout flush (instead of 2×N flushes), and cache the resolved
// column DOM elements so the 60/120fps hover loop runs zero querySelectorAll.
function refreshBarDomCache(chartEl) {
  const traces = chartEl.querySelectorAll(".barlayer .trace.bars");
  if (!traces.length) { chartEl._barDomCache = null; return null; }
  const bars = [];
  const errorbars = [];
  let N = 0;
  traces.forEach((tr, traceIdx) => {
    const paths = tr.querySelectorAll(".points path");
    if (N === 0) N = paths.length;
    paths.forEach((bar, modelIdx) => {
      const rect = bar._natRect || null;
      if (rect) bars.push({ el: bar, traceIdx, modelIdx, rect });
    });
    tr.querySelectorAll(".errorbar").forEach((el, i) => {
      errorbars.push({ el, i });
    });
  });
  if (!bars.length || N === 0) { chartEl._barDomCache = null; return null; }
  const logos = [...chartEl.querySelectorAll(".imagelayer image")];
  const xticks = [...chartEl.querySelectorAll(".xtick")].map((el, i) => ({ el, m: tickColumn(el, i) }));
  const annPerModel = annotationsPerModel(chartEl, N);
  const annotations = annPerModel > 0
    ? [...chartEl.querySelectorAll(".annotation")].map((el, j) => ({
        el,
        m: annotationColumn(el, j, annPerModel),
        rawIdx: +(el.getAttribute("data-index") ?? j),
      }))
    : [];
  const cache = { bars, N, refWidth: bars[0].rect.width, logos, xticks, errorbars, annPerModel, annotations };
  chartEl._barDomCache = cache;
  return cache;
}

// We DO NOT measure inside the hover handler — that path is hostile (an
// element may already carry inline scale/translate from the previous frame,
// and measuring then would fold the CSS into the rect, or return a
// partial-height rect if seeded mid-grow-up). Instead this runs at known
// clean points (after a fresh layout / after the grow-up completes).
function captureNaturalRects(chartEl) {
  const barPaths = [...chartEl.querySelectorAll(BAR_RECT_SELECTOR)];
  const dirty = [];
  for (let i = 0; i < barPaths.length; i++) {
    const el = barPaths[i];
    const savedScale = el.style.scale;
    const savedTranslate = el.style.translate;
    if (savedScale || savedTranslate) {
      dirty.push({ el, savedScale, savedTranslate, savedTransition: el.style.transition });
      el.style.transition = "none";
      el.style.scale = "";
      el.style.translate = "";
    }
  }
  // One synchronous layout flush reads every bar's resting rect.
  for (let i = 0; i < barPaths.length; i++) {
    const el = barPaths[i];
    const r = el.getBoundingClientRect();
    el._natRect = (r.width > 0 && r.height > 0)
      ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
          width: r.width, height: r.height, cx: (r.left + r.right) / 2 }
      : null;
  }
  if (dirty.length) {
    for (let i = 0; i < dirty.length; i++) {
      const d = dirty[i];
      d.el.style.scale = d.savedScale;
      d.el.style.translate = d.savedTranslate;
    }
    // Single flush while transitions are still off so transforms snap back.
    dirty[0].el.getBoundingClientRect();
    for (let i = 0; i < dirty.length; i++) {
      dirty[i].el.style.transition = dirty[i].savedTransition;
    }
  }
  refreshBarDomCache(chartEl);
}

/** A mouseleave into Plotly's drag cover — laid over the page while a
 *  press lasts, so on every click — is no leaving: the mouse is still where
 *  it was (the hover would otherwise drop until it moves). */
function intoDragCover(ev) {
  return !!ev.relatedTarget?.classList?.contains("dragcover");
}

/** The bars moved on the screen without a redraw (the page around them
 *  slid): measure them again, and hover where the mouse is. */
export function refreshBarHover(chartEl) {
  if (!chartEl || chartEl._barAnimating) return;
  captureNaturalRects(chartEl);
  chartEl._barHoverRedrawn?.();
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

/** Extra vertical gap (px) between a legend's bold title and its first
 *  entry. Plotly has no layout option for this, and CSS transforms can't
 *  express it either (a CSS transform on the entry groups would *replace*
 *  their positioning `transform` attribute, collapsing the entries onto
 *  each other), so applyLegendTitleGap() rewrites the attribute instead. */
const LEGEND_TITLE_GAP = 8;

/** Push every titled legend's entry groups down by LEGEND_TITLE_GAP px.
 *  Applies to all legends ("legend", "legend2", …) that carry a title.
 *  Idempotent per draw: Plotly recomputes the transforms on each redraw,
 *  so we re-run on plotly_afterplot and detect whether the gap is already
 *  baked in by remembering the y we last wrote. */
function applyLegendTitleGap(chartEl) {
  chartEl.querySelectorAll(".infolayer > [class^='legend']").forEach((leg) => {
    // The title's class is namespaced by legend id: "legendtitletext",
    // "legend2titletext", … — match the common suffix.
    if (!leg.querySelector("[class$='titletext']")) return;
    leg.querySelectorAll(".scrollbox .groups").forEach((g) => {
      const t = g.getAttribute("transform") || "";
      const m = t.match(/translate\(\s*([-\d.eE+]+)[ ,]\s*([-\d.eE+]+)\s*\)/);
      const x = m ? parseFloat(m[1]) : 0;
      const y = m ? parseFloat(m[2]) : 0;
      if (g._gapY === y) return;              // gap already applied this draw
      g._gapY = y + LEGEND_TITLE_GAP;
      g.setAttribute("transform", `translate(${x}, ${g._gapY})`);
    });
  });
}

const LINE_CLIP_PAD = 10;   // px beyond each side of the plot rect so edge markers aren't half-clipped

/** Line-mode clipping: keep Plotly's plot-area clip vertically (so traces
 *  never spill above/under a fixed y-range) and pad it by LINE_CLIP_PAD px
 *  horizontally so markers at the first/last x-position aren't half-clipped
 *  while zoomed traces still stay clipped inside the plot box. Plotly
 *  REUSES this rect node across redraws/resizes/zooms and resets its
 *  x/width back to the tight plot bounds, so we re-apply on every
 *  plotly_afterplot, guarding against double-padding. */
function widenLineModeClip(chartEl) {
  const rects = chartEl.querySelectorAll(
    'clipPath.plotclip > rect, clipPath[id$="plot"] > rect'
  );
  rects.forEach((rect) => {
    const w = parseFloat(rect.getAttribute("width"));
    const x = parseFloat(rect.getAttribute("x")) || 0;
    if (!Number.isFinite(w) || w <= 0) return;
    if (rect._paddedW != null && Math.abs(w - rect._paddedW) < 0.5) return;
    const paddedW = w + LINE_CLIP_PAD * 2;
    rect._paddedW = paddedW;
    rect.setAttribute("x", String(x - LINE_CLIP_PAD));
    rect.setAttribute("width", String(paddedW));
  });
}

/** Continuous dock-style bar hover with EMA damping.
 *
 *  A self-sustaining rAF loop (NOT one frame per mousemove) eases every model
 *  column's {scale, horizontal shift} toward the target the cursor implies.
 *  Each column's EMA rate falls off with its distance to the cursor, so a bar
 *  under the cursor tracks it tightly while distant bars trail — the soft drag
 *  the macOS dock has. The loop keeps running after the cursor stops (to
 *  finish settling) and after it leaves (to glide back to rest), then stops
 *  itself so it isn't burning frames while idle; mousemove restarts it.
 *
 *  Everything is addressed per MODEL column (index 0..N-1): a bar and its
 *  logo / tick / score label / error bar all read the same column state, so
 *  they stay locked together and the damping is applied once per column.
 *  CSS transitions on these transforms are disabled (see style.css) so the
 *  JS EMA is the only smoothing. */
/** The model column of an x-axis tick: its value (the bars sit at 0..N-1).
 *  Plotly draws only the ticks and score labels inside the x-range — all of
 *  them, unless the chart pans (comparison.js) — so these are matched to
 *  their bar by their data, not by DOM order. */
function tickColumn(el, i) {
  const d = el.__data__;
  return d && typeof d.x === "number" ? Math.round(d.x) : i;
}
/** The model column of a score label (`data-index`: its layout index). */
function annotationColumn(el, j, annPerModel) {
  const k = el.getAttribute("data-index");
  return Math.floor((k == null ? j : +k) / annPerModel);
}
/** Score labels per model column: from the layout (the DOM holds only the
 *  ones in view). */
function annotationsPerModel(chartEl, N) {
  const total = chartEl.layout?.annotations?.length ?? chartEl.querySelectorAll(".annotation").length;
  return total ? Math.max(1, Math.round(total / N)) : 0;
}

function attachBarHoverHighlight(chartEl) {
  if (chartEl._barHoverBound) return;
  chartEl._barHoverBound = true;

  const pointer = { x: 0, y: 0, active: false };
  let rafId = null;
  let lastT = null;   // timestamp of the previous frame, for delta-time
  let currentBoldBar = null;
  // Displayed (eased) state, persisted across frames; rebuilt when the model
  // count changes. Sits at rest (scale 1, shift 0) between interactions.
  let curScale = null, curShift = null, stateN = 0;
  // A click's pop while it runs: { col: the model column, start: its time }.
  let pop = null;
  // The bar drawn under the pointer (its hover scale and shift applied) and
  // the last mousemove: the bar the page's tooltip names and a click opens
  // (comparison.js, by chartEl._onBarUnder and chartEl._barColumnAt), not the
  // one Plotly's hit-test finds — it knows only where the bars rest, so near
  // a magnified bar's edge it finds nothing, or a neighbour.
  let drawnBar = null, lastMove = null;

  /** The bar drawn under the point (x, y) as the bars are painted now, or
   *  null. (A column spans its bar's height; the gaps hit nothing.) */
  function drawnBarAt(bars, x, y) {
    for (const b of bars) {
      const i = b.modelIdx;
      const half = (b.rect.width / 2) * (curScale?.[i] ?? 1), cx = b.rect.cx + (curShift?.[i] ?? 0);
      if (x >= cx - half && x <= cx + half && y >= b.rect.top && y <= b.rect.bottom) return b;
    }
    return null;
  }

  /** The bar under the pointer now `b` (or null): the page is told when it
   *  changes, with the mousemove that moved it there. */
  function setDrawnBar(b) {
    if ((b && b.modelIdx) === (drawnBar && drawnBar.modelIdx)) { drawnBar = b; return; }
    drawnBar = b;
    chartEl._onBarUnder?.(b ? b.modelIdx : -1, lastMove);
  }

  /** The pop's added scale at time `now` (0 once it is over, which ends it):
   *  up at once, then eased back down. */
  function popBoost(now) {
    if (!pop) return 0;
    const t = Math.max(0, now - pop.start);
    if (t >= BAR_POP_RISE_MS + BAR_POP_FALL_MS) { pop = null; return 0; }
    return BAR_POP_GROWTH * (t < BAR_POP_RISE_MS
      ? easeOutCubic(t / BAR_POP_RISE_MS)
      : 1 - easeInOutCubic((t - BAR_POP_RISE_MS) / BAR_POP_FALL_MS));
  }

  function ensureState(N) {
    if (stateN !== N || !curScale) {
      curScale = new Array(N).fill(1);
      curShift = new Array(N).fill(0);
      stateN = N;
    }
  }

  // Read the cached column DOM lists + natural rects (refreshed on captureNaturalRects).
  // Returns null until captureNaturalRects has run for the current layout.
  function gatherBars() {
    const cache = chartEl._barDomCache;
    if (cache && cache.bars.length && cache.bars[0].el.isConnected) return cache;
    return refreshBarDomCache(chartEl);
  }

  // Per-model targets the current cursor implies: peak scale, dock shift,
  // distance (drives the EMA rate), and the bar the cursor sits inside (bold).
  //
  // The dock shift is the cumulative sum of column growths, sampled at the
  // cursor and subtracted so the cursor is the pivot — same maths as before,
  // but accumulated over MODEL columns so the result is indexed by model.
  // `cursor`: { x, y }, or null (no hover: every column at rest, but a
  // popping one, which is then the pivot); `extra`: { col, boost }, a click's
  // pop on top of the hover, or null.
  function computeTargets(bars, N, refWidth, cursor, extra) {
    const sumCx = new Array(N).fill(0);
    const cnt = new Array(N).fill(0);
    const scale = new Array(N).fill(1);
    const dist = new Array(N).fill(Infinity);
    let insideBar = null;
    bars.forEach((b) => {
      const i = b.modelIdx;
      sumCx[i] += b.rect.cx; cnt[i] += 1;
      if (!cursor) return;
      const d = distPointToRect(cursor.x, cursor.y, b.rect);
      if (!REDUCED_MOTION.matches) {
        const s = 1 + (BAR_HOVER_SCALE - 1) * hoverKernel(d / refWidth);
        if (s > scale[i]) scale[i] = s;
      }
      if (d < dist[i]) dist[i] = d;
      if (d === 0 && !insideBar) insideBar = b;
    });
    if (extra && extra.col < N) scale[extra.col] += extra.boost;
    const cx = cursor ? cursor.x : extra && cnt[extra.col] ? sumCx[extra.col] / cnt[extra.col] : 0;
    const order = [];
    for (let i = 0; i < N; i++) if (cnt[i]) order.push(i);
    order.sort((a, b) => sumCx[a] / cnt[a] - sumCx[b] / cnt[b]);
    const mcx = order.map((i) => sumCx[i] / cnt[i]);
    const exp = order.map((i) => (scale[i] - 1) * refWidth);
    const cum = [0];
    for (let k = 1; k < order.length; k++) cum[k] = cum[k - 1] + (exp[k - 1] + exp[k]) / 2;
    const offsetAt = (x) => {
      if (!order.length) return 0;
      if (x <= mcx[0]) return cum[0];
      if (x >= mcx[mcx.length - 1]) return cum[cum.length - 1];
      let k = 1;
      while (k < mcx.length && mcx[k] < x) k++;
      const f = (x - mcx[k - 1]) / (mcx[k] - mcx[k - 1]);
      return cum[k - 1] + f * (cum[k] - cum[k - 1]);
    };
    const anchor = offsetAt(cx);
    const shift = new Array(N).fill(0);
    // Gap-preserving shift, then relaxed by distance so far columns travel less
    // (their gaps take up the slack). The fade is gentle enough that the shift
    // stays monotonic in x — bars compress, never cross.
    order.forEach((i, k) => {
      shift[i] = (offsetAt(mcx[k]) - anchor) * spreadAtten(Math.abs(mcx[k] - cx) / refWidth);
    });
    return { scale, shift, dist, insideBar };
  }

  // Write the current (eased) per-column state onto every element of each
  // column. Bars scale in x only (height encodes the score); logos scale
  // uniformly like a dock icon. Uses the cached DOM lists (zero querySelectorAll).
  function paint(got) {
    const { bars, N, logos, xticks, errorbars, annotations } = got;
    for (let k = 0; k < bars.length; k++) {
      const b = bars[k], i = b.modelIdx;
      b.el.style.scale = `${curScale[i]} 1`;
      b.el.style.translate = `${curShift[i]}px 0`;
    }
    for (let i = 0; i < logos.length && i < N; i++) {
      const s = curScale[i];
      logos[i].style.scale = `${s} ${s}`;
      logos[i].style.translate = `${curShift[i]}px 0`;
    }
    for (let k = 0; k < xticks.length; k++) {
      const { el, m } = xticks[k];
      if (m < N) el.style.translate = `${curShift[m]}px 0`;
    }
    for (let k = 0; k < errorbars.length; k++) {
      const { el, i } = errorbars[k];
      if (i < N) el.style.translate = `${curShift[i]}px 0`;
    }
    for (let k = 0; k < annotations.length; k++) {
      const { el, m } = annotations[k];
      if (m < N) el.style.translate = `${curShift[m]}px 0`;
    }
    // Elements the page draws in a model's column (comparison.js: the open
    // model's band) widen and move with its bar.
    for (const { el, modelIdx } of chartEl._barFollowers?.() || []) {
      if (modelIdx >= N) continue;
      el.style.scale = `${curScale[modelIdx]} 1`;
      el.style.translate = `${curShift[modelIdx]}px 0`;
    }
  }

  // Bold the xtick + score label of the column the cursor sits inside.
  function updateBold(insideBar, got) {
    if ((insideBar && insideBar.el) === currentBoldBar) return;
    chartEl.querySelectorAll(".bar-hover-bold").forEach((el) =>
      el.classList.remove("bar-hover-bold"));
    if (insideBar) {
      const xt = got.xticks.find((x) => x.m === insideBar.modelIdx);
      if (xt) xt.el.classList.add("bar-hover-bold");
      if (got.annPerModel > 0) {
        const annIdx = got.annPerModel === 1
          ? insideBar.modelIdx
          : insideBar.modelIdx * got.annPerModel + Math.min(insideBar.traceIdx, got.annPerModel - 1);
        const an = got.annotations.find((a) => a.rawIdx === annIdx);
        if (an) an.el.classList.add("bar-hover-bold");
      }
    }
    currentBoldBar = insideBar ? insideBar.el : null;
  }

  // Drop all inline transforms so elements return to their natural geometry.
  function clearInline(got) {
    for (const b of got.bars) { b.el.style.scale = ""; b.el.style.translate = ""; }
    for (const el of got.logos) { el.style.scale = ""; el.style.translate = ""; }
    for (const x of got.xticks) x.el.style.translate = "";
    for (const e of got.errorbars) e.el.style.translate = "";
    for (const a of got.annotations) a.el.style.translate = "";
    for (const { el } of chartEl._barFollowers?.() || []) { el.style.scale = ""; el.style.translate = ""; }
  }

  function frame(now) {
    rafId = null;
    // Real delta-time since the last frame, clamped to (0, EMA_MAX_DT]. null on
    // the first frame of a run (loop was idle) — use a nominal 16 ms. The lower
    // bound keeps emaAlpha well-defined even if a half-life is 0.
    const dt = lastT === null ? 16 : Math.max(1, Math.min(EMA_MAX_DT, now - lastT));
    lastT = now;

    const got = gatherBars();
    if (!got) {
      // Natural rects not captured yet; keep waiting while the cursor's on us.
      if (pointer.active) rafId = requestAnimationFrame(frame);
      else lastT = null;
      return;
    }
    const { bars, N, refWidth } = got;
    ensureState(N);

    const boost = popBoost(now);
    const extra = pop ? { col: pop.col, boost } : null;
    const targets = pointer.active || extra
      ? computeTargets(bars, N, refWidth, pointer.active ? pointer : null, extra)
      : { scale: new Array(N).fill(1), shift: new Array(N).fill(0), dist: null, insideBar: null };

    // Pre-compute the exit alpha once; per-column alpha (active) interpolates
    // the half-life by the cursor-distance weight, then converts with dt.
    const returnAlpha = emaAlpha(dt, EMA_HALFLIFE_RETURN);

    // SCALE follows the target directly (no damping) — the magnification is a
    // direct function of cursor proximity, like the dock. Only the SHIFT is
    // eased, with a distance-graded half-life. Track the largest shift residual
    // so we know when the row has settled.
    let maxRes = 0;
    for (let i = 0; i < N; i++) {
      curScale[i] = targets.scale[i];
      const a = pointer.active
        ? emaAlpha(dt, EMA_HALFLIFE_FAR
            + (EMA_HALFLIFE_NEAR - EMA_HALFLIFE_FAR) * dampWeight(targets.dist[i] / refWidth))
        : returnAlpha;
      curShift[i] += a * (targets.shift[i] - curShift[i]);
      maxRes = Math.max(maxRes, Math.abs(targets.shift[i] - curShift[i]));
    }
    paint(got);
    setDrawnBar(pointer.active ? drawnBarAt(bars, pointer.x, pointer.y) : null);

    if (pointer.active) {
      chartEl.classList.add("hover-active");
      updateBold(drawnBar, got);
    }

    if (maxRes < EMA_SETTLE && !pop) {
      // Snap exactly onto target to kill sub-pixel drift, then stop the loop.
      // lastT is reset so the next run (restarted by mousemove) starts fresh.
      for (let i = 0; i < N; i++) { curScale[i] = targets.scale[i]; curShift[i] = targets.shift[i]; }
      lastT = null;
      if (pointer.active) {
        paint(got);   // rest at the hover pose; idle until the next move
        setDrawnBar(drawnBarAt(bars, pointer.x, pointer.y));
        updateBold(drawnBar, got);
      } else {
        setDrawnBar(null);
        clearInline(got);
        chartEl.querySelectorAll(".bar-hover-bold").forEach((el) =>
          el.classList.remove("bar-hover-bold"));
        chartEl.classList.remove("hover-active");
        currentBoldBar = null;
      }
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  function ensureLoop() { if (rafId === null) rafId = requestAnimationFrame(frame); }

  // A redraw — each step of a panning chart's pan (bar-pan.js) — rebuilds the
  // score labels (and the ticks that come into view) without their inline
  // transforms, and moves the bars under a cursor that may not move at all (a
  // trackpad swipe sends no mousemove). Put the hover pose back on everything
  // at once (afterplot runs before the frame is painted, so the labels never
  // show off their bars), and let the loop retarget from the bars' new places.
  chartEl._barHoverRedrawn = () => {
    if (!curScale || (!pointer.active && rafId === null)) return;   // at rest
    const got = gatherBars();
    if (!got || got.N !== stateN) return;
    paint(got);
    currentBoldBar = null;   // the rebuilt score label lost its bold
    ensureLoop();
  };

  chartEl._resetBarHover = () => {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    lastT = null;
    pop = null;
    currentBoldBar = null;
    drawnBar = null;
    if (curScale) curScale.fill(1);
    if (curShift) curShift.fill(0);
    const cache = chartEl._barDomCache;
    if (cache) clearInline(cache);
    chartEl.querySelectorAll(".bar-hover-bold").forEach((el) => el.classList.remove("bar-hover-bold"));
    chartEl.classList.remove("hover-active");
  };

  /** A click (or tap) on the bar of model column `col`: its pop. */
  chartEl._barPop = (col) => {
    if (REDUCED_MOTION.matches || !Number.isInteger(col) || col < 0) return;
    pop = { col, start: performance.now() };
    ensureLoop();
  };

  /** The model column of the bar drawn under (x, y) now, or -1. */
  chartEl._barColumnAt = (x, y) => {
    const got = gatherBars();
    const b = got && drawnBarAt(got.bars, x, y);
    return b ? b.modelIdx : -1;
  };

  chartEl.addEventListener("mousemove", (ev) => {
    pointer.x = ev.clientX; pointer.y = ev.clientY; pointer.active = true;
    lastMove = ev;
    ensureLoop();
  });
  chartEl.addEventListener("mouseleave", (ev) => {
    if (intoDragCover(ev)) return;
    pointer.active = false;
    ensureLoop();
  });
}

/** Scatter-mode hover: smoothly MAGNIFY each marker by the cursor's proximity
 *  to it — a soft magnifier like the bars' dock scaling, but markers only grow,
 *  they don't move. Scale is a continuous function of distance (peaks under the
 *  cursor, falls off with a Lorentzian over a few marker-radii); the CSS `scale`
 *  transition (kept in scatter mode) smooths it between mousemove samples.
 *
 *  Marker centres are invariant under the centred scale, so we can measure them
 *  live even while a marker is mid-magnify; a magnified marker's measured radius
 *  is inflated, so the rest radius is taken as the min across models.
 *
 *  Pure DOM mousemove (the tooltip still rides Plotly's plotly_hover/unhover,
 *  unchanged); mouseleave is the safety reset. */
function attachScatterHoverHighlight(chartEl) {
  const SCATTER_PEAK_SCALE = 2;   // peak magnification at the cursor
  const SCATTER_SIGMA = 0.75;     // magnify falloff, in marker-radius units
  // Repulsion declutter — a per-frame force RELAXATION (not a static vector).
  // Each frame we recompute overlaps from the markers' CURRENT positions, so a
  // marker pushed into a new neighbour is in turn pushed by it: collisions
  // cascade and resolve. A spring pulls every marker back to rest, and the
  // cursor's proximity gates how much push it feels — so a cluster eases apart
  // as the cursor nears and relaxes back as it leaves.
  const SPREAD_SIGMA = 2.5;       // proximity gate for the push, in radii
  const SPREAD_PAD = 1.0;         // separate until gap = (rᵢ+rⱼ)·PAD
  const REPULSE = 0.3;           // push accel per px of overlap (per 60 fps frame)
  const SPRING = 0.3;            // pull back to rest (per 60 fps frame)
  const MOBILITY = 0.5;           // integration gain (per 60 fps frame)
  const SPREAD_MAX = 4;         // cap a marker's displacement at × its radius
  // Hit radius as a fraction of the measured bbox half-extent: only the SOLID
  // coloured interior counts, not the white border ring. The disk SVG (see
  // comparison.js coloredDiskDataUrl) is circle r=30 + stroke-width 2 in a
  // 64-unit viewBox (half = 32), so the colour fills r<29 → 29/32. Scale-
  // invariant, since both bbox and border scale together.
  const SCATTER_HIT_FRAC = 29 / 32;
  const SCATTER_SETTLE = 0.15;    // px/frame; stop the loop below this motion
  const HALO_SCALE = 1.6;         // focus halo reaches this multiple of the
                                  // marker radius (white starts AT the edge,
                                  // fades to transparent at HALO_SCALE×).
  // Visible disk edge as a fraction of the measured bbox half-extent: the disk
  // SVG is r=30 + stroke 2 in a 64-unit viewBox, "contain"-fit, so the outer
  // edge sits at 31/32. Used so the halo starts exactly at the marker's rim.
  const DISK_EDGE_FRAC = 31 / 32;

  const pointer = { x: 0, y: 0, active: false };
  let rafId = null, lastT = null, currentTop = null;
  let snap = null;                // { list:[{model,cx,cy,r}], idx:Map(model→i) }
  let dispX = null, dispY = null; // per-marker displacement from rest (px)
  let scaleState = null;          // last frame's magnify scale (for edge calc)

  // Tag each image with its model the first time we see a fresh (untagged) set
  // — right after a render, when DOM order still matches the positional
  // _scatterImageMap. Keying off the tag (not the live index) lets our z-order
  // reshuffling persist without desyncing the lookup; only a fresh Plotly
  // redraw (new, untagged nodes) re-tags, which also re-snapshots rest geometry
  // and zeroes the displacement. Returns the image list, or null.
  function taggedImages() {
    const map = chartEl._scatterImageMap;
    if (!map) return null;
    const imgs = [...chartEl.querySelectorAll(".imagelayer image")];
    if (!imgs.length) return null;
    if (imgs.some((img) => !img._scatterTagged)) {
      imgs.forEach((img, i) => { img._scatterTagged = true; img._scatterModel = map[i]; });
      currentTop = null;
      snapshotRest(imgs);
    }
    return imgs;
  }

  // Snapshot each model's RESTING centre + radius (measured at a clean moment:
  // fresh, untransformed nodes). The simulation springs toward these rest
  // positions; the forces themselves are recomputed live from rest + disp.
  function snapshotRest(imgs) {
    const g = new Map();
    imgs.forEach((img) => {
      const model = img._scatterModel;
      if (model == null) return;
      const r = img.getBoundingClientRect();
      if (!(r.width > 0)) return;
      let m = g.get(model);
      if (!m) g.set(model, (m = { model, cx: 0, cy: 0, r: 0, n: 0 }));
      m.cx += r.left + r.width / 2;
      m.cy += r.top + r.height / 2;
      m.r = Math.max(m.r, Math.min(r.width, r.height) / 2);
      m.n += 1;
    });
    const list = [], idx = new Map();
    g.forEach((m) => {
      idx.set(m.model, list.length);
      list.push({ model: m.model, cx: m.cx / m.n, cy: m.cy / m.n, r: m.r });
    });
    snap = { list, idx };
    dispX = new Float64Array(list.length);
    dispY = new Float64Array(list.length);
    scaleState = new Float64Array(list.length).fill(1);
  }

  // Hit model: the topmost (last-painted) marker whose CURRENT disk is under
  // the cursor. Iterating DOM order and overwriting means the frontmost match
  // wins — a lifted marker keeps the hit while the cursor's on it (no flicker),
  // and it honours the live paint order, not a fixed data order. Uses the
  // current (possibly moved/scaled) bbox so the hit follows what's on screen.
  function hitTest(imgs, cursorX, cursorY) {
    let hitModel = null;
    imgs.forEach((img) => {
      const r = img.getBoundingClientRect();
      if (!(r.width > 0)) return;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (Math.hypot(cursorX - cx, cursorY - cy) <= Math.min(r.width, r.height) / 2 * SCATTER_HIT_FRAC) {
        hitModel = img._scatterModel;
      }
    });
    return hitModel;
  }

  // Lift a model's images to the front (end of the layer; SVG paints the last
  // sibling on top) and LEAVE them there — every other marker keeps its current
  // order, so lifts accumulate and persist after the cursor leaves.
  function bringToFront(model) {
    if (model == null || model === currentTop) return;
    currentTop = model;
    chartEl.querySelectorAll(".imagelayer image").forEach((img) => {
      if (img._scatterModel === model && img.parentNode) img.parentNode.appendChild(img);
    });
  }

  // A single overlay div holding a white radial-gradient ring, parked over the
  // focused marker (transparent centre → the marker shows through; white ring
  // fades outward, reading as a light moat against overlapping neighbours).
  // SVG <image> can't carry a CSS gradient, so a positioned overlay is the
  // simplest way to get one. Fixed-position in viewport coords (matches
  // getBoundingClientRect); pointer-events none so it never blocks hovering.
  function halo() {
    let h = chartEl._scatterHalo;
    if (!h) {
      h = document.createElement("div");
      h.className = "scatter-focus-halo";
      // The white starts at the marker edge — which sits at 1/HALO_SCALE of the
      // div radius (the div spans HALO_SCALE× the marker radius) — and fades to
      // transparent at the edge. `closest-side` makes 100% land on the div's
      // own edge (not its corner), so border-radius can't hard-cut a non-zero
      // alpha → a smooth fade. Set here so it stays in sync with HALO_SCALE.
      const edge = (100 / HALO_SCALE).toFixed(2);
      h.style.background = `radial-gradient(circle closest-side, `
        + `rgba(255,255,255,0) ${edge}%, `
        + `rgba(255,255,255,0.5) ${edge}%, `
        + `rgba(255,255,255,0) 100%)`;
      document.body.appendChild(h);
      chartEl._scatterHalo = h;
    }
    return h;
  }

  // Park the halo over the focused model's DISK (the data-URL image, not the
  // logo), sized so the white ring begins exactly at the disk's rim. Hidden
  // when nothing is focused.
  function placeHalo(model, imgs) {
    const h = halo();
    if (model == null) { h.style.opacity = "0"; return; }
    let disk = null;
    for (const img of imgs) {
      if (img._scatterModel !== model) continue;
      const href = img.getAttribute("href") || img.getAttribute("xlink:href") || "";
      if (href.startsWith("data:")) { disk = img; break; }   // the coloured disk
      if (!disk) disk = img;                                  // fallback: first
    }
    const r = disk && disk.getBoundingClientRect();
    if (!r || !(r.width > 0)) { h.style.opacity = "0"; return; }
    // Visible marker radius, then the halo radius = HALO_SCALE× that, so the
    // edge lands at 1/HALO_SCALE of the div (matching the gradient stop).
    const markerR = Math.min(r.width, r.height) / 2 * DISK_EDGE_FRAC;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const d = markerR * HALO_SCALE;
    h.style.left = `${cx - d}px`;
    h.style.top = `${cy - d}px`;
    h.style.width = h.style.height = `${2 * d}px`;
    h.style.opacity = "1";
  }

  // Drive the shared tooltip from the SAME hit as the magnify + lift, reusing
  // the chart's own hover callback so the content matches exactly. This keeps
  // tooltip, magnify, and z-order in lockstep — all on the live paint order.
  function driveTooltip(hitModel, cursorX, cursorY) {
    const onHover = chartEl._scatterOnHover, onUnhover = chartEl._scatterOnUnhover;
    if (hitModel != null && onHover) {
      const tr = chartEl.data && chartEl.data[0];
      if (tr) {
        onHover({
          points: [{
            x: tr.x[hitModel], y: tr.y[hitModel],
            customdata: tr.customdata && tr.customdata[hitModel], data: tr,
          }],
          event: { clientX: cursorX, clientY: cursorY },
        });
        return;
      }
    }
    if (onUnhover) onUnhover();
  }

  function frame(now) {
    rafId = null;
    // Bound once per chart element, these handlers outlive a switch from the
    // scatter to the bar chart. Outside scatter mode there is nothing to do —
    // acting on the last scatter's image map would retarget the bar chart's
    // logos and hide or replace its tooltip.
    if (!chartEl.classList.contains("scatter-mode")) { lastT = null; return; }
    const dt = lastT === null ? 16 : Math.max(1, Math.min(EMA_MAX_DT, now - lastT));
    lastT = now;
    const dtN = dt / 16;   // frames elapsed (normalised to 60 fps)

    const imgs = taggedImages();
    if (!imgs || !snap) {
      if (pointer.active) rafId = requestAnimationFrame(frame);
      else lastT = null;
      return;
    }
    const list = snap.list, N = list.length;
    let refR = Infinity;
    for (const m of list) refR = Math.min(refR, m.r);
    if (!isFinite(refR) || refR <= 0) refR = 16;
    const magDenom = SCATTER_SIGMA * refR, sprDenom = SPREAD_SIGMA * refR;

    // Per-marker cursor proximity (gates the push), magnify scale, and the
    // resulting CURRENT (scaled) radius used for the overlap test.
    //
    // The spread gate W keys off the REST centre (stable input to the sim). The
    // magnify S keys off the CURRENT edge: distance from the cursor to the
    // marker as it actually is right now — current centre (rest + displacement)
    // minus current radius (rest × last frame's scale). Reusing the previous
    // scale relaxes the self-reference across frames; it converges and is
    // bounded by SCATTER_PEAK_SCALE, giving a slightly "magnetic" grow.
    const W = new Float64Array(N), S = new Float64Array(N), R = new Float64Array(N);
    const reduced = REDUCED_MOTION.matches;
    for (let i = 0; i < N; i++) {
      const m = list[i];
      if (pointer.active && !reduced) {
        const dcRest = Math.hypot(pointer.x - m.cx, pointer.y - m.cy);
        W[i] = 1 / (1 + (dcRest / sprDenom) ** 2);
        const dcCur = Math.hypot(pointer.x - (m.cx + dispX[i]), pointer.y - (m.cy + dispY[i]));
        const edge = Math.max(0, dcCur - m.r * scaleState[i]);
        const wm = 1 / (1 + (edge / magDenom) ** 2);
        S[i] = 1 + (SCATTER_PEAK_SCALE - 1) * wm;
      } else { W[i] = 0; S[i] = 1; }
      scaleState[i] = S[i];
      R[i] = m.r * S[i];
    }

    // Forces: spring to rest + pairwise repulsion from CURRENT overlaps.
    // Recomputing from current positions each frame is what lets a displaced
    // marker collide with a NEW neighbour and be pushed back — the cascade
    // resolves over successive frames instead of in one blind shove.
    const Fx = new Float64Array(N), Fy = new Float64Array(N);
    for (let i = 0; i < N; i++) { Fx[i] = -SPRING * dispX[i]; Fy[i] = -SPRING * dispY[i]; }
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const ax = list[i].cx + dispX[i], ay = list[i].cy + dispY[i];
        const bx = list[j].cx + dispX[j], by = list[j].cy + dispY[j];
        const dx = ax - bx, dy = ay - by;
        const d = Math.hypot(dx, dy);
        const overlap = (R[i] + R[j]) * SPREAD_PAD - d;   // current (scaled) radii
        if (overlap <= 0) continue;              // disjoint → no force
        let ux, uy;
        if (d < 1e-3) { const a = list[i].model * 2.39996; ux = Math.cos(a); uy = Math.sin(a); }
        else { ux = dx / d; uy = dy / d; }
        const f = REPULSE * overlap;
        Fx[i] += ux * f * W[i]; Fy[i] += uy * f * W[i];   // gated by proximity
        Fx[j] -= ux * f * W[j]; Fy[j] -= uy * f * W[j];
      }
    }

    // Integrate (overdamped — no inertia, so it can't oscillate) and clamp.
    let maxStep = 0;
    for (let i = 0; i < N; i++) {
      const sx = Fx[i] * MOBILITY * dtN, sy = Fy[i] * MOBILITY * dtN;
      dispX[i] += sx; dispY[i] += sy;
      const mag = Math.hypot(dispX[i], dispY[i]), cap = SPREAD_MAX * list[i].r;
      if (mag > cap && mag > 0) { const k = cap / mag; dispX[i] *= k; dispY[i] *= k; }
      maxStep = Math.max(maxStep, Math.hypot(sx, sy));
    }

    // Read (hit-test) before writing styles, to avoid layout read/write churn.
    const hitModel = pointer.active ? hitTest(imgs, pointer.x, pointer.y) : null;
    imgs.forEach((img) => {
      const i = snap.idx.get(img._scatterModel);
      if (i == null) return;
      const s = S[i];
      img.style.scale = s > 1.005 ? `${s} ${s}` : "";
      const tx = dispX[i], ty = dispY[i];
      img.style.translate = (Math.abs(tx) > 0.05 || Math.abs(ty) > 0.05) ? `${tx}px ${ty}px` : "";
    });
    bringToFront(hitModel);
    placeHalo(hitModel, imgs);
    driveTooltip(hitModel, pointer.x, pointer.y);

    if (maxStep < SCATTER_SETTLE) {
      lastT = null;
      if (!pointer.active) {
        // Fully relaxed back to rest: clear residual inline transforms.
        for (let i = 0; i < N; i++) { dispX[i] = 0; dispY[i] = 0; }
        imgs.forEach((img) => { img.style.scale = ""; img.style.translate = ""; });
      }
      return;   // idle until the next mousemove / mouseleave
    }
    rafId = requestAnimationFrame(frame);
  }

  function ensureLoop() { if (rafId === null) rafId = requestAnimationFrame(frame); }

  // Idempotently bind: avoid stacking listeners on every re-render.
  // (Plotly.newPlot doesn't clear DOM listeners added via addEventListener.)
  if (chartEl._scatterHoverBound) return;
  chartEl._scatterHoverBound = true;
  chartEl.addEventListener("mousemove", (ev) => {
    pointer.x = ev.clientX; pointer.y = ev.clientY; pointer.active = true;
    ensureLoop();
  });
  chartEl.addEventListener("mouseleave", (ev) => {
    if (intoDragCover(ev)) return;
    pointer.active = false;   // springs relax everything back to rest
    ensureLoop();
  });
  // Touch screens send no mousemove (Plotly takes over the touch): a tap
  // focuses the point under the finger as hovering does, and a tap
  // elsewhere on the page lets the markers relax.
  chartEl.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType !== "touch") return;
    pointer.x = ev.clientX; pointer.y = ev.clientY; pointer.active = true;
    ensureLoop();
  });
  document.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType !== "touch" || chartEl.contains(ev.target) || !pointer.active) return;
    pointer.active = false;
    ensureLoop();
  });
}

// Bind Plotly's EventEmitter callbacks once per chart element and forward to
// mutable slots, so Plotly.react never stacks duplicate listeners across renders.
function ensurePlotEventDispatchers(chartEl) {
  if (chartEl._plotEventsBound || typeof chartEl.on !== "function") return;
  chartEl._plotEventsBound = true;
  chartEl.on("plotly_hover", (d) => chartEl._cbHover?.(d));
  chartEl.on("plotly_click", (d) => chartEl._cbClick?.(d));
  chartEl.on("plotly_unhover", (d) => chartEl._cbUnhover?.(d));
  chartEl.on("plotly_afterplot", () => {
    chartEl._cbLineAfterplot?.();
    chartEl._cbBarRecapture?.();
  });
}

/** Collect the already-drawn bar paths, error bars, and score annotations so
 *  the grow-up animation can drive them purely with CSS scale/translate/opacity
 *  (zero Plotly.update calls per frame). Returns { apply(p1, e1, e2), clean() }
 *  or null if the axis isn't ready yet. */
function buildBarAnimDrivers(chartEl, traces, barIndices, horizontal, vk, errKey, annotationsTarget, annAnim) {
  const fl = chartEl._fullLayout;
  const axis = horizontal ? fl?.xaxis : fl?.yaxis;
  if (!axis || typeof axis.c2p !== "function") return null;

  const barItems = [];
  const errItems = [];
  const traceGroups = chartEl.querySelectorAll(".barlayer .trace.bars");
  traceGroups.forEach((trEl, gIdx) => {
    const traceIdx = barIndices[gIdx];
    const trace = traceIdx != null ? traces[traceIdx] : null;
    if (!trace) return;
    const vals = trace[vk] || [];
    const err = trace[errKey];
    const hiArr = err?.array || null;
    const loArr = err?.arrayminus || hiArr;

    trEl.querySelectorAll(".points path").forEach((el, j) => {
      const idx = el.__data__?.i ?? j;
      const val = vals[idx];
      if (val == null || !Number.isFinite(val)) return;
      el.style.transformBox = "fill-box";
      el.style.transformOrigin = horizontal
        ? (val < 0 ? "100% 50%" : "0% 50%")
        : (val < 0 ? "50% 0%" : "50% 100%");
      barItems.push(el);
    });

    if (hiArr) {
      trEl.querySelectorAll(".errorbar").forEach((g, j) => {
        const idx = g.__data__?.i ?? j;
        const val = vals[idx];
        const hi = hiArr[idx] || 0;
        const lo = (loArr ? loArr[idx] : hi) || 0;
        if (val == null || !Number.isFinite(val) || hi + lo <= 0) return;
        const tipPct = horizontal
          ? (lo / (hi + lo)) * 100
          : (hi / (hi + lo)) * 100;
        g.style.transformBox = "fill-box";
        g.style.transformOrigin = horizontal ? `${tipPct}% 50%` : `50% ${tipPct}%`;
        errItems.push({ el: g, val, pFinal: axis.c2p(val) });
      });
    }
  });

  const annItems = [];
  if (annotationsTarget.length) {
    chartEl.querySelectorAll(".infolayer .annotation").forEach((el, j) => {
      const rawIdx = el.getAttribute("data-index");
      const idx = rawIdx == null ? j : +rawIdx;
      const a = annotationsTarget[idx];
      if (!a) return;
      const meta = annAnim && annAnim[idx];
      const finalPos = meta ? (meta.score + meta.se) : (typeof a[vk] === "number" ? a[vk] : null);
      if (finalPos == null || !Number.isFinite(finalPos)) return;
      annItems.push({
        el,
        score: meta ? meta.score : finalPos,
        se: meta ? meta.se : 0,
        pFinal: axis.c2p(finalPos),
      });
    });
  }

  function apply(p1, e1, e2) {
    const barScale = horizontal ? `${e1} 1` : `1 ${e1}`;
    for (let i = 0; i < barItems.length; i++) {
      barItems[i].style.scale = barScale;
    }
    if (errItems.length) {
      const showErr = e2 > 0;
      const errScale = horizontal ? `${e2} 1` : `1 ${e2}`;
      const errOp = showErr ? String(Math.min(1, e2 * 5)) : "0";
      for (let i = 0; i < errItems.length; i++) {
        const item = errItems[i];
        item.el.style.opacity = errOp;
        if (showErr) {
          const delta = axis.c2p(item.val * e1) - item.pFinal;
          item.el.style.translate = horizontal ? `${delta}px 0` : `0 ${delta}px`;
          item.el.style.scale = errScale;
        }
      }
    }
    const opStr = String(p1);
    for (let i = 0; i < annItems.length; i++) {
      const item = annItems[i];
      const delta = axis.c2p(item.score * e1 + item.se * e2) - item.pFinal;
      item.el.style.translate = horizontal ? `${delta}px 0` : `0 ${delta}px`;
      item.el.style.opacity = opStr;
    }
  }

  function clean() {
    for (let i = 0; i < barItems.length; i++) {
      const s = barItems[i].style;
      s.scale = ""; s.transformOrigin = ""; s.transformBox = "";
    }
    for (let i = 0; i < errItems.length; i++) {
      const s = errItems[i].el.style;
      s.scale = ""; s.translate = ""; s.opacity = ""; s.transformOrigin = ""; s.transformBox = "";
    }
    for (let i = 0; i < annItems.length; i++) {
      const s = annItems[i].el.style;
      s.translate = ""; s.opacity = "";
    }
  }

  function isConnected() {
    if (barItems.length && !barItems[0].isConnected) return false;
    if (annItems.length && !annItems[0].el.isConnected) return false;
    return true;
  }

  return { apply, clean, isConnected, hasErr: errItems.length > 0 };
}

/** Plotly.react (or newPlot on first draw) + register hover handlers. Bar traces
 *  animate from y=0 to their target values via lightweight SVG transforms
 *  (debounced). Horizontal bars (orientation "h", the comparison pages on narrow
 *  screens) grow along x instead and skip the column hover effects, which assume
 *  vertical bars (touch screens don't hover anyway). */
export function plotChart(traces, layout, config, onHover, onUnhover) {
  const now = Date.now();
  const barIndices = [];
  traces.forEach((t, i) => { if (t.type === "bar") barIndices.push(i); });
  const horizontal = barIndices.some((i) => traces[i].orientation === "h");
  const vk = horizontal ? "x" : "y";   // the axis the bar values run along
  const shouldAnimate = !REDUCED_MOTION.matches && barIndices.length > 0 && (now - lastPlotTime) > BAR_ANIM_DEBOUNCE;
  lastPlotTime = now;
  const animId = ++currentAnim;   // invalidate any in-flight animation

  // Pull the annotation animation metadata off the layout before handing it
  // to Plotly (which would otherwise warn about an unknown key).
  const annAnim = layout._annAnim || null;
  const plotLayout = Object.assign({}, layout, { datarevision: ++plotRevision });
  delete plotLayout._annAnim;

  const chartEl = document.getElementById("chart");
  // Clean up any leftover inline styles from an interrupted grow-up or hover
  // before Plotly.react reuses existing SVG nodes.
  chartEl._cleanBarAnim?.();
  chartEl._cleanBarAnim = null;
  chartEl._resetBarHover?.();
  chartEl._barDomCache = null;
  // Reset scatter image tags/transforms so Plotly.react updates re-snapshot
  // fresh resting marker coordinates on the next hover frame.
  chartEl.querySelectorAll(".imagelayer image").forEach((img) => {
    img._scatterTagged = false;
    img.style.scale = "";
    img.style.translate = "";
  });

  // Scatter-mode flag: lets style.css swap the logo transform-origin from
  // bottom-centre (bar-mode default, where logos sit at the chart floor)
  // to centre (scatter, where the logo is the data marker itself).
  const isScatterMode = barIndices.length === 0
    && traces.some((t) => t.type === "scatter" && t.mode && t.mode.indexOf("markers") !== -1);
  chartEl.classList.toggle("scatter-mode", isScatterMode);
  // Line-mode flag: progress dashboards (no bars, no org-logo images) want
  // Plotly's natural plot-area clipping back so data points outside the
  // fixed y-range don't spill above/under the chart. The bar/scatter modes
  // still need `clip-path: none` for hover-scale overflow. Note: progress
  // traces omit `type` (Plotly defaults it to "scatter"), so accept
  // undefined as scatter here.
  const hasImages = !!(plotLayout.images && plotLayout.images.length);
  const isLineMode = !barIndices.length && !hasImages
    && traces.some((t) => t.type === "scatter" || t.type === undefined);
  chartEl.classList.toggle("line-mode", isLineMode);
  // Each render rebuilds the chart, so hide any leftover focus halo (e.g. when
  // switching scatter → bars without a mouseleave). It reappears on next hover.
  if (chartEl._scatterHalo) chartEl._scatterHalo.style.opacity = "0";
  // Set while the bars grow (recaptureOnRedraw must not measure them then).
  chartEl._barAnimating = shouldAnimate;

  // Wire mutable event slots BEFORE Plotly.react so synchronous plotly_afterplot
  // callbacks see the new render's handlers (and never stack duplicate listeners).
  const compositeScatter = isScatterMode && !!chartEl._scatterImageMap;
  if (compositeScatter) {
    chartEl._scatterOnHover = onHover || null;
    chartEl._scatterOnUnhover = onUnhover || null;
    chartEl._cbHover = null;
    chartEl._cbClick = null;
    chartEl._cbUnhover = null;
  } else {
    chartEl._cbHover = onHover || null;
    chartEl._cbClick = onHover && barIndices.length ? onHover : null;
    chartEl._cbUnhover = onUnhover || null;
  }
  chartEl._cbLineAfterplot = isLineMode
    ? () => { widenLineModeClip(chartEl); applyLegendTitleGap(chartEl); }
    : null;
  chartEl._cbBarRecapture = barIndices.length && !horizontal
    ? () => {
        if (chartEl._barAnimating || chartEl._skipBarRecapture) return;
        captureNaturalRects(chartEl);
        chartEl._barHoverRedrawn?.();
      }
    : null;

  // Reuse the existing Plotly instance when present (3-5x faster than newPlot,
  // preserves modebar and image caches); fall back to newPlot on first draw.
  const draw = chartEl._fullLayout
    ? Plotly.react("chart", traces, plotLayout, config)
    : Plotly.newPlot("chart", traces, plotLayout, config);
  ensurePlotEventDispatchers(chartEl);

  if (barIndices.length && !horizontal) attachBarHoverHighlight(chartEl);
  if (isScatterMode) attachScatterHoverHighlight(chartEl);

  if (!shouldAnimate) {
    liftBarsAndLogos(chartEl);
    applyLegendTitleGap(chartEl);
    if (isLineMode) widenLineModeClip(chartEl);
    draw.then(() => {
      if (animId !== currentAnim) return;
      liftBarsAndLogos(chartEl);
      if (isLineMode) widenLineModeClip(chartEl);
      applyLegendTitleGap(chartEl);
      if (barIndices.length && !horizontal) captureNaturalRects(chartEl);
    });
    return;
  }

  const errKey = "error_" + vk;
  const annotationsTarget = plotLayout.annotations || [];
  liftBarsAndLogos(chartEl);
  let lastP1 = 0, lastE1 = 0, lastE2 = 0;
  let drivers = buildBarAnimDrivers(chartEl, traces, barIndices, horizontal, vk, errKey, annotationsTarget, annAnim);
  if (drivers) {
    drivers.apply(0, 0, 0);
    chartEl._cleanBarAnim = drivers.clean;
  }

  draw.then(() => {
    if (animId !== currentAnim) return;
    liftBarsAndLogos(chartEl);
    if (chartEl._barAnimating && (!drivers || !drivers.isConnected())) {
      drivers = buildBarAnimDrivers(chartEl, traces, barIndices, horizontal, vk, errKey, annotationsTarget, annAnim);
      if (drivers) {
        drivers.apply(lastP1, lastE1, lastE2);
        chartEl._cleanBarAnim = drivers.clean;
      }
    }
  });

  const hasErrBars = barIndices.some((i) => traces[i][errKey] && traces[i][errKey].array);
  const phase2StartOffset = BAR_ANIM_DURATION - PHASE_OVERLAP;
  const totalDuration = hasErrBars
    ? phase2StartOffset + ERR_ANIM_DURATION
    : BAR_ANIM_DURATION;

  let animStart = null;
  function tick(t) {
    if (animId !== currentAnim) return;   // a newer render took over
    if (!drivers || !drivers.isConnected()) {
      drivers = buildBarAnimDrivers(chartEl, traces, barIndices, horizontal, vk, errKey, annotationsTarget, annAnim);
      if (drivers) chartEl._cleanBarAnim = drivers.clean;
    }
    if (animStart === null) animStart = t;
    const elapsed = t - animStart;

    if (elapsed < totalDuration) {
      if (drivers) {
        const p1 = Math.min(1, elapsed / BAR_ANIM_DURATION);
        const e1 = easeOutCubic(p1);
        const p2 = hasErrBars
          ? Math.max(0, Math.min(1, (elapsed - phase2StartOffset) / ERR_ANIM_DURATION))
          : 0;
        const e2 = easeOutCubic(p2);
        lastP1 = p1; lastE1 = e1; lastE2 = e2;
        drivers.apply(p1, e1, e2);
      }
      requestAnimationFrame(tick);
    } else {
      // Grow-up done. Clear animation transforms so elements sit at their
      // exact resting Plotly geometry, then capture natural rects for hover.
      if (drivers) drivers.clean();
      chartEl._cleanBarAnim = null;
      chartEl._barAnimating = false;
      if (!horizontal) {
        captureNaturalRects(chartEl);
        chartEl._barHoverRedrawn?.();
      }
    }
  }

  // Start interpolating on the next frame (the initial scale=0 state is
  // already applied synchronously above so frame 0 paints cleanly).
  requestAnimationFrame(tick);
}

// ─────────────────────────────────────────────────────────────
// Bar-chart helpers (used by noreval comparison views)
// ─────────────────────────────────────────────────────────────

/** Compute the minimum tick rotation angle so that x-axis labels don't overlap.
 *  Models 2-D rectangle collision for rotated labels: returns 0 (horizontal)
 *  when labels fit, else a negative angle in [-5, -90]. */
export function computeTickAngle(labels, slotPx = null) {
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
  // Each label's room: the given slot (a chart that pans sideways), else the
  // plot's width shared by all of them.
  const slotWidth = slotPx || plotWidth / labels.length;
  const gap = 4;
  if (labelWidth + gap <= slotWidth) return 0;
  for (let deg = 5; deg < 90; deg += 5) {
    const rad = (deg * Math.PI) / 180;
    if (slotWidth * Math.sin(rad) >= fontHeight + gap) return -deg;
  }
  return -90;
}

/** Compute annotation font size that shrinks when labels get crowded. */
export function computeAnnotationFontSize(totalPositions, chartWidth = null) {
  const chartEl = document.getElementById("chart");
  const margins = 80;
  const plotWidth = (chartWidth ?? (chartEl ? chartEl.clientWidth : 1200)) - margins;
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

/** Compute [yMin, yMax] padding for non-negative or zscore data.
 *  With `tight`, the lower bound hugs the data min (padded) instead of
 *  being pinned at 0 — used by progress charts whose y-range is computed
 *  from a trimmed checkpoint set and clipped at the plot edges.
 *  `topHeadroom` adds extra space above the max (as a fraction of the data
 *  span), e.g. to clear a top-anchored legend. */
export function computeYRange(values, tight = false, topHeadroom = 0, unclamped = false) {
  // (The minimum pads and the ceiling on the scale of the scores shown:
  // 0–100, or 0–5 on /instruct — state.scoreTop.)
  const top = state.scoreTop;
  if (!values.length) return state.currentNormalization === "zscore" ? [-2, 2] : [0, top];
  const mx = Math.max(...values);
  const mn = Math.min(...values);
  const extra = (mx - mn) * topHeadroom;
  // Unclamped (raw-scale metrics like log-likelihoods): pad both sides, no
  // y ≥ 0 floor and no percent-scale ceiling.
  if (unclamped || state.currentNormalization === "zscore") {
    const pad = Math.max((mx - mn) * 0.15, 0.3);
    return [mn - pad, mx + pad + extra];
  }
  if (tight) {
    const pad = Math.max((mx - mn) * 0.15, top * 0.01);
    return [Math.max(0, mn - pad), Math.min(mx + pad + extra, top * 1.15)];
  }
  return [0, Math.min(mx + Math.max(mx * 0.15, top * 0.02) + extra, top * 1.15)];
}

/** A y-range fitted to exactly the plotted values: their extent plus 5% of
 *  the span on either side, with no floor at 0 and no ceiling — the chart
 *  is always fully zoomed to what it shows. Pass the CI extremes along
 *  with the points when bands are drawn so the bands fit too. */
export function computeFitRange(values) {
  if (!values.length) return state.currentNormalization === "zscore" ? [-2, 2] : [0, 100];
  const mx = Math.max(...values);
  const mn = Math.min(...values);
  const pad = Math.max((mx - mn) * 0.05, Math.abs(mx) * 0.01, 0.05);
  return [mn - pad, mx + pad];
}

/** Compute a single yMax for raw, non-normalized data. */
export function computeYMax(values) {
  if (!values.length) return 100;
  const mx = Math.max(...values);
  return Math.min(mx + Math.max(mx * 0.15, 2), 115);
}
