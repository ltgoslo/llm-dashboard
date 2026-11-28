// Model details (comparison pages): a click on a bar (or on a point of the
// scatter plot) opens the model's details. On a wide screen (DETAIL_DRAWER)
// they are a drawer the window's height at its right edge, over the page,
// which keeps its layout (comparison.js); otherwise (a narrower window, a
// tablet, a phone) a panel under the chart.
//
// The details don't follow the chart's settings: they show the model's
// category average over all tasks at each shot count, and its score on
// each task (the page's rescaling of its aggregates: the random baseline,
// none on /instruct; best prompt; the tasks under their categories' names)
// beside every other model's score, at a shot count of their own (the
// page's default; one picked here stays for the models opened after).
// Each fact once; three type sizes (style.css). comparison.js computes the content
// (modelDetailData) and runs the motion; this module lays the content out
// and slides the drawer. Opening another model, only the model's own dots
// move (to its scores) and its numbers change. A task's row opens the
// task's details (task-detail.js).

import { hideTooltip } from "./ui.js";
import { enhanceSegmentedControl } from "./segmented.js";

/** Screens wide enough for the drawer (style.css has the same breakpoint). */
export const DETAIL_DRAWER = "(min-width: 1180px)";
const PANEL_IN_SIGHT_PX = 280;   // a click scrolls this much of the panel into sight
const TASK_INTENT_MS = 65;       // the pointer resting this long on a task's row preloads its data

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
/** The details' motion — the drawer's slide, the page's shift, the band's
 *  fade or glide — all at one pace (Web Animations options). */
export function detailMotion(extra = {}) {
  return { duration: REDUCED_MOTION.matches ? 0 : 280, easing: "cubic-bezier(0.32, 0.72, 0, 1)", ...extra };
}

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Badge, name, facts, link, close button: stays at the drawer's top. A
 *  line of facts wraps between them (each whole where it fits). */
function buildHead(d, onClose) {
  const head = el("div", "md-head");
  const titles = el("div", "md-titles");
  titles.append(el("h2", "md-title", d.title));
  for (const facts of d.facts) {
    const line = el("div", "md-meta");
    facts.forEach((f, i) => line.append(...(i ? [" · "] : []), el("span", "md-fact", f)));
    titles.append(line);
  }
  if (d.link) {
    const a = el("a", "md-link");
    a.href = d.link.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    // (The arrow on the URL's last line: a no-break space before it.)
    a.append(el("span", "link-text", d.link.text), "\u00a0", el("span", "md-link-arrow", "↗"));
    titles.append(a);
  }
  const close = el("button", "md-close");
  close.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
    + '<path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  close.type = "button";
  close.title = "Close (Esc)";
  close.setAttribute("aria-label", "Close the model's details");
  close.addEventListener("click", onClose);
  head.append(d.badge(), titles, close);
  return head;
}

/** The model's category average at each shot count, in the page's
 *  segmented control (.shot-toggle, segmented.js): the shot the details
 *  show is on its thumb, a click on another shows that one (a page with
 *  one setting shows the average alone). Built once and
 *  updated for each content, so the thumb slides to a newly picked shot.
 *  (Its buttons aren't .shot-btn: those are the page's own shots.) The
 *  task details' scores at each shot are the same control. */
export function shotControl(onShot) {
  const h = el("div", "md-headline");
  const label = el("div", "md-label");
  const group = el("div", "shot-toggle md-shots");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Shots");
  // A page with one setting (/instruct) has nothing to pick: its score alone.
  const single = el("div", "md-score");
  single.hidden = true;
  h.append(label, group, single);
  enhanceSegmentedControl(group);
  const buttons = new Map();
  let shotFrame = 0;
  return {
    el: h,
    update(d) {
      // (None: a page whose details don't repeat the chart's average,
      // /instruct.)
      h.hidden = !d.headline;
      if (!d.headline) return;
      label.textContent = d.headline.label;
      const one = d.shots.length === 1;
      group.hidden = one;
      single.hidden = !one;
      if (one) {
        single.textContent = d.shots[0].text;
        return;
      }
      const shots = d.shots.map((sh) => sh.shot).join(",");
      if (group.dataset.shots !== shots) {
        group.dataset.shots = shots;
        buttons.clear();
        group.replaceChildren(...d.shots.map((sh) => {
          const b = el("button", "md-shot");
          b.type = "button";
          b.addEventListener("click", () => {
            if (b.classList.contains("active")) return;
            for (const [s, elBtn] of buttons) elBtn.classList.toggle("active", s === sh.shot);
            cancelAnimationFrame(shotFrame);
            shotFrame = requestAnimationFrame(() => { shotFrame = 0; onShot(sh.shot); });
          });
          b.append(el("span", "md-shot-name", sh.shot + "-shot"), el("span", "md-shot-value"));
          buttons.set(sh.shot, b);
          return b;
        }));
      }
      for (const sh of d.shots) {
        const b = buttons.get(sh.shot);
        b.classList.toggle("active", sh.current);
        b.setAttribute("aria-pressed", String(sh.current));
        b.querySelector(".md-shot-value").textContent = sh.text;
        b.setAttribute("aria-label", `${sh.shot}-shot: ${sh.text}`);
        b.title = sh.current ? `${sh.shot}-shot scores, shown` : `Show the ${sh.shot}-shot scores`;
      }
    },
  };
}

/** What the strips' dots are: the model's (in its colour) and the others'. */
function buildLegend(d) {
  const lg = el("div", "md-legend");
  const item = (mark, text) => {
    const span = el("span", "md-legend-item");
    span.append(mark, document.createTextNode(text));
    lg.append(span);
  };
  const me = el("span", "md-legend-me");
  me.style.backgroundColor = d.color;
  item(me, d.title);
  item(el("span", "md-legend-dot"), d.others === 1 ? "1 other model" : `${d.others} other models`);
  return lg;
}

/** Where `v` lies on a strip with the scale `domain`: a CSS left (%). */
export const position = (v, domain) => ((v - domain[0]) / (domain[1] - domain[0]) * 100).toFixed(2) + "%";

const DOT_COLOR = "rgba(83, 93, 106, 0.38)";
const DOT_PAD = 3;      // matches .md-dots left: -3px / width: calc(100% + 6px)
const DOT_RADIUS = 2.5; // matches .md-dot 5px diameter

/** Single-element canvas holding all comparison dots of one strip (replaces
 *  ~60 <span class="md-dot"> nodes per row with 1 node while keeping exact
 *  translucent overlap compounding). Painted by paintDotStrips(). */
export function makeDotCanvas(all, domain) {
  const c = el("canvas", "md-dots");
  c.setAttribute("aria-hidden", "true");
  c._dots = { all, domain };
  return c;
}

/** Batch-measure and paint every .md-dots canvas inside `container` at device
 *  resolution (zero read/write interleaving; skips unchanged canvases). */
export function paintDotStrips(container) {
  if (!container) return;
  const canvases = container.querySelectorAll("canvas.md-dots");
  if (!canvases.length) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  // Pass 1 (reads): measure parent strip widths/heights in one layout pass.
  const jobs = [];
  for (let i = 0; i < canvases.length; i++) {
    const c = canvases[i];
    const data = c._dots;
    const p = c.parentElement;
    if (!data || !p) continue;
    const w = p.clientWidth;
    const h = p.clientHeight;
    if (!(w > 0 && h > 0)) continue;
    if (c._pW === w && c._pH === h && c._pDpr === dpr && c._pRef === data) continue;
    jobs.push({ c, data, w, h });
  }
  // Pass 2 (writes): size and draw each dirty canvas.
  const twoPi = Math.PI * 2;
  for (let i = 0; i < jobs.length; i++) {
    const { c, data, w, h } = jobs[i];
    const cw = w + DOT_PAD * 2;
    c.width = Math.round(cw * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) continue;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = DOT_COLOR;
    const lo = data.domain[0], span = data.domain[1] - lo || 1, cy = h / 2;
    const all = data.all;
    for (let j = 0; j < all.length; j++) {
      const v = all[j];
      if (v == null) continue;
      const x = DOT_PAD + ((v - lo) / span) * w;
      ctx.beginPath();
      ctx.arc(x, cy, DOT_RADIUS, 0, twoPi);
      ctx.fill();
    }
    c._pW = w; c._pH = h; c._pDpr = dpr; c._pRef = data;
  }
}

/** A row's dot strip: every model's score on the profile's scale (rendered on
 *  one canvas), and the model's dot. (Where its dot sits among the others is
 *  its standing: no rank beside it.) */
function buildStrip(row, d) {
  const s = el("div", "md-strip");
  s.append(makeDotCanvas(row.all, d.domain));
  const me = el("span", "md-me");
  s.append(me);
  return { strip: s, me };
}

/** A task's row: name, dots, value. A button that opens the task's
 *  details (hooks.onTask(task, row)); the pointer resting on it or focus
 *  on it says it may soon (hooks.onTaskIntent(task): the task's data can
 *  start loading — not for every row the pointer crosses). */
function buildRow(row, d, refs, hooks) {
  const task = !!hooks.onTask;
  const r = el(task ? "button" : "div", "md-row" + (task ? " md-row-task" : ""));
  // (The name's parts underlined, as links are, under the pointer: .link-text.)
  const name = el("span", "md-row-name");
  name.append(el("span", "md-row-title link-text", row.name));
  if (row.variant) {
    const variant = el("span", "md-row-variant");
    variant.append(el("span", "link-text", row.variant));
    name.append(variant);
  }
  const { strip, me } = buildStrip(row, d);
  const value = el("span", "md-row-value");
  r.append(name, strip, value);
  if (task) {
    r.type = "button";
    r.setAttribute("aria-haspopup", "dialog");   // (the task's details)
    r.dataset.task = row.key;
    r.addEventListener("click", () => hooks.onTask(row.key, r));
    const intent = () => hooks.onTaskIntent?.(row.key);
    let rest = null;
    r.addEventListener("pointerenter", () => { clearTimeout(rest); rest = setTimeout(intent, TASK_INTENT_MS); });
    r.addEventListener("pointerleave", () => clearTimeout(rest));
    r.addEventListener("pointerdown", () => { clearTimeout(rest); intent(); });
    r.addEventListener("focus", intent);
  }
  refs.set(row.key, { me, value });
  return r;
}

/** A row's model-specific part: its dot and value. */
function fillRow(ref, row, d) {
  ref.me.hidden = row.value == null;
  if (row.value != null) {
    ref.me.style.left = position(row.value, d.domain);
    ref.me.style.backgroundColor = d.color;
  }
  ref.value.textContent = row.text;
}

/** The details' element, hidden until shown: on a wide screen a drawer at
 *  the window's right edge (on the body, outside the page that slides
 *  under it), its sheet scrolling the content; otherwise a panel after
 *  `anchor` (the chart's zone). And the button that floats at the bottom of
 *  the screen while the panel is out of sight below (a tap doesn't scroll
 *  the page). hooks: onClose(), onShot(shot), onTask(task, rowElement),
 *  onTaskIntent(task). */
export function createModelDetail(anchor, hooks) {
  const { onClose, onShot } = hooks;
  const root = el("aside", "model-detail");
  root.setAttribute("aria-label", "Model details");
  root.hidden = true;
  const sheet = el("div", "md-sheet");
  root.append(sheet);
  const drawer = window.matchMedia(DETAIL_DRAWER);
  const place = () => { if (drawer.matches) document.body.append(root); else anchor.after(root); };
  place();
  drawer.addEventListener("change", place);
  const jump = el("button", "chart-jump detail-jump");
  jump.type = "button";
  jump.hidden = true;
  document.body.append(jump);
  const jumpText = el("span", "detail-jump-text");
  jump.append(jumpText);
  const below = () => !root.hidden && root.getBoundingClientRect().top > window.innerHeight - 48;
  jump.addEventListener("click", () => {
    jump.hidden = true;
    hideTooltip();
    root.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => { if (e.isIntersecting) jump.hidden = true; }).observe(root);
  }

  // What the sheet shows: its content's signature (shot and models: the
  // rows and the other models' dots) and the model; the rows' parts that
  // change with the model.
  let shown = null;   // { signature, model }
  let refs = new Map();
  let parts = null;   // { head, desc, legend, groups } (the shot control stays)
  let slide = null;   // the drawer's running slide (an Animation)
  let closing = null; // the panel's fade-out timer
  const shots = shotControl(onShot);
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => { if (!root.hidden) paintDotStrips(sheet); }).observe(sheet);
  }

  /** The sheet's content for `d`: the rows rebuilt for a new signature;
   *  otherwise only the model's parts (its dots glide to their new places).
   *  The shot control is updated in place. */
  function fill(d, opening) {
    const head = buildHead(d, onClose);
    const desc = el("p", "md-desc", d.description);
    desc.hidden = !d.description;
    const legend = buildLegend(d);
    shots.update(d);
    const inPlace = shown?.signature === d.signature && parts;
    const noGlide = opening || !inPlace;
    let groups = parts?.groups;
    if (!inPlace) {
      refs = new Map();
      groups = el("div", "md-groups");
      for (const g of d.groups) {
        const sec = el("section", "md-group");
        sec.append(el("h3", "md-cat", g.name));
        for (const row of g.rows) sec.append(buildRow(row, d, refs, hooks));
        groups.append(sec);
      }
    }
    if (noGlide) sheet.classList.add("md-fresh");
    if (parts) {
      parts.head.replaceWith(head);
      parts.desc.replaceWith(desc);
      parts.legend.replaceWith(legend);
      if (!inPlace) parts.groups.replaceWith(groups);   // (the sheet keeps its scroll)
      if (opening) sheet.scrollTop = 0;
    } else {
      sheet.replaceChildren(head, desc, shots.el, legend, groups);
      sheet.scrollTop = 0;
    }
    parts = { head, desc, legend, groups };
    for (const g of d.groups) for (const row of g.rows) fillRow(refs.get(row.key), row, d);
    if (noGlide && !opening) {
      sheet.getBoundingClientRect();   // (placed without transitions)
      sheet.classList.remove("md-fresh");
    }
    shown = { signature: d.signature, model: d.model, data: d };
    jumpText.textContent = d.title + ": details";
  }

  function gone() {
    clearTimeout(closing);
    closing = null;
    slide?.cancel();
    slide = null;
    root.classList.remove("closing");
    root.hidden = true;
    sheet.style.transform = "";
    sheet.style.willChange = "";
    // Keep `parts` and `shown` warm so reopening the drawer reuses the
    // existing rows and dot canvases in place instead of rebuilding them.
  }

  return {
    isOpen: () => !root.hidden,
    /** Task `task`'s row (a button), or null. */
    taskRow: (task) => (root.hidden ? null : root.querySelector(`.md-row-task[data-task="${CSS.escape(task)}"]`)),
    /** Show `d` (open or not; the same content again changes nothing). A
     *  drawer opened `offWindow` waits off the window for slide(true); the
     *  panel appears (style.css fades it in), brought into sight: `reveal`
     *  "scroll" scrolls the page to its head, "button" offers the floating
     *  button. */
    show(d, { reveal = null, offWindow = false } = {}) {
      if (closing) gone();
      const opening = root.hidden;
      if (opening || shown?.data !== d) fill(d, opening);
      root.hidden = false;
      paintDotStrips(sheet);
      if (opening && sheet.classList.contains("md-fresh")) {
        requestAnimationFrame(() => sheet.classList.remove("md-fresh"));
      }
      if (drawer.matches) {
        jump.hidden = true;
        if (opening && offWindow) {
          sheet.style.willChange = "transform";
          sheet.style.transform = "translate3d(100%, 0, 0)";
        }
        return;
      }
      this.reveal(reveal);
    },
    /** The panel brought into sight (see show). */
    reveal(how) {
      if (drawer.matches || root.hidden) return;
      if (how === "scroll") {
        // Enough of the panel in sight to read its head and score.
        const top = root.getBoundingClientRect().top, want = window.innerHeight - PANEL_IN_SIGHT_PX;
        if (top > want) window.scrollBy({ top: top - want, behavior: "smooth" });
      } else if (how === "button") {
        jump.hidden = !below();
      }
    },
    /** The drawer slides in (`inward`) or out: its Animation. Out, it is
     *  hidden once there. */
    slide(inward) {
      slide?.cancel();
      sheet.style.willChange = "transform";
      const from = inward ? "translate3d(100%, 0, 0)" : "translate3d(0, 0, 0)";
      const to = inward ? "translate3d(0, 0, 0)" : "translate3d(100%, 0, 0)";
      const mine = slide = sheet.animate([{ transform: from }, { transform: to }], detailMotion({ fill: "forwards" }));
      sheet.style.transform = "";
      mine.finished.then(() => {
        if (slide !== mine) return;
        sheet.style.willChange = "";
        if (inward) { mine.cancel(); slide = null; } else gone();
      }, () => { sheet.style.willChange = ""; });
      return mine;
    },
    /** Hidden: the panel fades out (`animate`, style.css .closing); else,
     *  or a drawer (which slide(false) slides out first), at once. */
    hide({ animate = false } = {}) {
      jump.hidden = true;
      if (root.hidden || closing) return;
      if (!animate || drawer.matches) { gone(); return; }
      root.classList.add("closing");
      closing = setTimeout(gone, parseFloat(getComputedStyle(root).animationDuration) * 1000 || 0);
    },
  };
}
