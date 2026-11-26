// Examples of a judged task (/instruct) in the task view (task-detail.js):
// the task's first draws, the same prompts for every model, one at a time,
// as a conversation in a messaging app.
//
// A picker like the page's dropdowns picks the example: it shows the
// example's grade (a tile in its colour), number and prompt in a line, and
// opens a list of every example; ‹ › beside it, and ← → on it, step
// through them. An example: the prompt, a message from someone else (a
// grey bubble on the left); the model's response, the reader's own
// message (a bubble in the model's colour on the right, Markdown rendered
// by markdown.js), its reasoning folded over it (the judge never sees
// it); and under them, in labelled rows, the judge's grade, the reference
// it graded against and its assessment. Then every other model's grade of
// its own response to the same prompt, each unfolding into that response
// and its assessment. The prompt, the model's own texts and the judge's
// assessments show whole; a long reference shows its start, "Show all"
// the rest.
//
// A grade's colour is a shade of its model's colour (gradeShades: grades
// 0–5 from very light to dark), the same in the task's grade rows
// (task-detail.js); so are its messages' (chatShades).
//
// comparison.js supplies the content (judgedTaskDetailData: d.examples)
// and loads the models' responses (d.examples.load(model), from
// details/responses/<model>/<task>.json).

import { el } from "./model-detail.js";
import { renderMarkdown } from "./markdown.js";

const CLAMP_SLACK_PX = 24;   // a text this little taller than its clamp shows whole

// ── Grade colours ──

const shadeCache = new Map();

/** sRGB hex → CIELAB (D65). */
function hexToLab(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map(lin);
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const fy = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const fz = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIELAB → linear sRGB (out of gamut: components outside 0–1). */
function labToLinear([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

/** CIELAB → sRGB hex, its chroma lowered (hue and lightness kept) until it
 *  is a colour the screen can show. */
function labToHex([L, a, b]) {
  const fits = (rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
  let k = 1;
  if (!fits(labToLinear([L, a, b]))) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(labToLinear([L, a * mid, b * mid]))) lo = mid; else hi = mid;
    }
    k = lo;
  }
  const gamma = (c) => {
    c = Math.min(1, Math.max(0, c));
    return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
  };
  return "#" + labToLinear([L, a * k, b * k]).map((c) => gamma(c).toString(16).padStart(2, "0")).join("");
}

/** The colours of grades 0–5 of a model whose colour is `hex`: evenly
 *  spaced in CIELAB from a very light tint of it (lightness 90, grade 0:
 *  about 1.3:1 against white, so a mark of it is labelled wherever it
 *  shows) to the colour itself, or a darker shade of it (lightness 42) if
 *  it is lighter. (Checked on the pages' colours: one hue, lightness
 *  monotone, every step visible.) */
export function gradeShades(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || "")) hex = "#64748b";
  if (!shadeCache.has(hex)) {
    const [L, a, b] = hexToLab(hex);
    const dark = [Math.min(L, 42), a, b];
    const light = [90, a * 0.25, b * 0.25];
    shadeCache.set(hex, [0, 1, 2, 3, 4, 5].map((k) => labToHex(light.map((v, i) => v + (dark[i] - v) * k / 5))));
  }
  return shadeCache.get(hex);
}

/** Contrast of white text on sRGB colour `hex` (WCAG). */
function contrastWithWhite(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const y = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return 1.05 / (y + 0.05);
}

/** The colours of the messages of a model whose colour is `hex`: its
 *  bubble ("me"), white text on the colour itself or, where that would
 *  read under 4.5:1, on the lightest shade of it (in CIELAB) that reads
 *  4.5:1; and a pale tint of it ("tint"), its reasoning's. */
export function chatShades(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || "")) hex = "#64748b";
  const key = "chat" + hex;
  if (!shadeCache.has(key)) {
    const [L, a, b] = hexToLab(hex);
    let l = L, me = hex;
    while (contrastWithWhite(me) < 4.5 && l > 0) me = labToHex([l = Math.min(l, 50) - 0.5, a, b]);
    shadeCache.set(key, { me, tint: labToHex([95, a * 0.12, b * 0.12]) });
  }
  return shadeCache.get(key);
}

/** Give `node` the colours of a model of colour `hex`: its grades' (--g0 …
 *  --g5, which [data-points] picks from) and its messages' (--me,
 *  --me-tint; style.css). */
export function setModelColors(node, hex) {
  gradeShades(hex).forEach((c, k) => node.style.setProperty(`--g${k}`, c));
  const { me, tint } = chatShades(hex);
  node.style.setProperty("--me", me);
  node.style.setProperty("--me-tint", tint);
  return node;
}

// ── Parts ──

/** The judge's output without its closing "SCORE: <n>" line (the grade is
 *  shown on its own). */
function assessment(output) {
  return (output || "").replace(/\s*SCORE:\s*\d+\s*$/, "").trim();
}

/** A grade as five pips, as many filled (in the grade's colour) as it
 *  has points. */
function gradePips(points) {
  const pips = el("span", "tx-pips");
  pips.dataset.points = points ?? "";
  pips.setAttribute("aria-hidden", "true");
  for (let k = 1; k <= 5; k++) pips.append(el("span", "tx-pip" + (points != null && k <= points ? " on" : "")));
  return pips;
}

/** A text shown whole (a model's answer, its reasoning, the judge's
 *  assessment): Markdown rendered (markdown.js). */
function fullText(text, cls = "") {
  const body = el("div", "markdown" + (cls ? " " + cls : ""));
  body.append(renderMarkdown(text));
  return body;
}

/** A reference's text as written (its line breaks and spaces kept), its
 *  start only when it is long: "Show all" unfolds the rest. */
function clampedText(text) {
  const wrap = el("div", "tx-clampable");
  const body = el("div", "tx-text tx-clamped", text);
  const more = el("button", "tx-more", "Show all");
  more.type = "button";
  more.hidden = true;
  wrap.append(body, more);
  const check = () => {
    if (!body.isConnected || !body.offsetParent || !body.classList.contains("tx-clamped") || !more.hidden) return;
    if (body.scrollHeight <= body.clientHeight + CLAMP_SLACK_PX) body.classList.remove("tx-clamped");
    else more.hidden = false;
  };
  more.addEventListener("click", () => {
    const fold = !body.classList.contains("tx-clamped");
    body.classList.toggle("tx-clamped", fold);
    more.textContent = fold ? "Show all" : "Show less";
    if (fold && wrap.getBoundingClientRect().top < 0) wrap.scrollIntoView({ block: "start" });
  });
  requestAnimationFrame(check);
  return wrap;
}

/** The reference the judge graded against, as labelled parts
 *  ([{label, node}]): its text under "Reference" (several, numbered, under
 *  "References (3, by different writers)"), or each of its labelled
 *  answers ("Correct option": "B (Hval)", "True answers": a list of
 *  several, "True answer": one). */
function referenceParts(ref) {
  if (ref?.texts) {
    const several = ref.texts.length > 1;
    const box = el("div", "tx-ref");
    ref.texts.forEach((t, i) => {
      const text = clampedText(t);
      if (!several) { box.append(text); return; }
      const item = el("div", "tx-ref-item");
      item.append(el("span", "tx-ref-n", `${i + 1}.`), text);
      box.append(item);
    });
    return [{ label: several ? `References (${ref.texts.length}, by different writers)` : "Reference", node: box }];
  }
  // A list only of several: one item is a text, under its label in the
  // singular ("Accepted completion: på" for the judge's "Accepted
  // completions:" and its one "- på").
  return (ref?.sections || []).map((sec) => {
    if (sec.items?.length > 1) {
      const node = el("ul", "tx-ref-items");
      for (const it of sec.items) node.append(el("li", "tx-text", it));
      return { label: sec.label, node };
    }
    if (sec.items) return { label: singular(sec.label), node: el("div", "tx-text", sec.items[0] ?? "") };
    return { label: sec.label, node: el("div", "tx-text", sec.text) };
  });
}

/** A list's label for one item of it: "Accepted completions" → "Accepted
 *  completion", "Correct options (any one of them)" → "Correct option". */
function singular(label) {
  return label.replace(/\s*\(.*\)$/, "").replace(/([^s])s$/, "$1");
}

/** How a response ended, when not by itself: cut at the token limit, or
 *  without an answer. */
function endings(r, limit) {
  const out = [];
  const tokens = limit ? `${limit.toLocaleString("en")}-token` : "token";
  if (r.judge_auto === "no_answer") {
    out.push(`No answer: the model was still reasoning at its ${tokens} limit (graded 0, without the judge).`);
  } else if (r.finish_reason === "length") {
    out.push(`Cut off at the ${tokens} limit.`);
  }
  if (r.judged_response_cut) out.push("Too long for the judge, who read only its first 16,000 characters.");
  return out;
}

/** A message's bubble, holding `content`; `tailed`: the last of its
 *  sender's, with the bubble's tail. */
function bubble(cls, content, tailed = true) {
  const b = el("div", "tx-bubble " + cls + (tailed ? " tx-tailed" : ""));
  b.append(content);
  return b;
}

/** A grade's line: its pips, and "3 of 5". */
function gradeLine(points) {
  const line = el("div", "tx-grade");
  line.dataset.points = points ?? "";
  line.append(gradePips(points), el("span", "tx-grade-text", points == null ? "No grade" : `${points} of 5`));
  return line;
}

/** The judge's part of response `r`, in labelled rows: its grade (if
 *  `graded`), the reference (if any) and its assessment (whole); null if
 *  none. */
function judgePart(r, { graded, reference }) {
  const text = assessment(r.judge_output);
  if (!graded && !reference && !text) return null;
  const rows = el("dl", "tx-rows");
  const row = (label, content) => {
    const dd = el("dd");
    dd.append(content);
    rows.append(el("dt", "", label), dd);
  };
  if (graded) row("Grade", gradeLine(r.judge_points ?? null));
  if (reference) for (const part of referenceParts(reference)) row(part.label, part.node);
  if (text) row("Assessment", fullText(text, "tx-assessment"));
  return rows;
}

/** Response `i` of a model's file (`file`, null if it couldn't be loaded)
 *  and its judgment, into `box`: the model's message, on the right (its
 *  reasoning folded over it; how it ended, if not by itself, under it),
 *  then the judge's grade (if `graded`), the reference (if any) and the
 *  assessment. `model`: {title, color, maxTokens}. */
function fillResponse(box, file, i, model, { graded = false, reference = null } = {}) {
  const r = file?.examples?.[i];
  if (!r) {
    box.replaceChildren(el("p", "tx-note", "This response could not be loaded."));
    return;
  }
  const msg = el("div", "tx-me");
  if (r.thinking) {
    const fold = el("details", "tx-reasoning");
    fold.append(el("summary", "tx-reasoning-sum", "Reasoning"), bubble("tx-thought", fullText(r.thinking), false));
    msg.append(fold);
  }
  const answer = r.judge_auto === "no_answer" ? null : r.answer ?? "";
  if (answer?.trim()) msg.append(bubble("tx-said", fullText(answer, "tx-answer")));
  else if (answer != null) msg.append(el("p", "tx-note", "An empty response."));
  for (const note of endings(r, model.maxTokens)) msg.append(el("p", "tx-note", note));

  const judge = judgePart(r, { graded, reference });
  box.replaceChildren(msg, ...(judge ? [judge] : []));
}

/** A response's box, filled when its model's file is in. */
function responseBox(x, id, i, model, opts) {
  const box = el("div", "tx-response");
  box.append(el("p", "tx-note", "Loading the response…"));
  x.load(id).then((file) => fillResponse(box, file, i, model, opts));
  return box;
}

/** Every other model's grade of its response to example `i`, its name a
 *  link that unfolds the response and its assessment (`open`: the models
 *  unfolded, kept from example to example). */
function othersPart(x, i, open) {
  const sec = el("div", "tx-others");
  sec.append(el("h4", "tv-h", "Responses from other models"));
  for (const o of x.others) {
    const p = o.points[i];
    const item = setModelColors(el("details", "tx-other"), o.color);
    const sum = el("summary", "tx-other-sum");
    const dot = el("span", "tx-dot");
    dot.style.backgroundColor = o.color;
    const name = el("span", "tx-other-name");
    name.append(dot, el("span", "tx-other-title link-text", o.name));
    sum.append(name, gradePips(p), el("span", "tx-other-grade", p == null ? "–" : String(p)));
    sum.title = p == null ? o.name : `${o.name}: ${p} of 5`;
    const body = el("div", "tx-other-body");
    item.append(sum, body);
    const fill = () => {
      if (body.childElementCount) return;
      body.append(responseBox(x, o.id, i, { title: o.name, color: o.color, maxTokens: o.maxTokens }));
    };
    if (open.has(o.id)) { item.open = true; fill(); }
    item.addEventListener("toggle", () => {
      if (item.open) { open.add(o.id); fill(); } else open.delete(o.id);
    });
    sec.append(item);
  }
  return sec;
}

// ── Picking an example ──
// A picker like the page's dropdowns shows the example: its grade (a tile
// in the grade's shade), its number and its prompt in a line. It opens a
// list of every example (the same for every model); ‹ › beside it step
// through them, and so do ← → Home End on it.

const gradeText = (p) => (p == null ? "no grade" : `${p} of 5`);

/** A grade's tile, in its shade. */
function gradeTile(points) {
  const t = el("span", "tx-tile");
  t.dataset.points = points ?? "";
  return t;
}

/** Each example's prompt in a line: its question if it has one (a
 *  quoted question first: "… besvar følgende spørsmål: "Hvor …?""), else
 *  its first line that few of the task's prompts share (not a prompt
 *  template's instruction or "Svar:"), without a label or instruction that
 *  starts others too ("Spørsmål: ", "Tittel: "). */
function promptLines(list) {
  const lines = list.map((e) => (e.prompt || "").split("\n").map((s) => s.trim()).filter(Boolean));
  const count = new Map();
  for (const ls of lines) for (const s of new Set(ls)) count.set(s, (count.get(s) || 0) + 1);
  const own = (s) => count.get(s) < 3 && s.length > 3;
  const quoted = (s) => /["«“]([^"»”]{3,}\?)["»”]/.exec(s)?.[1];
  const asks = (s) => /\?["»”')\]]*$/.test(s);
  const firsts = lines.map((ls) => ls.find((s) => own(s) && quoted(s)) || ls.find((s) => own(s) && asks(s)) || ls.find(own) || ls[0] || "");
  const label = (s) => /^([^:]{1,60}):\s+\S/.exec(s)?.[1];
  const labels = new Map();
  for (const s of firsts) { const l = label(s); if (l) labels.set(l, (labels.get(l) || 0) + 1); }
  return firsts.map((s) => {
    const q = quoted(s);
    if (q) return q;
    const l = label(s);
    return l && labels.get(l) >= 2 ? s.slice(l.length + 1).trim() : s;
  });
}

/** The picker of the examples `x.list` (`ctx`: go(i, {focus}), at() the
 *  example shown, n): { el (which stays at the view's top), update(i,
 *  focus), focus() }. */
function examplePicker(x, ctx) {
  const nav = el("div", "tx-nav");
  const lines = promptLines(x.list);
  const pick = el("button", "tx-pick");
  pick.type = "button";
  pick.setAttribute("aria-haspopup", "listbox");
  pick.setAttribute("aria-expanded", "false");
  pick.setAttribute("aria-controls", "tx-list");
  const step = (cls, label, by) => {
    const b = el("button", "tx-step " + cls);
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.addEventListener("click", () => ctx.go(ctx.at() + by));
    return b;
  };
  const prev = step("tx-prev", "Previous example", -1);
  const next = step("tx-next", "Next example", 1);
  const steps = el("span", "tx-steps");
  steps.append(prev, next);
  const list = el("div", "tx-list");
  list.id = "tx-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Examples");
  list.hidden = true;
  const rows = x.list.map((e, i) => {
    const r = el("div", "tx-list-row");
    r.id = "tx-option-" + i;
    r.setAttribute("role", "option");
    r.title = `Example ${i + 1}: ${gradeText(e.points)}`;
    r.append(gradeTile(e.points), el("span", "tx-list-n", String(i + 1)), el("span", "tx-list-text", lines[i]));
    r.addEventListener("click", () => { close(); ctx.go(i); pick.focus(); });
    r.addEventListener("pointermove", () => { if (active !== i) setActive(i); });
    list.append(r);
    return r;
  });
  let active = -1;   // the row the keys are on, while the list is open
  const setActive = (j) => {
    active = Math.max(0, Math.min(ctx.n - 1, j));
    rows.forEach((r, k) => r.classList.toggle("active", k === active));
    const r = rows[active];
    if (r.offsetTop < list.scrollTop) list.scrollTop = r.offsetTop;
    else if (r.offsetTop + r.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = r.offsetTop + r.offsetHeight - list.clientHeight;
    pick.setAttribute("aria-activedescendant", r.id);
  };
  const outside = (e) => { if (!nav.contains(e.target)) close(); };
  function open() {
    list.hidden = false;
    pick.setAttribute("aria-expanded", "true");
    const r = rows[ctx.at()];
    list.scrollTop = r.offsetTop - (list.clientHeight - r.offsetHeight) / 2;
    setActive(ctx.at());
    document.addEventListener("pointerdown", outside, true);
  }
  function close() {
    list.hidden = true;
    pick.setAttribute("aria-expanded", "false");
    pick.removeAttribute("aria-activedescendant");
    document.removeEventListener("pointerdown", outside, true);
  }
  pick.addEventListener("click", () => (list.hidden ? open() : close()));
  pick.addEventListener("keydown", (e) => {
    if (list.hidden) {
      // Closed: ↓ ↑ open the list; ← → Home End step through the examples.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); return; }
      const to = { ArrowLeft: ctx.at() - 1, ArrowRight: ctx.at() + 1, Home: 0, End: ctx.n - 1 }[e.key];
      if (to !== undefined) { e.preventDefault(); ctx.go(to, { focus: true }); }
      return;
    }
    // Open: ↓ ↑ Home End move along it, Enter picks, Esc closes it (only).
    const to = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: ctx.n - 1 }[e.key];
    if (to !== undefined) { e.preventDefault(); setActive(to); }
    else if (e.key === "Enter") { e.preventDefault(); close(); ctx.go(active); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Tab") close();
  });
  nav.append(pick, steps, list);
  return {
    el: nav,
    focus: () => pick.focus(),
    update(i, focus) {
      if (!list.hidden) close();
      const e = x.list[i];
      pick.replaceChildren(gradeTile(e.points), el("span", "tx-pick-n", `${i + 1} of ${ctx.n}`), el("span", "tx-pick-text", lines[i]));
      pick.title = `Example ${i + 1}: ${gradeText(e.points)}`;
      rows.forEach((r, k) => r.setAttribute("aria-selected", String(k === i)));
      // (A step disabled under the keyboard's focus hands it to the picker.)
      const had = document.activeElement;
      prev.disabled = i === 0;
      next.disabled = i === ctx.n - 1;
      if (focus || (had === prev && prev.disabled) || (had === next && next.disabled)) pick.focus();
    },
  };
}

/** The examples' state that outlives a rebuild of the view for the same
 *  task: the other models unfolded. Then build(d): the section. */
export function createExamples() {
  let task = null;
  let open = new Set();

  return {
    build(d) {
      const x = d.examples;
      if (task !== d.task) { task = d.task; open = new Set(); }
      open.delete(d.model.id);
      const sec = el("section", "tv-section tx-examples");
      sec.append(el("h3", "tv-h", "Examples"));

      let current = -1;
      const picker = examplePicker(x, { go: (i, o) => go(i, o), at: () => current, n: x.list.length });
      const holder = el("div", "tx-example");
      sec.append(picker.el, holder);

      function go(i, { focus = false } = {}) {
        i = Math.max(0, Math.min(x.list.length - 1, i));
        if (i === current) { if (focus) picker.focus(); return; }
        current = i;
        x.pick(i);
        picker.update(i, focus);
        const e = x.list[i];
        const chat = el("article", "tx-chat");
        chat.setAttribute("aria-label", `Example ${i + 1} of ${x.list.length}`);
        const prompt = el("div", "tx-them");
        prompt.append(bubble("tx-asked", el("div", "tx-text", e.prompt)));
        chat.append(prompt, responseBox(x, d.model.id, i, d.model, { graded: true, reference: e.reference }));
        const parts = [chat];
        if (x.others.length) parts.push(othersPart(x, i, open));
        // Read from part-way down, the next example shows from its start,
        // under the picker (which stays at the view's top: style.css).
        const sheet = holder.closest(".tv-sheet");
        const below = picker.el.getBoundingClientRect().bottom;
        const into = !!sheet && holder.getBoundingClientRect().top < below - 1;
        holder.replaceChildren(...parts);
        if (into) sheet.scrollTop += holder.getBoundingClientRect().top - below;
      }
      go(x.index());
      return sec;
    },
  };
}
