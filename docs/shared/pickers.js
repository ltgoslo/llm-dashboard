// The Tasks and Models sections under the chart of the comparison pages
// (noreval, noreval-gen): their collapsible headers, the task picker, and
// the info card that shows a task's or a model's details. The model picker
// itself lives in comparison.js, next to the model state it edits.
//
// The progress pages keep the task-checkbox grid of ui.js.

import { state } from "./state.js";
import { METRIC_DISPLAY, capitalize } from "./core.js";
import { defaultTaskDisplayName } from "./ui.js";

// Phones: narrow screens, and touch screens too short for the desktop
// layout (a phone held sideways). They get the phone layout — horizontal
// bars, folded settings and sections (comparison.js); style.css has the
// same query.
export const PHONE_SCREEN = "(max-width: 640px), (max-height: 500px) and (pointer: coarse)";

// ─────────────────────────────────────────────────────────────
// Collapsible sections
// ─────────────────────────────────────────────────────────────

/** Make each .picker-module's header button fold its section away. The
 *  sections start open, except on a phone, where they would push the page
 *  far below the chart. */
export function initModuleToggles() {
  const narrow = window.matchMedia(PHONE_SCREEN).matches;
  for (const module of document.querySelectorAll(".picker-module")) {
    const button = module.querySelector(".module-toggle");
    if (!button) continue;
    const setOpen = (open) => {
      module.classList.toggle("collapsed", !open);
      button.setAttribute("aria-expanded", String(open));
    };
    setOpen(!narrow);
    button.addEventListener("click", () => setOpen(module.classList.contains("collapsed")));
  }
}

/** Checked / indeterminate state of a group checkbox from how many of its
 *  `n` items are on. */
export function setGroupCheckbox(cb, on, n) {
  if (!cb) return;
  cb.checked = n > 0 && on === n;
  cb.indeterminate = on > 0 && on < n;
}

// ─────────────────────────────────────────────────────────────
// Back to the chart (phones)
// ─────────────────────────────────────────────────────────────
// The sections sit below the chart: on a phone, a change made there
// happens out of the chart's sight. A floating button then offers the way
// back up, until the chart is in view again.

/** Show a "Show chart" button after a change in the sections while the
 *  chart is off screen, on a phone; it scrolls to the chart's title. */
export function initChartJump() {
  const chart = document.getElementById("chart");
  const sections = document.querySelector(".modules-section");
  const target = document.querySelector(".chart-section") || chart;
  if (!chart || !sections || !("IntersectionObserver" in window)) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chart-jump";
  button.textContent = "Show chart";
  button.hidden = true;
  document.body.append(button);
  let chartInView = true;
  new IntersectionObserver(([entry]) => {
    chartInView = entry.isIntersecting;
    if (chartInView) button.hidden = true;
  }, { threshold: 0.15 }).observe(chart);
  // The controls that change what the chart shows (not the folding, the
  // search or "Show more").
  const CHANGES = ".model-chip, .variant-pill, input[type=checkbox], .small-btn";
  sections.addEventListener("click", (e) => {
    if (!window.matchMedia(PHONE_SCREEN).matches || !e.target.closest(CHANGES)) return;
    requestAnimationFrame(() => { if (!chartInView) button.hidden = false; });
  });
  button.addEventListener("click", () => {
    button.hidden = true;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// ─────────────────────────────────────────────────────────────
// Info card
// ─────────────────────────────────────────────────────────────
// A card with a task's or model's details next to its row or chip: opened
// by hovering it with a mouse (and kept open while the pointer is on the
// card, so its link can be clicked), by a long press on a touch screen,
// which then doesn't toggle the item, or by moving the keyboard focus onto
// it. A tap elsewhere, Escape, scrolling or resizing closes it.

const OPEN_DELAY_MS = 450;   // hover before the card opens
const CLOSE_DELAY_MS = 250;  // grace period to move the pointer onto the card
const LONG_PRESS_MS = 500;

let card = null;
let cardAnchor = null;
let openTimer = null;
let closeTimer = null;
let lastClosed = 0;
let suppressClick = false;

function ensureCard() {
  if (card) return card;
  card = document.createElement("div");
  card.className = "info-card";
  card.id = "info-card";
  card.setAttribute("role", "tooltip");
  card.hidden = true;
  card.addEventListener("pointerenter", () => clearTimeout(closeTimer));
  card.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") scheduleClose(); });
  document.body.append(card);
  document.addEventListener("pointerdown", (e) => {
    if (card.hidden || card.contains(e.target) || cardAnchor?.contains(e.target)) return;
    hideInfoCard();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideInfoCard(); });
  window.addEventListener("scroll", () => hideInfoCard(), { passive: true });
  window.addEventListener("resize", () => hideInfoCard());
  return card;
}

/** Fill the card from {title, meta, body, note, link: {href, text}}. */
function fillCard({ title, meta, body, note, link }) {
  const part = (cls, text) => {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    return el;
  };
  const parts = [];
  if (title) parts.push(part("info-card-title", title));
  if (meta) parts.push(part("info-card-meta", meta));
  if (body) parts.push(part("info-card-body", body));
  if (note) parts.push(part("info-card-note", note));
  if (link?.href) {
    const a = document.createElement("a");
    a.className = "info-card-link";
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const text = document.createElement("span");
    text.className = "link-text";   // (style.css underlines it on hover)
    text.textContent = link.text || link.href;
    a.append(text);
    parts.push(a);
  }
  card.replaceChildren(...parts);
}

function showInfoCard(anchor, contentFn) {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  const content = contentFn();
  if (!content) return;
  ensureCard();
  fillCard(content);
  describedControl(cardAnchor)?.removeAttribute("aria-describedby");
  cardAnchor = anchor;
  describedControl(anchor)?.setAttribute("aria-describedby", card.id);
  card.hidden = false;
  // Under the anchor, or above it when there is no room below; inside the
  // viewport either way.
  const pad = 8, gap = 6;
  const a = anchor.getBoundingClientRect();
  card.style.left = "0px";
  card.style.top = "0px";
  const c = card.getBoundingClientRect();
  let top = a.bottom + gap;
  if (top + c.height > window.innerHeight - pad && a.top - gap - c.height >= pad) top = a.top - gap - c.height;
  const left = Math.max(pad, Math.min(a.left, window.innerWidth - c.width - pad));
  card.style.left = left + "px";
  card.style.top = Math.max(pad, top) + "px";
}

export function hideInfoCard() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  if (card && !card.hidden) {
    card.hidden = true;
    lastClosed = Date.now();
  }
  describedControl(cardAnchor)?.removeAttribute("aria-describedby");
  cardAnchor = null;
}

/** The control a card describes: the anchor itself (a chip, a pill), or
 *  the checkbox in it (a task row's label). */
function describedControl(anchor) {
  return anchor && (anchor.matches("button, input") ? anchor : anchor.querySelector("input, button"));
}

function scheduleClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(hideInfoCard, CLOSE_DELAY_MS);
}

/** Show `contentFn()` ({title, meta, body, note, link}, or null for no
 *  card) in the info card for `el`. Moving from one item to the next while
 *  a card is open switches cards without the opening delay. */
export function attachInfoCard(el, contentFn) {
  el.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    const warm = (card && !card.hidden) || Date.now() - lastClosed < 300;
    openTimer = setTimeout(() => showInfoCard(el, contentFn), warm ? 0 : OPEN_DELAY_MS);
  });
  el.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(openTimer);
    if (cardAnchor === el) scheduleClose();
  });

  // Long press on a touch screen.
  let pressTimer = null, touchPress = false, x0 = 0, y0 = 0;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  el.addEventListener("pointerdown", (e) => {
    touchPress = e.pointerType !== "mouse";
    // A long press may end without a click (iOS): don't let its flag eat
    // the next tap.
    suppressClick = false;
    cancelPress();
    if (!touchPress) return;
    x0 = e.clientX; y0 = e.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressClick = true;
      showInfoCard(el, contentFn);
    }, LONG_PRESS_MS);
  });
  el.addEventListener("pointermove", (e) => {
    if (pressTimer && Math.hypot(e.clientX - x0, e.clientY - y0) > 8) cancelPress();
  });
  el.addEventListener("pointerup", cancelPress);
  el.addEventListener("pointercancel", cancelPress);
  // The click that ends a long press only opened the card.
  el.addEventListener("click", (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  // No context menu (or text selection) for a long press.
  el.addEventListener("contextmenu", (e) => { if (touchPress) e.preventDefault(); });

  // Keyboard focus (not the focus a click gives).
  el.addEventListener("focusin", (e) => {
    if (!e.target.matches(":focus-visible")) return;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => showInfoCard(el, contentFn), OPEN_DELAY_MS);
  });
  el.addEventListener("focusout", () => {
    clearTimeout(openTimer);
    if (cardAnchor === el) hideInfoCard();
  });
}

/** "hf.co/…" for a Hugging Face URL, else the URL itself. */
export function shortUrl(url) {
  return url.replace(/^https:\/\/huggingface\.co\//, "hf.co/");
}

// ─────────────────────────────────────────────────────────────
// Task picker
// ─────────────────────────────────────────────────────────────
// The tasks grouped by category, one row per dataset. A dataset evaluated
// in Bokmål and Nynorsk, or in both directions of a translation pair, is
// one row with a toggle per variant ("Bokmål" / "Nynorsk", "→ Nynorsk" /
// "→ Bokmål"); the row's checkbox toggles all of them. Rows are sorted by
// name, as in the task dropdown.

const LANGUAGE_ORDER = ["Bokmål", "Nynorsk", "Sámi", "English"];
const LANGUAGE_SUFFIX = { nob: "Bokmål", nno: "Nynorsk", sme: "Sámi" };

function languageRank(language) {
  const i = LANGUAGE_ORDER.indexOf(language);
  return i < 0 ? LANGUAGE_ORDER.length : i;
}

/** A task name of the form "translation (Bokmål → Nynorsk)" (or just
 *  "Bokmål → Nynorsk"): {prefix, from, to}, else null. */
function parseDirection(name) {
  const m = name.match(/^(.*?)\s*\(([^()]+?)\s*→\s*([^()]+?)\)\s*$/)
    || name.match(/^()([^()]+?)\s*→\s*([^()]+?)$/);
  return m ? { prefix: m[1], from: m[2].trim(), to: m[3].trim() } : null;
}

/** "translation (Bokmål → Nynorsk)" under the Translation category reads
 *  "Bokmål → Nynorsk": the category already says what it is. */
function withoutCategory(name, category) {
  const prefix = (category || "").toLowerCase() + " (";
  return name.toLowerCase().startsWith(prefix) && name.endsWith(")")
    ? name.slice(prefix.length, -1)
    : name;
}

/** One category's tasks as rows: {label, title, variants: [{bench, label}]}
 *  — a single-task row has one variant with no label. */
function categoryRows(category, benches) {
  const ms = state.metricsSetup;
  const groups = new Map();
  for (const bench of benches) {
    const name = ms[bench].pretty_name || bench;
    const dir = parseDirection(name);
    const lang = bench.match(/_(nob|nno|sme)$/);
    let key, variant;
    if (dir) {
      const pair = [dir.from, dir.to].sort((a, b) => languageRank(a) - languageRank(b) || a.localeCompare(b));
      key = "dir\u0000" + dir.prefix + "\u0000" + pair.join("\u0000");
      variant = { bench, label: dir.to, toward: true, rank: pair.indexOf(dir.from), dir, pair };
    } else if (lang) {
      key = "lang\u0000" + name;
      variant = { bench, label: LANGUAGE_SUFFIX[lang[1]], rank: languageRank(LANGUAGE_SUFFIX[lang[1]]) };
    } else {
      key = "task\u0000" + bench;
      variant = { bench, label: "", rank: 0 };
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(variant);
  }

  const rows = [];
  for (const variants of groups.values()) {
    variants.sort((a, b) => a.rank - b.rank);
    if (variants.length === 1) {
      const name = defaultTaskDisplayName(variants[0].bench);
      rows.push({ label: withoutCategory(name, category), title: capitalize(name), variants: [{ bench: variants[0].bench, label: "" }] });
      continue;
    }
    const first = variants[0];
    let name;
    if (first.dir) {
      const pair = first.pair.join(" ↔ ");
      name = first.dir.prefix ? `${first.dir.prefix} (${pair})` : pair;
    } else {
      name = ms[first.bench].pretty_name || first.bench;
    }
    rows.push({
      label: withoutCategory(name, category),
      title: capitalize(name),
      variants: variants.map(({ bench, label, toward }) => ({ bench, label, toward: !!toward })),
    });
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** A drawn arrow in the text's colour — the page font's arrow glyphs are
 *  hairlines at these sizes: "to" points right (→), "both" both ways (↔). */
function arrowIcon(kind) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "task-arrow task-arrow-" + kind);
  svg.setAttribute("viewBox", kind === "both" ? "0 0 18 10" : "0 0 14 10");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", kind === "both"
    ? "M2 5h14M5.5 1.5 2 5l3.5 3.5M12.5 1.5 16 5l-3.5 3.5"
    : "M1.5 5h10M8 1.5 11.5 5 8 8.5");
  svg.append(path);
  return svg;
}

/** A task name with its arrows ("Bokmål ↔ English", "Bokmål → Sámi")
 *  drawn; the text keeps them for screen readers (hidden on screen). */
function withArrows(text) {
  const out = document.createDocumentFragment();
  text.split(/ (↔|→) /).forEach((part, i) => {
    if (i % 2 === 0) { out.append(part); return; }
    const glyph = document.createElement("span");
    glyph.className = "visually-hidden";
    glyph.textContent = " " + part + " ";
    out.append(arrowIcon(part === "↔" ? "both" : "to"), glyph);
  });
  return out;
}

/** Info-card content of a task (or of a dataset row, from its first task —
 *  the variants of a dataset share their description). */
function taskCard(bench, title) {
  const info = state.metricsSetup[bench];
  if (!info) return null;
  const metric = info.main_metric ? (METRIC_DISPLAY[info.main_metric] || info.main_metric) : "";
  const kind = info.evaluation_type ? capitalize(info.evaluation_type) + " task" : "";
  return {
    title: title || capitalize(defaultTaskDisplayName(bench)),
    meta: [kind, metric && "main metric: " + metric].filter(Boolean).join("  ·  "),
    body: info.description || "",
    link: info.url ? { href: info.url, text: shortUrl(info.url) } : null,
  };
}

let taskPickerChange = null;

/** Build the task picker into #task-picker. `onChange` runs after the user
 *  changes state.checkedTasks through it. */
export function buildTaskPicker({ onChange }) {
  const root = document.getElementById("task-picker");
  if (!root) return;
  taskPickerChange = onChange;
  root.replaceChildren();
  const ms = state.metricsSetup;

  const byCategory = new Map();
  for (const [bench, info] of Object.entries(ms)) {
    if (!byCategory.has(info.category)) byCategory.set(info.category, []);
    byCategory.get(info.category).push(bench);
  }

  for (const category of [...byCategory.keys()].sort()) {
    const benches = byCategory.get(category);
    const section = document.createElement("section");
    section.className = "task-cat";
    section.dataset.benches = benches.join(" ");

    const header = document.createElement("label");
    header.className = "task-cat-header";
    const catBox = document.createElement("input");
    catBox.type = "checkbox";
    const catName = document.createElement("span");
    catName.textContent = capitalize(category);
    header.append(catBox, catName);
    section.append(header);

    for (const row of categoryRows(category, benches)) {
      const rowEl = document.createElement("div");
      rowEl.className = "task-row";
      rowEl.dataset.benches = row.variants.map((v) => v.bench).join(" ");

      const main = document.createElement("label");
      main.className = "task-row-main";
      const box = document.createElement("input");
      box.type = "checkbox";
      const name = document.createElement("span");
      name.className = "task-row-name";
      name.append(withArrows(row.label));
      main.append(box, name);
      attachInfoCard(main, () => taskCard(row.variants[0].bench, row.title));
      rowEl.append(main);

      if (row.variants.length > 1) {
        const pills = document.createElement("span");
        pills.className = "task-variants";
        for (const v of row.variants) {
          const pill = document.createElement("button");
          pill.type = "button";
          pill.className = "variant-pill";
          pill.dataset.bench = v.bench;
          if (v.toward) {
            // "→ Nynorsk": the translation into Nynorsk.
            pill.append(arrowIcon("to"), v.label);
            pill.setAttribute("aria-label", "to " + v.label);
          } else {
            pill.textContent = v.label;
          }
          attachInfoCard(pill, () => taskCard(v.bench));
          pills.append(pill);
        }
        rowEl.append(pills);
      }
      section.append(rowEl);
    }
    root.append(section);
  }

  // One listener per kind of control: a pill toggles its task; a row's or a
  // category's checkbox sets all of its tasks.
  root.addEventListener("click", (e) => {
    const pill = e.target.closest(".variant-pill");
    if (!pill) return;
    const bench = pill.dataset.bench;
    if (state.checkedTasks.has(bench)) state.checkedTasks.delete(bench);
    else state.checkedTasks.add(bench);
    changed();
  });
  root.addEventListener("change", (e) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement)) return;
    const holder = box.closest(".task-row") || box.closest(".task-cat");
    if (!holder) return;
    for (const bench of holder.dataset.benches.split(" ")) {
      if (box.checked) state.checkedTasks.add(bench);
      else state.checkedTasks.delete(bench);
    }
    changed();
  });
  syncTaskPicker();
}

function changed() {
  syncTaskPicker();
  taskPickerChange?.();
}

/** Show state.checkedTasks in the task picker and its section header. */
export function syncTaskPicker() {
  const root = document.getElementById("task-picker");
  if (!root) return;
  const on = (benches) => benches.filter((b) => state.checkedTasks.has(b)).length;
  for (const holder of root.querySelectorAll(".task-row, .task-cat")) {
    const benches = holder.dataset.benches.split(" ");
    const box = holder.querySelector(holder.classList.contains("task-row") ? ".task-row-main input" : ".task-cat-header input");
    setGroupCheckbox(box, on(benches), benches.length);
  }
  for (const pill of root.querySelectorAll(".variant-pill")) {
    pill.setAttribute("aria-pressed", String(state.checkedTasks.has(pill.dataset.bench)));
  }
  const summary = document.getElementById("task-summary");
  if (summary) {
    const total = Object.keys(state.metricsSetup).length;
    const n = on(Object.keys(state.metricsSetup));
    summary.textContent = `${n} of ${total} selected`;
  }
}
