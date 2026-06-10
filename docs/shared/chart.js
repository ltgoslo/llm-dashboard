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
const BAR_HOVER_SCALE = 1.75;
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
// Aux elements that ride along with the bars (per model column, by index).
// Used to clear their inline transforms on settle; the hover loop addresses
// them directly when painting.
const AUX_SELECTORS = [
  ".barlayer .trace.bars .errorbar",   // error-bar I-beams (the <g>)
  ".imagelayer image",                 // org logos
  ".xtick",                            // x-axis tick labels
  ".annotation",                       // score labels
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
  // Only bars need a cached rect — they're what the cursor is hit-tested
  // against. Aux elements are positioned by model-column index, not measured.
  chartEl.querySelectorAll(BAR_RECT_SELECTOR).forEach(capRect);
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

/** Line-mode clipping: keep Plotly's plot-area clip vertically (so traces
 *  never spill above/under a fixed y-range) but open it horizontally (so
 *  markers at the first/last x-position aren't half-clipped at the plot
 *  edges). CSS can't express this on SVG <g> elements — `clip-path: inset()`
 *  resolves against the content bbox, not the plot rect — so widen the
 *  actual <clipPath> rect that the trace layer references. Re-run after
 *  every render: Plotly.newPlot rebuilds the defs. */
function widenLineModeClip(chartEl) {
  chartEl.querySelectorAll(".subplot.xy .plot").forEach((plot) => {
    const ref = plot.getAttribute("clip-path");
    const m = ref && ref.match(/url\(["']?#([^"')]+)/);
    if (!m) return;
    const rect = chartEl.querySelector(`#${CSS.escape(m[1])} rect`);
    if (rect && !rect._widened) {
      rect._widened = true;
      rect.setAttribute("x", "-9999");
      rect.setAttribute("width", "99999");
    }
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

  function ensureState(N) {
    if (stateN !== N || !curScale) {
      curScale = new Array(N).fill(1);
      curShift = new Array(N).fill(0);
      stateN = N;
    }
  }

  // Collect the bar paths with their cached natural rects. null until the
  // first captureNaturalRects has run for this layout.
  function gatherBars() {
    const traces = chartEl.querySelectorAll(".barlayer .trace.bars");
    if (!traces.length) return null;
    const bars = [];
    let N = 0;
    traces.forEach((tr, traceIdx) => {
      const paths = tr.querySelectorAll(".points path");
      if (N === 0) N = paths.length;
      paths.forEach((bar, modelIdx) => {
        const rect = getBarNatRect(bar);
        if (rect) bars.push({ el: bar, traceIdx, modelIdx, rect });
      });
    });
    if (!bars.length || N === 0) return null;
    return { bars, N, refWidth: bars[0].rect.width };
  }

  // Per-model targets the current cursor implies: peak scale, dock shift,
  // distance (drives the EMA rate), and the bar the cursor sits inside (bold).
  //
  // The dock shift is the cumulative sum of column growths, sampled at the
  // cursor and subtracted so the cursor is the pivot — same maths as before,
  // but accumulated over MODEL columns so the result is indexed by model.
  function computeTargets(bars, N, refWidth, cx, cy) {
    const sumCx = new Array(N).fill(0);
    const cnt = new Array(N).fill(0);
    const scale = new Array(N).fill(1);
    const dist = new Array(N).fill(Infinity);
    let insideBar = null;
    bars.forEach((b) => {
      const d = distPointToRect(cx, cy, b.rect);
      const s = 1 + (BAR_HOVER_SCALE - 1) * hoverKernel(d / refWidth);
      const i = b.modelIdx;
      sumCx[i] += b.rect.cx; cnt[i] += 1;
      if (s > scale[i]) scale[i] = s;
      if (d < dist[i]) dist[i] = d;
      if (d === 0 && !insideBar) insideBar = b;
    });
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
  // uniformly like a dock icon. Aux elements are matched by index.
  function paint(bars, N) {
    bars.forEach((b) => {
      const i = b.modelIdx;
      b.el.style.scale = `${curScale[i]} 1`;
      b.el.style.translate = `${curShift[i]}px 0`;
    });
    chartEl.querySelectorAll(".imagelayer image").forEach((el, i) => {
      if (i < N) {
        el.style.scale = `${curScale[i]} ${curScale[i]}`;
        el.style.translate = `${curShift[i]}px 0`;
      }
    });
    chartEl.querySelectorAll(".xtick").forEach((el, i) => {
      if (i < N) el.style.translate = `${curShift[i]}px 0`;
    });
    chartEl.querySelectorAll(".barlayer .trace.bars").forEach((tr) => {
      tr.querySelectorAll(".errorbar").forEach((el, i) => {
        if (i < N) el.style.translate = `${curShift[i]}px 0`;
      });
    });
    const anns = chartEl.querySelectorAll(".annotation");
    const annPerModel = anns.length ? Math.max(1, Math.round(anns.length / N)) : 0;
    if (annPerModel > 0) {
      anns.forEach((el, j) => {
        const m = Math.floor(j / annPerModel);
        if (m < N) el.style.translate = `${curShift[m]}px 0`;
      });
    }
  }

  // Bold the xtick + score label of the column the cursor sits inside.
  function updateBold(insideBar, N) {
    if ((insideBar && insideBar.el) === currentBoldBar) return;
    chartEl.querySelectorAll(".bar-hover-bold").forEach((el) =>
      el.classList.remove("bar-hover-bold"));
    if (insideBar) {
      const xt = chartEl.querySelectorAll(".xtick")[insideBar.modelIdx];
      if (xt) xt.classList.add("bar-hover-bold");
      const anns = chartEl.querySelectorAll(".annotation");
      const annPerModel = anns.length ? Math.max(1, Math.round(anns.length / N)) : 0;
      if (annPerModel > 0) {
        const annIdx = annPerModel === 1
          ? insideBar.modelIdx
          : insideBar.modelIdx * annPerModel + Math.min(insideBar.traceIdx, annPerModel - 1);
        const an = anns[annIdx];
        if (an) an.classList.add("bar-hover-bold");
      }
    }
    currentBoldBar = insideBar ? insideBar.el : null;
  }

  // Drop all inline transforms so elements return to their natural geometry.
  function clearInline(bars) {
    bars.forEach((b) => { b.el.style.scale = ""; b.el.style.translate = ""; });
    chartEl.querySelectorAll(".imagelayer image").forEach((el) => {
      el.style.scale = ""; el.style.translate = "";
    });
    AUX_SELECTORS.forEach((sel) =>
      chartEl.querySelectorAll(sel).forEach((el) => { el.style.translate = ""; }));
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

    const targets = pointer.active
      ? computeTargets(bars, N, refWidth, pointer.x, pointer.y)
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
    paint(bars, N);

    if (pointer.active) {
      chartEl.classList.add("hover-active");
      updateBold(targets.insideBar, N);
    }

    if (maxRes < EMA_SETTLE) {
      // Snap exactly onto target to kill sub-pixel drift, then stop the loop.
      // lastT is reset so the next run (restarted by mousemove) starts fresh.
      for (let i = 0; i < N; i++) { curScale[i] = targets.scale[i]; curShift[i] = targets.shift[i]; }
      lastT = null;
      if (pointer.active) {
        paint(bars, N);   // rest at the hover pose; idle until the next move
      } else {
        clearInline(bars);
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

  chartEl.addEventListener("mousemove", (ev) => {
    pointer.x = ev.clientX; pointer.y = ev.clientY; pointer.active = true;
    ensureLoop();
  });
  chartEl.addEventListener("mouseleave", () => {
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
    for (let i = 0; i < N; i++) {
      const m = list[i];
      if (pointer.active) {
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
  chartEl.addEventListener("mouseleave", () => {
    pointer.active = false;   // springs relax everything back to rest
    ensureLoop();
  });
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

  if (!shouldAnimate) {
    Plotly.newPlot("chart", traces, plotLayout, config).then(() => {
      liftBarsAndLogos(chartEl);
      if (isLineMode) widenLineModeClip(chartEl);
      applyLegendTitleGap(chartEl);
      // Bars are at full height immediately (no grow-up). Capture their
      // natural geometry now so the hover handler has a stable cache from
      // the first mousemove.
      if (barIndices.length) captureNaturalRects(chartEl);
    });
    liftBarsAndLogos(chartEl);
    applyLegendTitleGap(chartEl);
    if (isLineMode) {
      widenLineModeClip(chartEl);
      // Responsive resizes rebuild the clip rect (and legend transforms) at
      // new dimensions — the afterplot event fires on every redraw, so
      // re-apply there. newPlot purges previous listeners, so this doesn't
      // stack across renders.
      chartEl.on("plotly_afterplot", () => {
        widenLineModeClip(chartEl);
        applyLegendTitleGap(chartEl);
      });
    }
    // Composite scatter (single trace + _scatterImageMap) drives its tooltip
    // from chart.js's own paint-order hit-test, so the tooltip, magnify, and
    // bring-to-front all agree and honour the live z-order. Every other mode
    // (bars, grouped scatter) uses Plotly's hover as before.
    const compositeScatter = isScatterMode && !!chartEl._scatterImageMap;
    if (compositeScatter) {
      chartEl._scatterOnHover = onHover || null;
      chartEl._scatterOnUnhover = onUnhover || null;
    } else {
      if (onHover) chartEl.on("plotly_hover", onHover);
      if (onUnhover) chartEl.on("plotly_unhover", onUnhover);
    }
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

/** Compute [yMin, yMax] padding for non-negative or zscore data.
 *  With `tight`, the lower bound hugs the data min (padded) instead of
 *  being pinned at 0 — used by progress charts whose y-range is computed
 *  from a trimmed checkpoint set and clipped at the plot edges. */
export function computeYRange(values, tight = false) {
  if (!values.length) return state.currentNormalization === "zscore" ? [-2, 2] : [0, 100];
  const mx = Math.max(...values);
  const mn = Math.min(...values);
  if (state.currentNormalization === "zscore") {
    const pad = Math.max((mx - mn) * 0.15, 0.3);
    return [mn - pad, mx + pad];
  }
  if (tight) {
    const pad = Math.max((mx - mn) * 0.15, 1);
    return [Math.max(0, mn - pad), Math.min(mx + pad, 115)];
  }
  return [0, Math.min(mx + Math.max(mx * 0.15, 2), 115)];
}

/** Compute a single yMax for raw, non-normalized data. */
export function computeYMax(values) {
  if (!values.length) return 100;
  const mx = Math.max(...values);
  return Math.min(mx + Math.max(mx * 0.15, 2), 115);
}
