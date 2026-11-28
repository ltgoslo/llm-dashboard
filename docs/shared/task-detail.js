// Task details (comparison pages): a click on a task's row in a model's
// details expands the row into a view of nearly the window's size (all of
// it on a phone), over the dimmed page: the task, and the model's results
// on it.
//
// The head, which stays at the top, names the model (its badge, its name)
// and the task in one title; under it come, in this order:
// - the task's description and its source dataset;
// - the model's score at each shot count, with its best prompt, in the
//   details' segmented control, which picks the shot shown;
// - its score with each prompt, or in each subtask, beside every other
//   model's, with its 95% interval, over each prompt's text;
// - beside all that (under it on a narrow screen), every model's best score
//   in order: the model's own marked, its interval a band through the
//   list, which opens on it; another model's row opens its details of the
//   task in place.
// Each fact once; the details' three type sizes (style.css).
//
// comparison.js computes the content (taskDetailData) from the task's file
// (details/tasks/<task>.json, build_data.py write_task_details) and keeps
// the view in step with the details' model and shot. This module lays the
// content out and runs the motion: the view grows out of the row (its clip
// from the row's box to its own, the content fading in) and shrinks back
// into it.
//
// A judged task (/instruct: every response graded 0–5 by an LLM judge)
// shows, in place of the shots and the prompts' texts: the model's mean
// grade ± its 95% interval beside the judge's grades of all its responses
// (a row per grade, best first: its meaning in the judge's rubric, its
// share as a bar in a shade of the model's colour); and the examples
// (task-examples.js): the prompts and the model's responses as in a
// messaging app, and their judgments. Its type is every task view's.

import { el, position, shotControl, detailMotion, makeDotCanvas, paintDotStrips } from "./model-detail.js";
import { createExamples, setModelColors } from "./task-examples.js";

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
  strip.append(makeDotCanvas(row.all, d.domain));
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

// The grades' meanings, short, from the judge's rubric (0–5).
const RUBRIC = ["incorrect", "mostly incorrect", "partly correct", "a clear error", "a minor flaw", "fully correct"];

/** A judged task's headline: the model's mean grade ± its 95% interval,
 *  and beside it the judge's grades of all its responses, a row for each
 *  grade, best first: its meaning in the judge's rubric, its share as a bar
 *  in the grade's shade (the examples' tiles'). */
function buildJudgedHeadline(d) {
  const box = el("div", "tv-judged");
  const line = el("div", "tv-score-line");
  line.append(el("span", "tv-score-value", d.headline.value));
  if (d.headline.margin) line.append(el("span", "tv-score-ci", "± " + d.headline.margin));
  const score = el("div", "tv-score");
  score.append(el("div", "tv-label", "Mean grade"), line);
  box.append(score);
  if (!d.grades) return box;
  const counts = d.grades.counts;
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const shares = counts.map((c) => c / total);
  const most = Math.max(...shares, 1e-9);
  const pct = (x) => (x >= 0.005 ? Math.round(x * 100) + "%" : x > 0 ? "<1%" : "0%");
  const rows = el("div", "tv-rubric");
  for (let k = 5; k >= 0; k--) {
    const row = el("div", "tv-rubric-row");
    row.title = `${k} of 5 (${RUBRIC[k]}): ${counts[k].toLocaleString("en")} of ${total.toLocaleString("en")} responses`;
    const track = el("span", "tv-rubric-track");
    const bar = el("span", "tv-rubric-bar");
    bar.dataset.points = k;
    bar.style.width = counts[k] ? Math.max(1, (shares[k] / most) * 100).toFixed(1) + "%" : "0";
    track.append(bar);
    row.append(el("span", "tv-rubric-grade", String(k)), el("span", "tv-rubric-name", RUBRIC[k]), track, el("span", "tv-rubric-share", pct(shares[k])));
    rows.append(row);
  }
  const fig = el("figure", "tv-grades");
  fig.append(el("figcaption", "tv-label", "Grades"), rows);
  box.append(fig);
  return box;
}

/** A judged task's note, if any (its file couldn't be loaded). */
function buildJudgedSections(d) {
  return d.note ? [el("p", "tv-note", d.note)] : [];
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
 *  95% interval a band through the list. Every other model's row is a link
 *  (its name in the links' colour) to its own details of the task
 *  (`onModel`). */
function buildRanking(d, onModel) {
  const r = d.ranking;
  const sec = el("section", "tv-section tv-ranking");
  sec.append(el("h3", "tv-h", r.title));
  const note = el("p", "tv-note", r.note);
  if (r.ci) {
    const key = el("span", "md-legend-item");
    const band = el("span", "tv-legend-band");
    key.append(band, `${d.model.title}'s 95% interval`);
    note.append(...(r.note ? [" "] : []), key);
  }
  if (note.childNodes.length) sec.append(note);
  const list = el("div", "tv-rank-list");
  const zero = parseFloat(position(0, r.domain));
  for (const m of r.rows) {
    const link = !m.me && !!onModel;
    const row = el(link ? "button" : "div", "tv-rank-row" + (m.me ? " tv-rank-me" : ""));
    if (link) {
      row.type = "button";
      row.title = `${m.name} on this task`;
      row.addEventListener("click", () => onModel(m.id));
    }
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
    const name = el("span", "tv-rank-name");
    name.append(link ? el("span", "link-text", m.name) : m.name);
    row.append(name, track, el("span", "tv-rank-value", m.text));
    list.append(row);
  }
  sec.append(list);
  return { sec, list };
}

/** The task's source dataset: "Source dataset: hf.co/… ↗" (under its
 *  description). */
function buildSource(link) {
  const a = el("a", "md-link");
  a.href = link.href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.append(el("span", "link-text", link.text), "\u00a0", el("span", "md-link-arrow", "↗"));
  const source = el("p", "tv-source");
  source.append("Source dataset: ", a);
  return source;
}

/** The head, which stays at the view's top: the model's badge, the model
 *  and the task as one title ("NorMistral 11B – Idiom completion
 *  [Bokmål]"), the close button. */
function buildHead(d, onClose) {
  const head = el("header", "tv-head");
  const title = el("h2", "tv-title");
  title.id = "tv-title";
  title.append(el("span", "tv-title-model", d.model.title), " – ", d.title);
  if (d.variant) title.append(" [" + d.variant + "]");
  const close = el("button", "md-close");
  close.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
    + '<path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  close.type = "button";
  close.title = "Close (Esc)";
  close.setAttribute("aria-label", "Close the task's details");
  close.addEventListener("click", onClose);
  head.append(d.model.badge(), title, close);
  return head;
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
export function createTaskDetail({ onClose, onShot, onModel }) {
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
    const stops = [...sheet.querySelectorAll("a[href], button:not([disabled]), summary")].filter((x) => x.offsetParent && x.tabIndex >= 0);
    if (!stops.length) { e.preventDefault(); return; }
    const first = stops[0], last = stops[stops.length - 1], at = document.activeElement;
    if (e.shiftKey && (at === first || at === sheet || at === parts?.body)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  });

  const shots = shotControl(onShot);   // (kept: its thumb slides to a picked shot)
  const examples = createExamples();   // (a judged task's: kept for the same task)
  let parts = null;    // { head, body, list }
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
    // `.tv-side` is sticky relative to `.tv-body`, so `list.getBoundingClientRect().top`
    // is already in viewport coordinates whether `.tv-body` is scrolled or not.
    const room = beside
      ? sheet.getBoundingClientRect().bottom - list.getBoundingClientRect().top - 24
      : window.innerHeight * 0.6;
    list.style.maxHeight = Math.max(240, Math.floor(room)) + "px";
    const me = list.querySelector(".tv-rank-me");
    if (center && me) list.scrollTop = Math.max(0, me.offsetTop - (list.clientHeight - me.offsetHeight) / 2);
    fadeList();
    paintDotStrips(content);
  }
  /** The list's ends fade where it scrolls on. */
  function fadeList() {
    const list = parts?.list;
    if (!list) return;
    list.classList.toggle("fade-top", list.scrollTop > 1);
    list.classList.toggle("fade-bottom", list.scrollTop + list.clientHeight < list.scrollHeight - 1);
  }
  window.addEventListener("resize", () => { if (!root.hidden) placeList(false); });
  function fill(d) {
    const head = buildHead(d, onClose);
    const main = el("div", "tv-main");
    if (d.description) main.append(el("p", "tv-desc", d.description));
    if (d.link) main.append(buildSource(d.link));
    if (d.judged) {
      main.append(buildJudgedHeadline(d));
      main.append(...buildJudgedSections(d));
      if (d.examples) main.append(examples.build(d));
    } else {
      shots.update(d);
      main.append(shots.el);
      if (d.prompts.length > 1 || d.parts) main.append(buildLegend(d));
      main.append(...buildSections(d));
    }
    const side = el("aside", "tv-side");
    const ranking = buildRanking(d, onModel);
    ranking.list.addEventListener("scroll", fadeList, { passive: true });
    side.append(ranking.sec);
    const body = el("div", "tv-body");
    body.tabIndex = -1;
    body.append(main, side);
    const top = parts?.body.scrollTop || 0, listTop = parts?.list.scrollTop || 0;
    content.style.setProperty("--tv-me", d.model.color);
    if (d.judged) setModelColors(content, d.model.color);
    content.replaceChildren(head, body);
    body.scrollTop = shown?.task === d.task ? top : 0;
    parts = { head, body, list: ranking.list };
    const recenter = !shown || shown.task !== d.task || shown.model.id !== d.model.id || shown.shot !== d.shot;
    shown = d;
    placeList(recenter);
    if (!recenter) { ranking.list.scrollTop = listTop; fadeList(); }
  }

  function stop() {
    opening = null;
    for (const a of motion) a.cancel();
    motion = [];
    sheet.style.willChange = "";
    backdrop.style.willChange = "";
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

  /** GPU-composited directional transform emerging from / returning toward `r`
   *  (avoids animating clip-path across a large shadowed sheet). */
  function zoomTransform(r, scale) {
    const s = sheet.getBoundingClientRect();
    const dx = (r.left + r.width / 2) - (s.left + s.width / 2);
    const dy = (r.top + r.height / 2) - (s.top + s.height / 2);
    const tx = Math.round(Math.max(-160, Math.min(160, dx * 0.22)));
    const ty = Math.round(Math.max(-120, Math.min(120, dy * 0.22)));
    return `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
  }
  const onScreen = (r) => r && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;

  return {
    isOpen: () => !root.hidden && !closing,
    /** Show `d`: opened (zooming smoothly from `from`, a DOMRect, if any;
     *  focus returns to `refocusTo` when it closes) or updated in place. */
    show(d, { from = null, refocusTo = null } = {}) {
      if (closing) gone();
      if (!root.hidden) { if (d !== shown) fill(d); return; }
      refocus = refocusTo || document.activeElement;
      root.hidden = false;
      fill(d);
      (parts?.body || sheet).focus({ preventScroll: true });
      if (!onScreen(from)) return;
      stop();
      // Hold one frame at the starting GPU transform while layout & canvases
      // finish painting, then run a pure transform + opacity animation.
      const startTransform = zoomTransform(from, 0.93);
      const token = opening = {};
      sheet.style.willChange = "transform, opacity";
      backdrop.style.willChange = "opacity";
      const hold = [
        backdrop.animate([{ opacity: 0 }], { fill: "forwards" }),
        sheet.animate([{ transform: startTransform, opacity: 0 }], { fill: "forwards" }),
      ];
      motion = hold;
      requestAnimationFrame(() => {
        if (opening !== token) return;
        opening = null;
        for (const a of hold) a.cancel();
        const opts = detailMotion({ duration: detailMotion().duration ? 240 : 0, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
        motion = [
          backdrop.animate([{ opacity: 0 }, { opacity: 1 }], opts),
          sheet.animate(
            [{ transform: startTransform, opacity: 0 }, { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 }],
            opts,
          ),
        ];
        Promise.all(motion.map((a) => a.finished)).then(() => {
          motion = [];
          sheet.style.willChange = "";
          backdrop.style.willChange = "";
        }, () => {});
      });
    },
    /** Hidden: zoomed back toward its row (`animate`), else at once.
     *  Focus goes to `focus` if given (else back where it was before opening). */
    hide({ to = null, focus = null } = {}) {
      if (root.hidden || closing) return;
      if (focus) refocus = focus;
      if (!onScreen(to)) { gone(); return; }
      stop();
      const token = closing = {};
      const endTransform = zoomTransform(to, 0.94);
      sheet.style.willChange = "transform, opacity";
      backdrop.style.willChange = "opacity";
      const opts = detailMotion({ duration: detailMotion().duration ? 185 : 0, fill: "forwards" });
      motion = [
        backdrop.animate([{ opacity: 1 }, { opacity: 0 }], opts),
        sheet.animate(
          [{ transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 }, { transform: endTransform, opacity: 0 }],
          opts,
        ),
      ];
      Promise.all(motion.map((a) => a.finished)).then(() => { if (closing === token) gone(); }, () => {});
    },
  };
}
