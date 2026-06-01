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
