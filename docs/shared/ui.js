// Shared UI helpers — tooltip + task-checkbox grid + metric selector, and
// the bootstrap of the custom dropdowns (see the end of the file).

import { state } from "./state.js";
import {
  METRIC_DISPLAY, METRIC_SCALES, getBaseMetric, llNormBase, hasLLNormVariants, taskBaseMetric,
  isAggregateSelection, getEffectiveMetric, taskTypeMatches, CLASSIFICATION_METRICS,
} from "./core.js";
import { enhanceSelects } from "./dropdown.js";
import { enhanceSegmentedControls } from "./segmented.js";

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

/** Style an element as a help anchor (dotted underline, help cursor — the
 *  .tooltip-anchor class in style.css) and attach a hover tooltip to it. */
export function attachHelpTooltip(element, contentFn) {
  element.classList.add("tooltip-anchor");
  attachTooltip(element, contentFn);
}

/** Update the chart title and the inline description below it (shown when
 *  the user expands the <details> wrapping the title). `desc` is
 *  {body, footer}; a non-empty footer renders as a link on its own line. */
export function setChartHeader(titleText, desc) {
  const titleEl = document.getElementById("chart-title");
  if (titleEl) titleEl.textContent = titleText;
  const descEl = document.getElementById("chart-description");
  if (!descEl) return;
  const { body, footer } = desc;
  descEl.innerHTML = "";
  if (body) descEl.appendChild(document.createTextNode(body));
  if (footer) {
    if (body) descEl.appendChild(document.createElement("br"));
    const a = document.createElement("a");
    a.href = footer.startsWith("hf.co/") ? "https://" + footer : footer;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = footer;
    descEl.appendChild(a);
  }
}

// ─────────────────────────────────────────────────────────────
// Control-bar tooltips
// ─────────────────────────────────────────────────────────────

// Tooltip text shown when the user hovers each control-bar setting.
// `anchor` is a selector for any element inside the control's wrapper;
// the tooltip is attached to the nearest enclosing .control-group so
// hovering the label OR the input both trigger it.
const CONTROL_TOOLTIPS = [
  {
    anchor: ".shot-toggle",
    title: "Shots",
    body: "Number of in-context examples shown to the model before each test question. 0-shot gives no examples; 1-shot gives one; 5-shot gives five. Comparing across shot settings probes the model's in-context learning ability.",
  },
  {
    anchor: "#prompt-agg-select",
    title: "Prompt aggregation",
    body: "Most tasks are evaluated with 4–6 different prompt formulations. This setting selects how scores across prompt variants are summarised: max (best prompt), mean (average), median (typical), or min (worst prompt).",
  },
  {
    anchor: "#norm-select",
    title: "Rescaling",
    body: "How task scores are rescaled before averaging. 'Random baseline' maps the chance score to 0 and a perfect score to 100; 'min-max' and 'percentile' rescale relative to the evaluated models; 'z-score' shows standard deviations from the mean. 'None' keeps raw metric values.",
  },
  {
    anchor: "#formulation-select",
    title: "Formulation",
    body: "Multiple-choice tasks are prompted in a cloze (CF), a multiple-choice (MCF) and a hybrid formulation, each with its own prompt templates. Pick one formulation, or aggregate across them: 'all (mean)' averages the per-formulation scores, 'all (max)' takes the best formulation.",
  },
  {
    anchor: "#acc-norm-select",
    title: "Loglikelihood normalization",
    body: "How the answer log-likelihoods of a multiple-choice task are normalized before ranking the choices: not at all, by character length, or by the unconditional answer likelihood (PMI). 'Max' takes, per task and checkpoint, whichever scores highest. Independent of the metric shown.",
  },
  {
    anchor: "#decoding-select",
    title: "Decoding",
    body: "Generative tasks were run with greedy decoding and, in NorEval 1.2, with random sampling (temperature 1) scored over several sampled generations per item. Pick which run to show; a task that only has one keeps it.",
  },
  {
    anchor: "#task-type-select",
    title: "Task type",
    body: "Restrict the aggregate to classification tasks (answers ranked by log-likelihood) or to generative tasks (free-form generation scored against references). Excluded tasks stay checked below but are greyed out.",
  },
  {
    anchor: "#classification-metric-select",
    title: "Classification metric",
    body: "Which score the classification tasks contribute to the aggregate. 'Accuracy': whether the top-ranked choice is the correct one (also for tasks whose main metric is macro-F1). 'Answer probability': the probability the model assigns to the correct answer text, not normalized over the choices — it has no chance level, so the random-baseline rescaling leaves it unchanged. 'Conditional answer probability': the probability mass on the correct answer after normalizing the answer likelihoods over the choices (soft accuracy). Tasks without the chosen metric contribute their accuracy.",
  },
  {
    anchor: "#size-slider-container",
    title: "Model size",
    body: "Restrict the chart to models whose parameter count (in billions) falls within this range. Models outside the range are excluded from the chart and from any aggregate scores.",
  },
  {
    anchor: "#fully-open-container",
    title: "Fully-open models only",
    body: "Restrict to fully-open models — those whose weights, training data, and training code are all released. Models with only open weights are hidden when this is enabled.",
  },
];

/** Attach hover tooltips to the control-bar settings (Shots, Prompt
 *  aggregation, Rescaling, Model size, Fully-open, …). Skips controls
 *  that don't exist on the current dashboard, so it's safe to call from
 *  any init flow. `overrides` maps an anchor selector to a replacement
 *  {title, body} for dashboards whose control has different options. */
export function attachControlTooltips(overrides = {}) {
  for (const base of CONTROL_TOOLTIPS) {
    const cfg = overrides[base.anchor] ? { ...base, ...overrides[base.anchor] } : base;
    const el = document.querySelector(cfg.anchor);
    if (!el) continue;
    const target = el.classList.contains("control-group")
      ? el
      : el.closest(".control-group") || el;
    attachTooltip(target, () => ({ title: cfg.title, body: cfg.body }));
  }
}

/** Module headers contain action buttons like "Select all" / "Select none".
 *  Stop click propagation inside .module-actions so those clicks never
 *  bubble up to any enclosing summary/header click handlers. */
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
 *  Subtask metrics (containing ": ") are organized into optgroups.
 *  With the log-likelihood-normalization selector spanning every base
 *  metric (state.llNormScope "all"), the `_norm` / `_mutual_info` variants
 *  of a base metric that has all three are left out — that selector picks
 *  among them, orthogonally to the metric chosen here. */
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
  if (metrics && state.llNormScope === "all") {
    metrics = new Set([...metrics].filter((m) => {
      const base = llNormBase(m);
      return m === base || !hasLLNormVariants(metrics, base);
    }));
  }
  if (!metrics || metrics.size <= 1) { hideMetricSelector(); return; }

  const mainMetric = ms[benchmarks[0]]?.main_metric;
  const defaultMetric = taskBaseMetric(benchmarks[0]) || mainMetric;
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
    state.currentMetric = metrics.has(defaultMetric) ? defaultMetric : mainMetric;
    select.value = state.currentMetric;
  }
  control.style.display = "";
}

/** Grey out (and disable) the task items that `excludedFn(bench)` flags —
 *  the task-type selector masks them out of the aggregate while leaving
 *  their checked state alone. */
export function setTaskExcludedStates(excludedFn) {
  document.querySelectorAll("#checkbox-grid input[data-bench]").forEach((cb) => {
    const excluded = !!excludedFn(cb.dataset.bench);
    cb.disabled = excluded;
    cb.closest(".task-item")?.classList.toggle("type-excluded", excluded);
  });
}

// ─────────────────────────────────────────────────────────────
// Variant controls — shared by the dashboards that evaluate NorEval-1.2-
// style data (multisynt, prelude, norprelude): task type / classification
// metric / formulation / loglikelihood normalization. Each page carries the
// same control ids (#task-type-control, #classification-metric-control,
// #formulation-control, #acc-norm-control); see resolvePoint() and
// taskBaseMetric() in core.js for the semantics.
// ─────────────────────────────────────────────────────────────

/** Formulation options in display order; "mean" / "max" aggregate across
 *  the formulations a task has. */
export const FORMULATION_OPTIONS = [
  ["mcf", "MCF"], ["cf", "CF"], ["hybrid", "Hybrid"], ["mean", "all (mean)"], ["max", "all (max)"],
];

/** attachControlTooltips() overrides for the "Prompts" and "Rescaling"
 *  controls of those dashboards (their options differ from the others'). */
export const VARIANT_CONTROL_TOOLTIPS = {
  "#prompt-agg-select": {
    title: "Prompts",
    body: "Every task is evaluated with several prompt templates (five per formulation in NorEval 1.2). 'Single prompt' shows one template drawn at random per task — the same one for every checkpoint and model — mimicking an evaluation with a single prompt. 'All (mean)' averages over the templates; 'all (max)' takes the best one.",
  },
  "#norm-select": {
    title: "Rescaling",
    body: "How task scores are rescaled before averaging. 'Random baseline' maps the chance score to 0 and a perfect score to 100; 'z-score' and 'min-max' rescale each task relative to all plotted checkpoints; 'none' keeps raw metric values.",
  },
};

function setControlVisible(id, visible) {
  const el = document.getElementById(id);
  if (el) el.style.display = visible ? "" : "none";
}

/** Rebuild the formulation options from the formulations the current
 *  tasks actually provide (e.g. Finnish has no "hybrid"). Resets an
 *  unavailable selection to "max". */
export function populateFormulationOptions() {
  const forms = new Set();
  for (const info of Object.values(state.metricsSetup)) {
    for (const f of info.formulations || []) forms.add(f);
  }
  const select = document.getElementById("formulation-select");
  select.innerHTML = "";
  const options = FORMULATION_OPTIONS.filter(([v]) => v === "mean" || v === "max" || forms.has(v));
  for (const [value, label] of options) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }
  if (!options.some(([v]) => v === state.currentFormulation)) state.currentFormulation = "max";
  select.value = state.currentFormulation;
}

/** Show each variant control only where it has an effect: the task-type and
 *  classification-metric selectors in aggregate views (the latter only when
 *  some classification task carries a probability metric besides its
 *  accuracy, i.e. NorEval 1.2 data), the formulation / decoding selectors when the shown
 *  task(s) have formulations / both decoding runs, and the loglikelihood-
 *  normalization selector when the shown metric comes in the three
 *  normalization variants. Call after the chart render, which populates the
 *  single-task metric selector. */
export function updateVariantControlVisibility() {
  const ms = state.metricsSetup;
  const sel = state.currentTaskSelection;
  const aggregate = isAggregateSelection(sel);
  const single = !aggregate && ms[sel] ? sel : null;
  setControlVisible("task-type-control", aggregate);
  setControlVisible("classification-metric-control",
    aggregate && Object.values(ms).some((info) => info.evaluation_type === "classification"
      && CLASSIFICATION_METRICS.some((m) => m !== "acc" && (info.available_metrics || []).includes(m))));
  const hasForms = (b) => (ms[b].formulations || []).length > 0;
  setControlVisible("formulation-control",
    single ? hasForms(single) : Object.keys(ms).some(hasForms));
  const hasDecodings = (b) => (ms[b].decodings || []).length > 1;
  setControlVisible("decoding-control",
    single ? hasDecodings(single) : Object.keys(ms).some(hasDecodings));
  const hasLL = (b, metric) => hasLLNormVariants(ms[b].available_metrics, metric);
  setControlVisible("acc-norm-control",
    single ? hasLL(single, getEffectiveMetric(single))
           : Object.keys(ms).some((b) => hasLL(b, taskBaseMetric(b))));
}

/** Grey out the tasks the task-type selector masks out of the aggregate. */
export function applyTaskTypeMask() {
  const aggregate = isAggregateSelection(state.currentTaskSelection);
  setTaskExcludedStates((bench) => aggregate && !taskTypeMatches(bench));
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

// ─────────────────────────────────────────────────────────────
// Custom controls — every <select> on the page is replaced by the
// dashboards' own dropdown (dropdown.js) so the controls look the same
// on every system, and the segmented button groups get their sliding
// thumb (segmented.js). The native select stays as the state holder and
// the buttons keep their .active class, so the code above keeps driving
// them as before. An option's `title` is shown with the page tooltip.
// Module scripts run once the document is parsed, so the controls exist
// by now; the DOMContentLoaded branch covers an unusual loading order.
// ─────────────────────────────────────────────────────────────

const enhancePageControls = () => {
  enhanceSelects({ tooltip: { attach: attachTooltip, hide: hideTooltip } });
  enhanceSegmentedControls();
};
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", enhancePageControls);
} else {
  enhancePageControls();
}
