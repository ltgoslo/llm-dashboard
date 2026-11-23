// Task details (comparison pages): a click on a task's row in a model's
// details expands the row into a view of nearly the window's size (all of
// it on a phone), over the dimmed page: the task, and the model's results
// on it.
//
// The head, which stays at the top, names the model and the task; under it
// come the task's facts (category, kind of answers, number of examples and
// of prompts) and its dataset, and then, in this order:
// - the task's description;
// - the model's score at each shot count, with its best prompt, in the
//   details' segmented control, which picks the shot shown;
// - its score with each prompt, or in each subtask, beside every other
//   model's, with its 95% interval, over each prompt's text;
// - beside all that (under it on a narrow screen), every model's best score
//   in order: the model's own marked, its interval a band through the
//   list, which opens on it.
// Each fact once; the details' three type sizes (style.css).
//
// comparison.js computes the content (taskDetailData) from the task's file
// (details/tasks/<task>.json, build_data.py write_task_details) and keeps
// the view in step with the details' model and shot. This module lays the
// content out and runs the motion: the view grows out of the row (its clip
// from the row's box to its own, the content fading in) and shrinks back
// into it. A model's generated answers would be a further section here.

import { el, position, shotControl, detailMotion } from "./model-detail.js";

/** Text with its slots ({{expression}}: fields of the task's examples)
 *  appended to `node`, each slot a tag. */
function appendTemplate(node, text) {
  let last = 0;
  for (const m of text.matchAll(/\{\{\s*([\s\S]*?)\s*\}\}/g)) {
    if (m.index > last) node.append(text.slice(last, m.index));
    node.append(el("span", "tv-slot", m[1]));
    last = m.index + m[0].length;
  }
  if (last < text.length) node.append(text.slice(last));
  return node;
}

/** A prompt as the model reads it (the task's instruction, then the text
 *  with its slots), and what is scored: the answer options of a multiple-
 *  choice prompt, or the reference a generated answer is compared with. */
function buildPromptText(p) {
  const box = el("div", "tv-prompt-text");
  if (p.instruction || p.text) {
    const text = el("div", "tv-template");
    if (p.instruction) appendTemplate(text, p.instruction + "\n");
    appendTemplate(text, p.text || "");
    box.append(text);
  }
  if (p.choices) {
    const line = el("div", "tv-scored", "Answer options: ");
    if (Array.isArray(p.choices)) {
      p.choices.forEach((c, i) => line.append(...(i ? [" · "] : []), el("span", "tv-option", c)));
    } else appendTemplate(line, p.choices);
    box.append(line);
  } else if (p.target) {
    box.append(appendTemplate(el("div", "tv-scored", "Reference: "), p.target));
  }
  return box;
}

/** A row of scores: its name, every model's score (the dots), the model's
 *  with its 95% interval, and its value. */
function buildScoreRow(row, d) {
  const r = el("div", "tv-row");
  const name = el("span", "tv-row-name", row.name);
  if (row.best) name.append(el("span", "tv-best", "best"));
  const strip = el("div", "tv-strip");
  for (const v of row.all) {
    if (v == null) continue;
    const dot = el("span", "md-dot");
    dot.style.left = position(v, d.domain);
    strip.append(dot);
  }
  if (row.ci) {
    const ci = el("span", "tv-ci");
    ci.style.left = position(row.ci[0], d.domain);
    ci.style.width = (parseFloat(position(row.ci[1], d.domain)) - parseFloat(position(row.ci[0], d.domain))).toFixed(2) + "%";
    ci.style.backgroundColor = d.model.color;
    strip.append(ci);
  }
  if (row.value != null) {
    const me = el("span", "md-me");
    me.style.left = position(row.value, d.domain);
    me.style.backgroundColor = d.model.color;
    strip.append(me);
  }
  r.append(name, strip, el("span", "tv-row-value", row.text));
  if (row.note) r.append(el("span", "tv-row-note", row.note));
  return r;
}

/** What the dots are: the model's (in its colour, with its interval) and
 *  the others'. */
function buildLegend(d) {
  const lg = el("div", "md-legend");
  const me = el("span", "md-legend-item");
  me.append(el("span", "tv-legend-me"), `${d.model.title}, with its 95% interval`);
  const others = el("span", "md-legend-item");
  others.append(el("span", "md-legend-dot"), d.others === 1 ? "1 other model" : `${d.others} other models`);
  lg.append(me, others);
  return lg;
}

/** The task's prompts: with several, a row of scores over each one's
 *  text; one alone, its text. With subtasks, a row of scores for each. */
function buildSections(d) {
  const out = [];
  if (d.parts) {
    const sec = el("section", "tv-section tv-parts");
    sec.append(el("h3", "tv-h", "Subtasks"));
    for (const p of d.parts) sec.append(buildScoreRow(p, d));
    out.push(sec);
  }
  const sec = el("section", "tv-section tv-prompts");
  sec.append(el("h3", "tv-h", d.prompts.length > 1 ? "Prompts" : "Prompt"));
  if (d.note) sec.append(el("p", "tv-note", d.note));
  for (const p of d.prompts) {
    const item = el("div", "tv-prompt");
    if (d.prompts.length > 1) item.append(buildScoreRow(p, d));
    item.append(buildPromptText(p.template));
    sec.append(item);
  }
  out.push(sec);
  return out;
}

/** Every model's best score in order, as bars: the model's own marked, its
 *  95% interval a band through the list. */
function buildRanking(d) {
  const r = d.ranking;
  const sec = el("section", "tv-section tv-ranking");
  sec.append(el("h3", "tv-h", r.title));
  const note = el("p", "tv-note", r.note);
  if (r.ci) {
    const key = el("span", "md-legend-item");
    const band = el("span", "tv-legend-band");
    key.append(band, `${d.model.title}'s 95% interval`);
    note.append(" ", key);
  }
  sec.append(note);
  const list = el("div", "tv-rank-list");
  const zero = parseFloat(position(0, r.domain));
  for (const m of r.rows) {
    const row = el("div", "tv-rank-row" + (m.me ? " tv-rank-me" : ""));
    const track = el("span", "tv-rank-track");
    if (r.ci) {
      const band = el("span", "tv-rank-band");
      band.style.left = position(r.ci[0], r.domain);
      band.style.width = (parseFloat(position(r.ci[1], r.domain)) - parseFloat(position(r.ci[0], r.domain))).toFixed(2) + "%";
      track.append(band);
    }
    const bar = el("span", "tv-rank-bar");
    const x = parseFloat(position(m.value, r.domain));
    bar.style.left = Math.min(zero, x).toFixed(2) + "%";
    bar.style.width = Math.abs(x - zero).toFixed(2) + "%";
    track.append(bar);
    row.append(el("span", "tv-rank-name", m.name), track, el("span", "tv-rank-value", m.text));
    list.append(row);
  }
  sec.append(list);
  return { sec, list };
}

/** The head, which stays at the view's top: the model, the task, the
 *  close button. And the task's facts and dataset under it, which scroll
 *  away. */
function buildHead(d, onClose) {
  const head = el("header", "tv-head");
  const titles = el("div", "tv-titles");
  const model = el("div", "tv-model");
  const dot = el("span", "tv-model-dot");
  dot.style.backgroundColor = d.model.color;
  model.append(dot, d.model.title);
  const title = el("h2", "tv-title", d.title);
  title.id = "tv-title";
  if (d.variant) title.append(el("span", "tv-variant", " · " + d.variant));
  titles.append(model, title);
  const intro = el("div", "tv-intro");
  if (d.facts.length) {
    const meta = el("div", "md-meta");
    d.facts.forEach((f, i) => meta.append(...(i ? [" · "] : []), el("span", "md-fact", f)));
    intro.append(meta);
  }
  if (d.link) {
    const a = el("a", "md-link");
    a.href = d.link.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.append(el("span", "link-text", d.link.text), "\u00a0", el("span", "md-link-arrow", "↗"));
    intro.append(a);
  }
  const close = el("button", "md-close");
  close.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
    + '<path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  close.type = "button";
  close.title = "Close (Esc)";
  close.setAttribute("aria-label", "Close the task's details");
  close.addEventListener("click", onClose);
  head.append(titles, close);
  return { head, intro };
}

/** Whether a wheel turn `dy` over `target` scrolls something in the view
 *  (else the page under it would). */
function scrollsInside(target, root, dy) {
  for (let n = target; n && n !== root; n = n.parentElement) {
    if (!/(auto|scroll)/.test(getComputedStyle(n).overflowY)) continue;
    if (dy < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1) return true;
  }
  return false;
}

/** The view's element, hidden until shown (on the body). hooks:
 *  onClose(), onShot(shot). */
export function createTaskDetail({ onClose, onShot }) {
  const root = el("div", "task-view");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "tv-title");
  const backdrop = el("div", "tv-backdrop");
  const sheet = el("div", "tv-sheet");
  sheet.tabIndex = -1;
  const content = el("div", "tv-content");
  sheet.append(content);
  root.append(backdrop, sheet);
  document.body.append(root);
  backdrop.addEventListener("click", onClose);
  // The page under the view stays where it is: a wheel turn or a swipe
  // that wouldn't scroll the view does nothing.
  root.addEventListener("wheel", (e) => { if (!scrollsInside(e.target, root, e.deltaY)) e.preventDefault(); }, { passive: false });
  backdrop.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  // Tab stays in the view.
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const stops = [...sheet.querySelectorAll("a[href], button:not([disabled])")].filter((x) => x.offsetParent);
    if (!stops.length) { e.preventDefault(); return; }
    const first = stops[0], last = stops[stops.length - 1], at = document.activeElement;
    if (e.shiftKey && (at === first || at === sheet)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  });

  const shots = shotControl(onShot);   // (kept: its thumb slides to a picked shot)
  let parts = null;    // { head, intro, list }
  let shown = null;    // the content shown
  let motion = [];     // the running Animations
  let opening = null;  // the opening's token, while its start is held
  let closing = null;  // the closing's token
  let refocus = null;  // what had focus before the view opened

  /** The ranking's list as tall as the view leaves it beside the
   *  prompts (wide screens: down to the sheet's bottom as it opens), else
   *  60% of the window; opened on the model. */
  function placeList(center) {
    const list = parts?.list;
    if (!list) return;
    const side = list.closest(".tv-side");
    const beside = side && getComputedStyle(side).position === "sticky";
    sheet.style.setProperty("--tv-head-h", parts.head.offsetHeight + "px");
    const room = beside
      ? sheet.getBoundingClientRect().bottom - list.getBoundingClientRect().top - sheet.scrollTop - 24
      : window.innerHeight * 0.6;
    list.style.maxHeight = Math.max(240, Math.floor(room)) + "px";
    const me = list.querySelector(".tv-rank-me");
    if (center && me) list.scrollTop = Math.max(0, me.offsetTop - (list.clientHeight - me.offsetHeight) / 2);
    fadeList();
  }
  /** The list's ends fade where it scrolls on. */
  function fadeList() {
    const list = parts?.list;
    if (!list) return;
    list.classList.toggle("fade-top", list.scrollTop > 1);
    list.classList.toggle("fade-bottom", list.scrollTop + list.clientHeight < list.scrollHeight - 1);
  }
  window.addEventListener("resize", () => { if (!root.hidden) placeList(false); });
  // The head's rule shows once the facts under it have scrolled away.
  const stuck = () => sheet.classList.toggle("tv-stuck", !!parts && sheet.scrollTop > parts.intro.offsetHeight - 1);
  sheet.addEventListener("scroll", stuck, { passive: true });

  function fill(d) {
    const { head, intro } = buildHead(d, onClose);
    const main = el("div", "tv-main");
    if (d.description) main.append(el("p", "tv-desc", d.description));
    shots.update(d);
    main.append(shots.el);
    if (d.prompts.length > 1 || d.parts) main.append(buildLegend(d));
    main.append(...buildSections(d));
    const side = el("aside", "tv-side");
    const ranking = buildRanking(d);
    ranking.list.addEventListener("scroll", fadeList, { passive: true });
    side.append(ranking.sec);
    const body = el("div", "tv-body");
    body.append(main, side);
    const top = sheet.scrollTop, listTop = parts?.list.scrollTop || 0;
    content.style.setProperty("--tv-me", d.model.color);
    content.replaceChildren(head, intro, body);
    sheet.scrollTop = shown?.task === d.task ? top : 0;
    parts = { head, intro, list: ranking.list };
    stuck();
    const recenter = !shown || shown.task !== d.task || shown.model.id !== d.model.id || shown.shot !== d.shot;
    shown = d;
    placeList(recenter);
    if (!recenter) { ranking.list.scrollTop = listTop; fadeList(); }
  }

  function stop() {
    opening = null;
    for (const a of motion) a.cancel();
    motion = [];
  }

  function gone() {
    stop();
    closing = null;
    root.hidden = true;
    content.replaceChildren();
    parts = null;
    shown = null;
    const back = refocus;
    refocus = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }

  /** The sheet's clip as the box `r` (a DOMRect on the screen). */
  function clipTo(r) {
    const s = sheet.getBoundingClientRect();
    const px = (v) => Math.round(v) + "px";
    return `inset(${px(r.top - s.top)} ${px(s.right - r.right)} ${px(s.bottom - r.bottom)} ${px(r.left - s.left)} round 8px)`;
  }
  const clipNone = () => `inset(0px 0px 0px 0px round ${getComputedStyle(sheet).borderTopLeftRadius})`;
  const onScreen = (r) => r && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;

  return {
    isOpen: () => !root.hidden && !closing,
    /** Show `d`: opened (grown out of the box `from`, a DOMRect, if any;
     *  focus returns to `refocusTo` when it closes) or updated in place. */
    show(d, { from = null, refocusTo = null } = {}) {
      if (closing) gone();
      if (!root.hidden) { if (d !== shown) fill(d); return; }
      refocus = refocusTo || document.activeElement;
      root.hidden = false;
      fill(d);
      sheet.focus({ preventScroll: true });
      if (!onScreen(from)) return;
      stop();
      // The motion's start held for two frames, while the content is laid
      // out and painted (hidden); nothing moves before it is.
      const start = clipTo(from), token = opening = {};
      const hold = [
        backdrop.animate([{ opacity: 0 }], { fill: "forwards" }),
        sheet.animate([{ clipPath: start }], { fill: "forwards" }),
        content.animate([{ opacity: 0 }], { fill: "forwards" }),
      ];
      motion = hold;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (opening !== token) return;
        opening = null;
        for (const a of hold) a.cancel();
        motion = [
          backdrop.animate([{ opacity: 0 }, { opacity: 1 }], detailMotion()),
          sheet.animate([{ clipPath: start }, { clipPath: clipNone() }], detailMotion()),
          // (Hidden while it doesn't show: the clip's frames paint no more than the sheet.)
          content.animate([{ opacity: 0, visibility: "hidden" }, { opacity: 0, visibility: "hidden", offset: 0.29 },
            { opacity: 0, visibility: "visible", offset: 0.3 }, { opacity: 1, visibility: "visible" }], detailMotion()),
        ];
        Promise.all(motion.map((a) => a.finished)).then(() => { motion = []; }, () => {});
      }));
    },
    /** Hidden: shrunk into the box `to` (a DOMRect), if any on the screen,
     *  else at once. Focus goes to `focus` if given (else back where it was
     *  before the view opened). */
    hide({ to = null, focus = null } = {}) {
      if (root.hidden || closing) return;
      if (focus) refocus = focus;
      if (!onScreen(to)) { gone(); return; }
      stop();
      const token = closing = {};
      motion = [
        backdrop.animate([{ opacity: 1 }, { opacity: 0 }], detailMotion({ fill: "forwards" })),
        sheet.animate([{ clipPath: clipNone() }, { clipPath: clipTo(to) }], detailMotion({ fill: "forwards" })),
        content.animate([{ opacity: 1, visibility: "visible" }, { opacity: 0, visibility: "visible", offset: 0.4 },
          { opacity: 0, visibility: "hidden", offset: 0.41 }, { opacity: 0, visibility: "hidden" }], detailMotion({ fill: "forwards" })),
      ];
      Promise.all(motion.map((a) => a.finished)).then(() => { if (closing === token) gone(); }, () => {});
    },
  };
}
