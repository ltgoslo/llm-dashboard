// Panning bar chart (comparison pages, vertical bars). When the ranked bars
// don't all fit at a readable width, the chart shows as many as fit and pans
// sideways to the rest (comparison.js decides and sets the x-range; the plot
// spans the page's column, as when the bars fit). Ways to pan:
//   • a sideways swipe on a trackpad (the wheel's deltaX), or Shift + wheel —
//     a plain wheel or a vertical swipe still scrolls the page;
//   • dragging the chart with the mouse, or with a finger on a touch screen
//     (a vertical swipe still scrolls the page);
//   • the ‹ › buttons, shown while there is more that way (from the
//     keyboard: Enter / Space, ←/→ one bar, Home/End). They sit outside the
//     plot, in the page's side padding; where that is too narrow for them
//     (a tablet, a narrow window: buttonFitsBeside) they sit on top of the
//     plot's edges.
// At an edge with more bars beyond, the bars run under a soft shadow. All of
// the plot's content — bars, logos, the y-axis's numbers and the bars'
// scores — ends at the plot's left and right edges: it pans under the page's
// margins.
// The view is the x-axis range [start − 0.5, start − 0.5 + visible] over the
// bar positions 0…total−1; start is fractional while panning, and starts at
// −lead: before the first bar, the y-axis's numbers (comparison.js), which
// pan away with the bars.

const ANIM_MS = 320;         // a button's jump
const DRAG_START_PX = 6;     // a press moving this far becomes a drag
const FLICK_FRICTION = 0.92; // momentum kept per 16 ms after a touch flick
const FLICK_MAX_HOLD_MS = 60; // a finger held still longer before lifting doesn't flick
const SHADOW_PX = 32;        // the shadow at an edge with more bars beyond…
const SHADOW_TAIL_PX = 20;   // …reaching this far below the plot, fading out
const BUTTON_REM = 2.25;     // .bar-pan-btn's size (style.css)
const BUTTON_GAP_PX = 12;    // between a button outside the plot and the plot
const SCREEN_EDGE_PX = 6;    // a button outside the plot keeps off the window's edge
const OVERLAY_INSET_PX = 8;  // a button on top of the plot, from its edge
const SCORE_CLIP_ID = "bar-pan-score-clip";
const AXIS_CLIP_ID = "bar-pan-axis-clip";

const pan = {
  enabled: false,
  total: 0, visible: 0, start: 0, lead: 0, slotPx: 1,
  onChange: null,
  chart: null, ui: null,
  frame: null,   // pending rAF of an apply
  anim: null,    // running jump / glide (rAF id)
  dragged: false, // a drag just ended on a button: not a click
};

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const minStart = () => -pan.lead;
/** The slots in sight: the view's, less those the details drawer covers. */
const inSight = () => pan.visible - coverPx() / pan.slotPx;
const maxStart = () => Math.max(minStart(), pan.total - inSight());
const clampStart = (s) => Math.min(maxStart(), Math.max(minStart(), s));

/** Turn panning on for the bar chart just drawn in `chart`, or off (null).
 *  opts: {total, visible, start, lead, slotPx, onChange(start)}. */
export function setBarPan(chart, opts) {
  pan.chart = chart;
  stopAnim();
  if (!opts) {
    pan.enabled = false;
    chart.classList.remove("bar-pan");
    chart.querySelector(".infolayer")?.removeAttribute("clip-path");
    chart.querySelector(".layer-between > .shapelayer")?.removeAttribute("clip-path");
    if (pan.ui) pan.ui.all.forEach((el) => { el.hidden = true; });
    return;
  }
  Object.assign(pan, {
    enabled: true, total: opts.total, visible: opts.visible, lead: opts.lead || 0,
    slotPx: opts.slotPx, onChange: opts.onChange || null,
  });
  pan.start = clampStart(opts.start ?? minStart());
  chart.classList.add("bar-pan");
  const ui = ensureUI(chart);
  ui.all.forEach((el) => { el.hidden = false; });
  position();
  indicate();
  // Plotly redraws on a resize and on every pan: keep the overlays on the
  // plot. Guard against stacking when plotChart uses Plotly.react.
  if (!chart._barPanAfterplotBound && chart.on) {
    chart._barPanAfterplotBound = true;
    chart.on("plotly_afterplot", position);
  }
}

/** Pan by `bars` (animated). */
export function panBarsBy(bars) {
  if (pan.enabled) animateTo(pan.start + bars);
}

/** Pan so that bar `i` is in full view (animated), if it isn't. */
export function revealBar(i) {
  if (!pan.enabled || i < 0) return;
  if (i < pan.start) animateTo(i - 0.5);
  else if (i > pan.start + inSight() - 1) animateTo(i - inSight() + 1.5);
}

/** The page around the chart changed (the model details drawer came or
 *  went): the buttons and shadows placed again, the view kept within
 *  reach (the bars the drawer covers panned to). */
export function refreshBarPan() {
  if (!pan.enabled) return;
  position();
  const s = clampStart(pan.start);
  if (Math.abs(s - pan.start) > 1e-6) setStart(s);
  else indicate();
}

/** Whether `room` px of the page's side padding, beside the plot, hold a
 *  ‹ › button outside it: true from a window about 1260px wide (the column
 *  is 1152px). Narrower, the buttons sit on top of the plot's edges, and
 *  comparison.js leaves the bars without their names. */
export function buttonFitsBeside(room) {
  const button = BUTTON_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
  return room >= SCREEN_EDGE_PX + button + BUTTON_GAP_PX;
}

/** The page's right edge on the screen: short of the window's while the
 *  model details drawer covers it (the body's --page-cover-right,
 *  style.css). */
function pageRight() {
  const cover = parseFloat(getComputedStyle(document.body).getPropertyValue("--page-cover-right")) || 0;
  return document.documentElement.clientWidth - cover;
}

/** The px of the plot's right end under the details drawer (the chart
 *  runs on under it, its bars as without it). */
function coverPx() {
  const size = pan.chart?._fullLayout?._size;
  if (!size) return 0;
  return Math.max(0, pan.chart.getBoundingClientRect().left + size.l + size.w - pageRight());
}

// ─────────────────────────────────────────────────────────────
// Moving the view
// ─────────────────────────────────────────────────────────────

/** Set the view's first bar, drawn at the next frame. */
function setStart(s) {
  pan.start = clampStart(s);
  if (pan.frame === null) pan.frame = requestAnimationFrame(apply);
}

function apply() {
  pan.frame = null;
  if (!pan.enabled) return;
  const s = pan.start;
  Plotly.relayout(pan.chart, { "xaxis.range": [s - 0.5, s - 0.5 + pan.visible] });
  indicate();
  pan.onChange?.(s);
}

function stopAnim() {
  if (pan.anim !== null) cancelAnimationFrame(pan.anim);
  pan.anim = null;
}

/** Glide to `target` (clamped). */
function animateTo(target) {
  stopAnim();
  const from = pan.start, to = clampStart(target);
  if (Math.abs(to - from) < 1e-3) return;
  let t0 = null;
  const step = (now) => {
    if (t0 === null) t0 = now;
    const p = Math.min(1, (now - t0) / ANIM_MS);
    setStart(from + (to - from) * easeOutCubic(p));
    pan.anim = p < 1 ? requestAnimationFrame(step) : null;
  };
  pan.anim = requestAnimationFrame(step);
}

/** Keep gliding after a touch flick, `v` in bars per ms, slowing down. */
function glide(v) {
  stopAnim();
  let last = null;
  const step = (now) => {
    const dt = last === null ? 16 : Math.min(64, now - last);
    last = now;
    v *= Math.pow(FLICK_FRICTION, dt / 16);
    const before = pan.start;
    setStart(pan.start + v * dt);
    const stuck = Math.abs(pan.start - before) < 1e-4;
    pan.anim = Math.abs(v) > 0.0004 && !stuck ? requestAnimationFrame(step) : null;
  };
  pan.anim = requestAnimationFrame(step);
}

// ─────────────────────────────────────────────────────────────
// Edge shadows and buttons
// ─────────────────────────────────────────────────────────────

function ensureUI(chart) {
  if (pan.ui) return pan.ui;
  const zone = chart.parentElement;
  const make = (tag, cls, attrs = {}) => {
    const el = document.createElement(tag);
    el.className = cls;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const shadowL = make("div", "bar-pan-shadow bar-pan-shadow-left", { "aria-hidden": "true" });
  const shadowR = make("div", "bar-pan-shadow bar-pan-shadow-right", { "aria-hidden": "true" });
  const prev = make("button", "bar-pan-btn bar-pan-prev", { type: "button", "aria-label": "Show the higher-ranked models" });
  const next = make("button", "bar-pan-btn bar-pan-next", { type: "button", "aria-label": "Show the lower-ranked models" });
  zone.append(shadowL, shadowR, prev, next);
  pan.ui = { shadowL, shadowR, prev, next, all: [shadowL, shadowR, prev, next] };

  // A view's worth, keeping the bar at the edge in view.
  const page = () => Math.max(1, Math.floor(inSight()) - 1);
  prev.addEventListener("click", () => { if (!pan.dragged) panBarsBy(-page()); });
  next.addEventListener("click", () => { if (!pan.dragged) panBarsBy(page()); });
  for (const button of [prev, next]) {
    button.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") animateTo(Math.round(pan.start) - 1);
      else if (e.key === "ArrowRight") animateTo(Math.round(pan.start) + 1);
      else if (e.key === "Home") animateTo(minStart());
      else if (e.key === "End") animateTo(maxStart());
      else return;
      e.preventDefault();
    });
  }
  // A swipe or drag that starts on a button pans too (on a tablet the ›
  // button sits right where a swipe to the next bars starts).
  bindWheel([chart, prev, next]);
  bindDrag(chart, [prev, next]);
  return pan.ui;
}

/** Put the shadows on the plot's edges (down to a little below the axis)
 *  and the buttons at mid-height outside them, in the page's side padding —
 *  or, on a side where that is too narrow for one, on top of the plot's
 *  edge. Where the details drawer covers the plot's right end, › sits on
 *  the drawer's edge, and the drawer's own shadow is the right one. The
 *  plot's position in the chart comes from Plotly's layout. */
function position() {
  const ui = pan.ui, size = pan.chart?._fullLayout?._size;
  if (!ui || !size || !pan.enabled || pan.chart._skipBarRecapture) return;
  const x0 = pan.chart.offsetLeft + size.l, y0 = pan.chart.offsetTop + size.t;
  const cover = coverPx(), w = size.w - cover;   // the plot in sight
  const tail = Math.min(SHADOW_TAIL_PX, size.b);
  for (const [el, left] of [[ui.shadowL, x0], [ui.shadowR, x0 + w - SHADOW_PX]]) {
    Object.assign(el.style, { left: left + "px", top: y0 + "px", width: SHADOW_PX + "px", height: size.h + tail + "px" });
    el.style.setProperty("--tail", tail + "px");
  }
  pan.chart.classList.toggle("bar-pan-covered", cover > 0);
  pan.chart.style.setProperty("--pan-cover", cover + "px");
  const btn = ui.prev.offsetWidth;
  const plotLeft = pan.chart.getBoundingClientRect().left + size.l;
  // Each side on its own: with the details drawer open, › sits on its edge.
  const leftOut = buttonFitsBeside(plotLeft), rightOut = !cover && buttonFitsBeside(pageRight() - plotLeft - size.w);
  ui.prev.style.left = (leftOut ? x0 - BUTTON_GAP_PX - btn : x0 + OVERLAY_INSET_PX) + "px";
  ui.next.style.left = (rightOut ? x0 + size.w + BUTTON_GAP_PX : x0 + w - OVERLAY_INSET_PX - btn) + "px";
  ui.prev.style.top = ui.next.style.top = y0 + size.h / 2 + "px";
  ui.prev.classList.toggle("over-plot", !leftOut);
  ui.next.classList.toggle("over-plot", !rightOut);
  clipScores(size);
}

/** Clip a layer horizontally to the plot's width (leaving generous vertical
 *  headroom) so scores above bars and y-axis labels centred on the 0 line pan
 *  cleanly under the page margins without slicing the top/bottom ticks. */
function clipLayerX(layer, clipId, size) {
  const svg = layer?.ownerSVGElement;
  if (!svg) return;
  let clip = svg.querySelector("#" + clipId);
  if (!clip) {
    const NS = "http://www.w3.org/2000/svg";
    const defs = svg.querySelector("defs") || svg.insertBefore(document.createElementNS(NS, "defs"), svg.firstChild);
    clip = defs.appendChild(document.createElementNS(NS, "clipPath"));
    clip.id = clipId;
    clip.appendChild(document.createElementNS(NS, "rect"));
  }
  const rect = clip.firstChild;
  rect.setAttribute("x", size.l);
  rect.setAttribute("width", size.w);
  rect.setAttribute("y", -size.t - 1000);
  rect.setAttribute("height", svg.getAttribute("height") * 1 + 2000);
  layer.setAttribute("clip-path", `url(#${clipId})`);
}

/** The bars' scores (in .infolayer) and the y-axis numbers (in the
 *  layer-between .shapelayer) pan under the margins like their bars.
 *  (A redraw from scratch makes a new SVG: hence on every afterplot.) */
function clipScores(size) {
  clipLayerX(pan.chart.querySelector(".infolayer"), SCORE_CLIP_ID, size);
  clipLayerX(pan.chart.querySelector(".layer-between > .shapelayer"), AXIS_CLIP_ID, size);
}

/** The shadows and buttons for the current view. */
function indicate() {
  const ui = pan.ui;
  if (!ui) return;
  const more = { left: pan.start > minStart() + 0.02, right: pan.start < maxStart() - 0.02 };
  ui.shadowL.classList.toggle("shown", more.left);
  ui.shadowR.classList.toggle("shown", more.right);
  ui.prev.classList.toggle("shown", more.left);
  ui.next.classList.toggle("shown", more.right);
  ui.prev.disabled = !more.left;
  ui.next.disabled = !more.right;
}

// ─────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────

/** Sideways wheel (trackpad swipe, Shift + wheel) over the chart or its
 *  buttons: pan, and keep the swipe from turning into the browser's back /
 *  forward gesture. Vertical wheel movement is left to the page. */
function bindWheel(targets) {
  const onWheel = (e) => {
    if (!pan.enabled) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pan.chart.clientWidth : 1;
    let dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (Math.abs(dx) <= Math.abs(dy)) {
      if (!e.shiftKey) return;
      dx = dy;
    }
    e.preventDefault();
    stopAnim();
    setStart(pan.start + dx / pan.slotPx);
  };
  for (const el of targets) el.addEventListener("wheel", onWheel, { passive: false });
}

/** Drag the chart (mouse, pen, finger), also from one of its buttons, to pan
 *  it; a touch flick keeps gliding. A press that moves mostly vertically is
 *  not a drag (on a touch screen the page scrolls: style.css leaves vertical
 *  panning to it); a press on a button that doesn't become a drag is a
 *  click. */
function bindDrag(chart, buttons) {
  let drag = null;
  const down = (e) => {
    if (!pan.enabled || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (e.target.closest?.(".modebar")) return;
    drag = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, start: pan.start, active: false, samples: [] };
  };
  for (const el of [chart, ...buttons]) el.addEventListener("pointerdown", down);
  window.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < DRAG_START_PX) return;
      if (Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
      drag.active = true;
      stopAnim();
      chart.classList.add("bar-pan-dragging");
    }
    setStart(drag.start - dx / pan.slotPx);
    drag.samples.push([e.timeStamp, e.clientX]);
    while (drag.samples.length > 2 && e.timeStamp - drag.samples[0][0] > 100) drag.samples.shift();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.active) {
      chart.classList.remove("bar-pan-dragging");
      const s = drag.samples;
      const flick = drag.type !== "mouse" && e.type === "pointerup" && s.length >= 2
        && e.timeStamp - s[s.length - 1][0] <= FLICK_MAX_HOLD_MS;
      if (flick) {
        const [t0, x0] = s[0], [t1, x1] = s[s.length - 1];
        if (t1 - t0 > 0) glide(-(x1 - x0) / (t1 - t0) / pan.slotPx);
      }
      // The click that may follow (the drag began and ended on a button)
      // doesn't page.
      pan.dragged = true;
      setTimeout(() => { pan.dragged = false; }, 0);
    }
    drag = null;
  };
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}
