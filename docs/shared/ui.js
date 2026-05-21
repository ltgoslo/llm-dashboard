// Shared UI helpers — tooltip + task-checkbox grid + metric selector.

import { state } from "./state.js";
import { METRIC_DISPLAY, METRIC_SCALES, getBaseMetric } from "./core.js";

// ─────────────────────────────────────────────────────────────
// App-ready toggle — flips body.app-ready, which the stylesheet
// uses to fade out the loading overlay and fade in the bands.
// Deferred via rAF so the first chart paint has a chance to land
// before the fade begins (without this, Firefox sometimes fades
// in before the bars are positioned).
// ─────────────────────────────────────────────────────────────

let appReadyMarked = false;
export function markAppReady() {
  if (appReadyMarked) return;
  appReadyMarked = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => document.body.classList.add("app-ready"));
  });
}

// ─────────────────────────────────────────────────────────────
// Custom tooltip
// ─────────────────────────────────────────────────────────────

let tooltipTimeout = null;

export function showTooltip(event, title, body, footer, meta) {
  const tooltip = document.getElementById("custom-tooltip");
  const titleEl = document.getElementById("tooltip-title");
  const metaEl = document.getElementById("tooltip-meta");
  const bodyEl = document.getElementById("tooltip-body");
  const footerEl = document.getElementById("tooltip-footer");
  titleEl.textContent = title || ""; titleEl.style.display = title ? "" : "none";
  metaEl.textContent = meta || ""; metaEl.style.display = meta ? "" : "none";
  bodyEl.textContent = body || ""; bodyEl.style.display = body ? "" : "none";
  footerEl.textContent = footer || ""; footerEl.style.display = footer ? "" : "none";
  positionTooltip(tooltip, event);
  tooltip.classList.add("visible");
}

export function hideTooltip() {
  clearTimeout(tooltipTimeout);
  document.getElementById("custom-tooltip").classList.remove("visible");
}

function positionTooltip(tooltip, event) {
  const pad = 12;
  tooltip.style.left = "0px"; tooltip.style.top = "0px";
  tooltip.classList.add("visible");
  const rect = tooltip.getBoundingClientRect();
  let x = event.clientX + pad, y = event.clientY + pad;
  if (x + rect.width > window.innerWidth - pad) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - pad) y = event.clientY - rect.height - pad;
  tooltip.style.left = x + "px"; tooltip.style.top = y + "px";
}

/** Attach a hover tooltip to a DOM element. `contentFn` returns {title, body, footer, meta}. */
export function attachTooltip(element, contentFn) {
  element.addEventListener("mouseenter", (e) => {
    tooltipTimeout = setTimeout(() => {
      const c = contentFn();
      if (c) showTooltip(e, c.title, c.body, c.footer, c.meta);
    }, 300);
  });
  element.addEventListener("mousemove", (e) => {
    const tooltip = document.getElementById("custom-tooltip");
    if (tooltip.classList.contains("visible")) positionTooltip(tooltip, e);
  });
  element.addEventListener("mouseleave", () => hideTooltip());
}

/** Module sections are wrapped in <details>/<summary>. The summary line
 *  contains action buttons like "Select all" / "Select none". Without
 *  intervention, clicking those buttons would also toggle the <details>
 *  open/closed because the click event bubbles to the summary. This
 *  installs a single document-level listener (capture phase) that stops
 *  propagation of clicks originating inside .module-actions. */
let moduleActionsBound = false;
export function bindModuleActionStopPropagation() {
  if (moduleActionsBound) return;
  moduleActionsBound = true;
  document.querySelectorAll(".module-actions").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  });
}

// (attachTaskTooltip was removed when task items became expandable <details>
//  that show the description inline below the task name instead of on hover.)

// ─────────────────────────────────────────────────────────────
// Task checkboxes
// ─────────────────────────────────────────────────────────────

/** Default display-name function: pretty_name plus a Bokmål/Nynorsk tag if
 *  the pretty_name doesn't already mention the language. */
export function defaultTaskDisplayName(bench) {
  const info = state.metricsSetup[bench];
  if (!info) return bench;
  let name = info.pretty_name || bench;
  const hasDirection = /[→↔]/.test(name) || /Bokmål|Nynorsk|English|Sámi/.test(name);
  if (!hasDirection) {
    if (bench.endsWith("_nno")) name += " [Nynorsk]";
    else if (bench.endsWith("_nob")) name += " [Bokmål]";
  }
  return name;
}

/** Build the task-checkbox grid, grouped by category. Returns nothing — mutates DOM.
 *  - filterSourceFn: () => Set of currently-considered benchmarks (allFilterBenchmarks
 *    in filter mode, otherwise state.checkedTasks).
 *  - onChange: callback fired after a checkbox or group-checkbox is toggled.
 *  - displayName: optional override for the per-bench label text. */
export function buildTaskCheckboxes({ filterSourceFn, onChange, displayName }) {
  const grid = document.getElementById("checkbox-grid");
  grid.innerHTML = "";
  const ms = state.metricsSetup;
  const nameFn = displayName || defaultTaskDisplayName;

  const grouped = {};
  for (const [bench, info] of Object.entries(ms)) {
    const cat = info.category;
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(bench);
  }

  for (const cat of Object.keys(grouped).sort()) {
    const catDiv = document.createElement("div");
    catDiv.className = "checkbox-category";
    const catBenches = grouped[cat];

    const headerDiv = document.createElement("div");
    headerDiv.className = "checkbox-category-header";

    const groupCheckbox = document.createElement("input");
    groupCheckbox.type = "checkbox";
    groupCheckbox.dataset.cat = cat;
    const initSource = filterSourceFn();
    const initAll = catBenches.length > 0 && catBenches.every((b) => initSource.has(b));
    const initSome = catBenches.some((b) => initSource.has(b));
    groupCheckbox.checked = initAll;
    groupCheckbox.indeterminate = !initAll && initSome;
    groupCheckbox.addEventListener("change", () => {
      const source = filterSourceFn();
      for (const b of catBenches) {
        if (groupCheckbox.checked) source.add(b); else source.delete(b);
      }
      syncTaskCheckboxStates(filterSourceFn);
      onChange();
    });
    headerDiv.addEventListener("click", (e) => {
      if (e.target !== groupCheckbox) groupCheckbox.click();
    });

    const h4 = document.createElement("h4");
    h4.textContent = cat ? cat.charAt(0).toUpperCase() + cat.slice(1) : cat;
    headerDiv.appendChild(groupCheckbox);
    headerDiv.appendChild(h4);
    catDiv.appendChild(headerDiv);

    for (const bench of catBenches) {
      // Each task is a <details>; clicking the name expands an inline
      // description below. The checkbox stops click propagation so clicking
      // it doesn't toggle the expansion.
      const item = document.createElement("details");
      item.className = "task-item";

      const summary = document.createElement("summary");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.checkedTasks.has(bench);
      checkbox.dataset.bench = bench;
      checkbox.addEventListener("change", () => {
        const source = filterSourceFn();
        if (checkbox.checked) source.add(bench);
        else source.delete(bench);
        syncTaskCheckboxStates(filterSourceFn);
        onChange();
      });
      checkbox.addEventListener("click", (e) => e.stopPropagation());

      const nameSpan = document.createElement("span");
      nameSpan.className = "task-name";
      nameSpan.textContent = nameFn(bench);

      summary.appendChild(checkbox);
      summary.appendChild(nameSpan);
      item.appendChild(summary);

      // Description body (revealed when the user clicks the task name).
      const info = state.metricsSetup[bench];
      const desc = document.createElement("div");
      desc.className = "task-description-inline";
      if (info?.description) desc.appendChild(document.createTextNode(info.description));
      if (info?.url) {
        if (info.description) desc.appendChild(document.createElement("br"));
        const a = document.createElement("a");
        a.href = info.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = info.url.replace("https://huggingface.co/", "hf.co/");
        desc.appendChild(a);
      }
      item.appendChild(desc);

      catDiv.appendChild(item);
    }
    grid.appendChild(catDiv);
  }
}

// ─────────────────────────────────────────────────────────────
// Metric selector
// ─────────────────────────────────────────────────────────────

/** Populate the metric selector with the metrics available for the given benchmarks.
 *  When multiple benchmarks are passed (e.g. for a group view), only metrics
 *  available across ALL of them are shown.
 *  Subtask metrics (containing ": ") are organized into optgroups. */
export function populateMetricSelector(benchmarks) {
  const select = document.getElementById("metric-select");
  const control = document.getElementById("metric-control");
  if (!select || !control) return;
  const ms = state.metricsSetup;

  // Intersection of available metrics across the benchmarks.
  let metrics = null;
  for (const bench of benchmarks) {
    const info = ms[bench];
    if (!info || !info.available_metrics) continue;
    const s = new Set(info.available_metrics);
    metrics = metrics ? new Set([...metrics].filter((m) => s.has(m))) : s;
  }
  if (!metrics || metrics.size <= 1) { hideMetricSelector(); return; }

  const mainMetric = ms[benchmarks[0]]?.main_metric;
  const hasSubtasks = ms[benchmarks[0]]?.subtasks;

  // Separate base metrics from subtask metrics (e.g. "acc: Person: 1→2").
  const baseMetrics = [];
  const subtaskMetrics = [];
  for (const m of metrics) {
    if (m.indexOf(": ") !== -1 && METRIC_SCALES[m.slice(0, m.indexOf(": "))]) {
      subtaskMetrics.push(m);
    } else {
      baseMetrics.push(m);
    }
  }

  // Order base metrics: main_metric first, then alphabetical.
  const orderedBase = [];
  if (mainMetric && baseMetrics.includes(mainMetric)) orderedBase.push(mainMetric);
  for (const m of baseMetrics.sort()) {
    if (m !== mainMetric) orderedBase.push(m);
  }

  select.innerHTML = "";
  for (const m of orderedBase) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = (METRIC_DISPLAY[m] || m) + (m === mainMetric ? " (default)" : "");
    select.appendChild(opt);
  }

  // Subtask metrics grouped by (base metric × phenomenon category).
  if (subtaskMetrics.length > 0 && hasSubtasks) {
    const byBase = {};
    for (const m of subtaskMetrics) {
      const base = getBaseMetric(m);
      (byBase[base] = byBase[base] || []).push(m);
    }
    for (const base of Object.keys(byBase).sort()) {
      const items = byBase[base].sort();
      const byCategory = {};
      for (const m of items) {
        const afterBase = m.slice(base.length + 2);
        const catSep = afterBase.indexOf(": ");
        const cat = catSep !== -1 ? afterBase.slice(0, catSep) : "Subtasks";
        (byCategory[cat] = byCategory[cat] || []).push(m);
      }
      for (const cat of Object.keys(byCategory).sort()) {
        const group = document.createElement("optgroup");
        const baseLabel = METRIC_DISPLAY[base] || base;
        group.label = baseLabel + " – " + cat;
        for (const m of byCategory[cat]) {
          const opt = document.createElement("option");
          opt.value = m;
          const afterBase = m.slice(base.length + 2);
          const catSep = afterBase.indexOf(": ");
          opt.textContent = catSep !== -1 ? afterBase.slice(catSep + 2) : afterBase;
          group.appendChild(opt);
        }
        select.appendChild(group);
      }
    }
  }

  if (state.currentMetric && metrics.has(state.currentMetric)) {
    select.value = state.currentMetric;
  } else {
    state.currentMetric = mainMetric;
    select.value = mainMetric;
  }
  control.style.display = "";
}

export function hideMetricSelector() {
  const control = document.getElementById("metric-control");
  if (control) control.style.display = "none";
  state.currentMetric = null;
}

/** Sync individual + category checkbox visual state from `filterSourceFn()`. */
export function syncTaskCheckboxStates(filterSourceFn) {
  const source = filterSourceFn();
  document.querySelectorAll("#checkbox-grid input[data-bench]").forEach((cb) => {
    cb.checked = source.has(cb.dataset.bench);
  });
  const ms = state.metricsSetup;
  document.querySelectorAll("#checkbox-grid input[data-cat]").forEach((gcb) => {
    const cat = gcb.dataset.cat;
    const catBenches = Object.entries(ms)
      .filter(([, info]) => info.category === cat)
      .map(([b]) => b);
    const allChecked = catBenches.length > 0 && catBenches.every((b) => source.has(b));
    const someChecked = catBenches.some((b) => source.has(b));
    gcb.checked = allChecked;
    gcb.indeterminate = !allChecked && someChecked;
  });
}
