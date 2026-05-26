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

// Scale applied to the hovered bar; matched in style.css's transition.
const BAR_HOVER_SCALE = 1.5;
// When a bar scales by S, its left and right edges each move outward by
// (S-1)/2 of the original bar width. To keep gaps between bars consistent,
// every other bar shifts by that same amount away from the hovered bar
// (left-of-hovered ← negative, right-of-hovered → positive).
const BAR_HOVER_SHIFT_PCT = (BAR_HOVER_SCALE - 1) / 2 * 100;
// "Drag" — each bar's transition is delayed proportional to its distance
// (in steps) from the hovered bar, so the ripple propagates outward like
// a wave rather than all bars moving in lockstep. Capped so far-away bars
// don't lag arbitrarily long.
const DRAG_DELAY_PER_STEP = 40;   // ms per step from the hovered position
const DRAG_DELAY_MAX = 300;       // ms cap on stagger delay
// "Dampening" — magnitude attenuation with distance, like a spring chain
// where each link transmits less force to the next. Half-life of N steps
// means shift magnitude halves every N bars further from the hovered one.
// d=1 still gets the full shift (so the gap with the hovered bar stays
// exact); only d≥2 attenuates.
const DAMPEN_HALFLIFE = 4;
const dampen = (steps) => Math.pow(0.5, Math.max(0, steps - 1) / DAMPEN_HALFLIFE);

/** Prime an aux element so future CSS transform shifts compose correctly
 *  with however Plotly is positioning it. Two cases:
 *    (a) Element has a `transform="translate(x, y) …"` attribute (xticks
 *        and annotations): we replicate that translate as CSS (with
 *        transition:none + forced reflow so it doesn't jump), then own
 *        positioning from CSS.
 *    (b) Element has no transform attribute (errorbars — positioned via
 *        the path's `d` data): no priming needed, just leave the path
 *        alone and add a plain CSS `translateX(dxPx)` later. */
function primeAuxEl(el) {
  if (el._auxPrimed) return;
  el._auxPrimed = true;
  const attr = el.getAttribute("transform") || "";
  const m = attr.match(/translate\s*\(\s*([-\d.eE+]+)(?:[,\s]+([-\d.eE+]+))?\s*\)/);
  if (m) {
    const x = parseFloat(m[1]);
    const y = m[2] ? parseFloat(m[2]) : 0;
    const rest = attr.replace(/translate\s*\([^)]+\)/, "").trim();
    // SVG rotate(N) → CSS rotate(Ndeg) so the carry-over transforms stay valid.
    const cssRest = rest.replace(/rotate\s*\(\s*([-\d.eE+]+)\s*\)/g, "rotate($1deg)");
    el._auxBase = { x, y, cssRest, hasAttrPos: true };
    el.style.transition = "none";
    el.style.transform = `translate(${x}px, ${y}px)${cssRest ? " " + cssRest : ""}`;
    el.offsetWidth;  // force reflow so the snap-set commits with no animation
    el.style.transition = "";
  } else {
    // No transform attribute. CSS translateX(dx) just shifts the element by
    // dx pixels from wherever it's currently rendered — no conflict.
    el._auxBase = { x: 0, y: 0, cssRest: "", hasAttrPos: false };
  }
}

/** Shift an aux element horizontally by `dxPx` from its primed base, with a
 *  staggered transition-delay. The transition itself is defined in style.css. */
function shiftAuxEl(el, dxPx, delayMs) {
  primeAuxEl(el);
  const { x, y, cssRest, hasAttrPos } = el._auxBase;
  el.style.transitionDelay = `${delayMs}ms`;
  el.style.transform = hasAttrPos
    ? `translate(${x + dxPx}px, ${y}px)${cssRest ? " " + cssRest : ""}`
    : `translateX(${dxPx}px)`;
}

/** Screen-x of an SVG element's anchor point. For elements positioned via a
 *  `transform="translate(...)"` attribute (xticks, annotations) we use
 *  getScreenCTM, whose `.e` is the x-translation through the whole ancestor
 *  chain — unaffected by rotated children. For elements without a transform
 *  attribute (errorbars) we fall back to bbox centre, which is accurate
 *  there since the path is what's positioned. */
function getAuxScreenX(el) {
  const attr = el.getAttribute("transform") || "";
  if (attr.indexOf("translate") !== -1) {
    const ctm = el.getScreenCTM();
    if (ctm) return ctm.e;
  }
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
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

/** Wire plotly_hover/plotly_unhover events to set an inline transform on the
 *  hovered bar's <path>, and tag the matching score-label annotation and
 *  x-axis tick so style.css can bump their font-weight. Plotly's drag
 *  overlay swallows native :hover, so we drive the visual through Plotly's
 *  own hit-test events. */
function attachBarHoverHighlight(chartEl) {
  function findBarPath(curveNumber, pointNumber) {
    const allData = chartEl.data || [];
    // Map curveNumber (index in gd.data) → index among bar traces only,
    // since `.barlayer .trace.bars` only contains bar traces.
    let barIdx = 0;
    for (let i = 0; i < curveNumber; i++) {
      if (allData[i] && allData[i].type === "bar") barIdx++;
    }
    const traceEl = chartEl.querySelectorAll(".barlayer .trace.bars")[barIdx];
    if (!traceEl) return null;
    return traceEl.querySelectorAll("path")[pointNumber] || null;
  }
  // Find the score annotation whose horizontal centre is closest to the
  // hovered bar's centre. Works for single-trace AND grouped charts
  // (where each sub-bar in a group has its own annotation at a slightly
  // different x), without needing to know Plotly's internal layout.
  function findAnnotationFor(barPath) {
    if (!barPath) return null;
    const barRect = barPath.getBoundingClientRect();
    const barX = barRect.left + barRect.width / 2;
    let closest = null, minDist = Infinity;
    chartEl.querySelectorAll(".annotation").forEach((ann) => {
      const r = ann.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const dist = Math.abs(x - barX);
      if (dist < minDist) { minDist = dist; closest = ann; }
    });
    return closest;
  }
  // X-axis tick at a given point index — one xtick per discrete x value,
  // so pointNumber maps directly even in grouped charts (sub-bars share
  // the same model position / tick).
  function findXtickAt(pointNumber) {
    return chartEl.querySelectorAll(".xtick")[pointNumber] || null;
  }
  // Org-logo image whose horizontal centre is closest to the hovered bar's
  // centre. Same positional-matching approach as the annotation lookup, so
  // it works for grouped charts too (and tolerates orgs without logos).
  function findLogoFor(barPath) {
    if (!barPath) return null;
    const barRect = barPath.getBoundingClientRect();
    const barX = barRect.left + barRect.width / 2;
    let closest = null, minDist = Infinity;
    chartEl.querySelectorAll(".imagelayer image").forEach((img) => {
      const r = img.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const dist = Math.abs(x - barX);
      if (dist < minDist) { minDist = dist; closest = img; }
    });
    return closest;
  }
  // Remember the last hover state so the unhover wave can stagger outward
  // from the same point the hover wave originated.
  let lastHoveredPointNum = null;
  let lastHoverCenterX = null;
  const stepDelay = (steps) => Math.min((steps - 1) * DRAG_DELAY_PER_STEP, DRAG_DELAY_MAX);
  // Debounce plotly_unhover: it also fires in the tiny gaps between bars
  // during a rapid sweep. We don't want to run the exit wave there —
  // it would briefly clear bar transforms, then the next hover would
  // re-set them, causing flicker. So defer the actual unhover work; if a
  // hover fires before the timer expires, it cancels this.
  let pendingUnhoverTimer = null;
  const UNHOVER_DEBOUNCE = 100;  // ms

  chartEl.on("plotly_hover", (data) => {
    const pt = data.points && data.points[0];
    if (!pt || !pt.data || pt.data.type !== "bar") return;
    // Cancel any pending unhover — the cursor is back on a bar before the
    // debounce timer fired, so we stay in hover state and shouldn't run
    // the exit wave.
    if (pendingUnhoverTimer) {
      clearTimeout(pendingUnhoverTimer);
      pendingUnhoverTimer = null;
    }
    const hoveredPointNum = pt.pointNumber;
    // First hover = entering the chart from no-hover state. Stagger applies.
    const isFirstHover = lastHoveredPointNum === null;
    const delayFor = (steps) => isFirstHover ? stepDelay(steps) : 0;
    lastHoveredPointNum = hoveredPointNum;
    // Clear the previous hover's bold class before adding the new one —
    // because plotly_unhover is debounced, we can't rely on it to do this
    // for us during a rapid sweep, and otherwise the class accumulates
    // on every xtick/annotation the cursor passes over.
    chartEl.querySelectorAll(".bar-hover-bold").forEach((el) => {
      el.classList.remove("bar-hover-bold");
    });

    // Measure the hovered bar BEFORE applying any transforms, so rect.width
    // is the natural (un-scaled) width. (A translateX from a prior hover
    // doesn't affect width; a scaleX would, but the bar isn't scaled yet.)
    // Reading after the scaleX would mean dividing by BAR_HOVER_SCALE to
    // recover natural width, and browsers disagree on whether
    // getBoundingClientRect returns the target or the interpolated mid-
    // transition value — that disagreement caused the residual undershoot.
    const path = findBarPath(pt.curveNumber, hoveredPointNum);
    let naturalWidth = 0, centerX = 0, shiftPx = 0, pxPerStep = 0;
    if (path) {
      const rect = path.getBoundingClientRect();
      naturalWidth = rect.width;
      centerX = rect.left + rect.width / 2;
      lastHoverCenterX = centerX;
      shiftPx = naturalWidth * (BAR_HOVER_SHIFT_PCT / 100);
      pxPerStep = naturalWidth / 0.85;
    }

    // Transform every bar in every bar trace: the hovered point scales,
    // all other bars shift away in the direction of their index relative
    // to the hovered point. transition-delay creates a "drag" ripple
    // outward — closer bars move first, far bars trail.
    chartEl.querySelectorAll(".barlayer .trace.bars").forEach((traceEl) => {
      traceEl.querySelectorAll("path").forEach((bar, i) => {
        const steps = Math.abs(i - hoveredPointNum);
        bar.style.transitionDelay = `${delayFor(steps)}ms`;
        if (i === hoveredPointNum) {
          // Independent scale + translate (CSS Transforms 2): the two
          // properties animate via separate transitions in style.css, so
          // there's no scale-meets-translate matrix interpolation ghost.
          bar.style.scale = `${BAR_HOVER_SCALE} 1`;
          bar.style.translate = "0";
        } else {
          // Dampen the shift magnitude with distance — closer bars move
          // close to the full amount, far bars only nudge.
          const shift = BAR_HOVER_SHIFT_PCT * dampen(steps);
          const dir = i < hoveredPointNum ? -1 : 1;
          bar.style.scale = "1";
          bar.style.translate = `${dir * shift}% 0`;
        }
      });
    });

    // Logos sit at bar centres, so they need the same horizontal shift
    // (in screen pixels, since their bbox is 128×128 not the bar's width)
    // and the same distance-based delay.
    if (path) {
      const logos = Array.from(chartEl.querySelectorAll(".imagelayer image"));
      let hoveredLogo = null, minDist = Infinity;
      logos.forEach((img) => {
        const r = img.getBoundingClientRect();
        const dist = Math.abs((r.left + r.width / 2) - centerX);
        if (dist < minDist) { minDist = dist; hoveredLogo = img; }
      });
      logos.forEach((img) => {
        const r = img.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const steps = Math.round(Math.abs(x - centerX) / pxPerStep);
        img.style.transitionDelay = `${delayFor(steps)}ms`;
        if (img === hoveredLogo) {
          img.style.scale = "1.5";
          img.style.translate = "0";
        } else {
          const damp = dampen(steps);
          const dir = x < centerX ? -1 : 1;
          img.style.scale = "1";
          img.style.translate = `${dir * shiftPx * damp}px`;
        }
      });

      // xticks, annotations, error bars: same dampened-shift pattern, but
      // matched by DOM index rather than screen position. Position-based
      // matching is unreliable here — bounding boxes of rotated tick
      // labels with text-anchor:end drift away from the actual anchor,
      // and getScreenCTM behaviour varies by browser when CSS transforms
      // are applied. DOM index is exact: xticks/annotations/errorbars are
      // emitted in model-position order.
      const xticks = chartEl.querySelectorAll(".xtick");
      const annotations = chartEl.querySelectorAll(".annotation");
      const errorbars = chartEl.querySelectorAll(".errorbar");
      const N = xticks.length;
      if (N > 0) {
        const applyAtModelIdx = (el, modelIdx) => {
          const steps = Math.abs(modelIdx - hoveredPointNum);
          const dir = modelIdx < hoveredPointNum ? -1 : 1;
          const dx = steps === 0 ? 0 : dir * shiftPx * dampen(steps);
          shiftAuxEl(el, dx, delayFor(steps));
        };
        // xticks: one per model, in order.
        xticks.forEach((el, i) => applyAtModelIdx(el, i));
        // Annotations: comparison.js builds them model-by-model (catIdx
        // outer, sub-bar inner), so floor(i / B) is the model index where
        // B = annotations / xticks (1 for aggregate, >1 for grouped).
        const annPerModel = Math.max(1, Math.round(annotations.length / N));
        annotations.forEach((el, i) =>
          applyAtModelIdx(el, Math.min(N - 1, Math.floor(i / annPerModel))));
        // Errorbars: emitted per-trace, data-point-first. So the i-th
        // .errorbar in DOM is at model index (i % N).
        errorbars.forEach((el, i) => applyAtModelIdx(el, i % N));
      }
    }

    chartEl.classList.add("hover-active");
    const ann = findAnnotationFor(path);
    if (ann) ann.classList.add("bar-hover-bold");
    const xtick = findXtickAt(hoveredPointNum);
    if (xtick) xtick.classList.add("bar-hover-bold");
  });
  chartEl.on("plotly_unhover", () => {
    // Debounce: plotly_unhover also fires in the tiny gaps between bars
    // during a rapid sweep. We don't want to run the exit wave there —
    // it would briefly clear bar transforms, then the next hover would
    // re-set them, causing a flicker. So defer the actual unhover work
    // by UNHOVER_DEBOUNCE; if a hover fires before then, it cancels this.
    if (pendingUnhoverTimer) clearTimeout(pendingUnhoverTimer);
    pendingUnhoverTimer = setTimeout(() => {
      pendingUnhoverTimer = null;
      runFullUnhover();
    }, UNHOVER_DEBOUNCE);
  });

  function runFullUnhover() {
    // Mirror the hover ripple on the way back: same distance-based delay,
    // measured from the bar that was just unhovered. We clear both
    // scale and translate so they animate back to identity via the
    // separate transitions defined in style.css.
    chartEl.querySelectorAll(".barlayer .trace.bars").forEach((traceEl) => {
      traceEl.querySelectorAll("path").forEach((bar, i) => {
        if (lastHoveredPointNum != null) {
          bar.style.transitionDelay =
            `${stepDelay(Math.abs(i - lastHoveredPointNum))}ms`;
        } else {
          bar.style.transitionDelay = "";
        }
        bar.style.scale = "";
        bar.style.translate = "";
      });
    });
    // Logos: use the cached lastHoverCenterX + a sample bar's width for
    // the same pxPerStep conversion as the hover handler.
    const sample = chartEl.querySelector(".barlayer path");
    if (lastHoverCenterX != null && sample) {
      const pxPerStep = sample.getBoundingClientRect().width / 0.85;
      chartEl.querySelectorAll(".imagelayer image").forEach((img) => {
        const r = img.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const steps = Math.round(Math.abs(x - lastHoverCenterX) / pxPerStep);
        img.style.transitionDelay = `${stepDelay(steps)}ms`;
        img.style.scale = "";
        img.style.translate = "";
      });
      // Send xticks, annotations, error bars back to base, using the
      // same DOM-index-based stagger as the hover handler (so the wave
      // unwinds in mirror order). Removing .hover-active on #chart
      // (below) flips the CSS transition rule to the slower hover-off curve.
      if (lastHoveredPointNum != null) {
        const xticks = chartEl.querySelectorAll(".xtick");
        const annotations = chartEl.querySelectorAll(".annotation");
        const errorbars = chartEl.querySelectorAll(".errorbar");
        const N = xticks.length;
        if (N > 0) {
          const clearAt = (el, modelIdx) =>
            shiftAuxEl(el, 0, stepDelay(Math.abs(modelIdx - lastHoveredPointNum)));
          xticks.forEach((el, i) => clearAt(el, i));
          const annPerModel = Math.max(1, Math.round(annotations.length / N));
          annotations.forEach((el, i) =>
            clearAt(el, Math.min(N - 1, Math.floor(i / annPerModel))));
          errorbars.forEach((el, i) => clearAt(el, i % N));
        }
      } else {
        chartEl.querySelectorAll(".xtick, .annotation, .errorbar").forEach((el) => {
          shiftAuxEl(el, 0, 0);
        });
      }
    } else {
      chartEl.querySelectorAll(".imagelayer image").forEach((el) => {
        el.style.transitionDelay = "";
        el.style.scale = "";
        el.style.translate = "";
      });
      chartEl.querySelectorAll(".xtick, .annotation, .errorbar").forEach((el) => {
        shiftAuxEl(el, 0, 0);
      });
    }
    chartEl.classList.remove("hover-active");
    chartEl.querySelectorAll(".bar-hover-bold").forEach((el) => {
      el.classList.remove("bar-hover-bold");
    });
    lastHoveredPointNum = null;
    lastHoverCenterX = null;
  }
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
    Plotly.newPlot("chart", traces, plotLayout, config).then(
      () => liftBarsAndLogos(chartEl));
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
