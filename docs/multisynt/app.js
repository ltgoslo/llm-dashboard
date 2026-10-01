// MultiSynt multilingual training-progress dashboard.
//
// Each language is a separate dataset ({metrics_setup, models}); switching the
// language tab re-binds state.metricsSetup and rebuilds the dropdown/checkbox grid.
//
// Besides the controls shared with the other progress dashboards, multisynt
// has: a task-type mask (classification / generative) and a hard/soft metric
// switch for aggregate views, a "Prompts" selector that folds the prompt
// aggregation together with a single random prompt, a formulation selector
// that also aggregates across formulations, a decoding selector, and a
// log-likelihood normalization selector that is orthogonal to the metric
// shown (see resolvePoint() in core.js; the controls are shared with prelude
// through ui.js). Under the chart title it shows the FineWeb2 signal
// measures of the plotted curves (shared/signals.js).

import { state } from "../shared/state.js";
import {
  MODEL_COLORS, isAggregateSelection, isMacroSelection, capitalize,
} from "../shared/core.js";
import { makePlotlyConfig } from "../shared/chart.js";
import {
  buildTaskCheckboxes, syncTaskCheckboxStates,
  bindModuleActionStopPropagation, attachControlTooltips, markAppReady,
  populateFormulationOptions, updateVariantControlVisibility, applyTaskTypeMask,
  VARIANT_CONTROL_TOOLTIPS,
} from "../shared/ui.js";
import {
  renderProgressChart, updateProgressTitle,
} from "../shared/progress.js";
import { computeSignals, renderSignals } from "../shared/signals.js";
import { UrlState } from "../shared/url-state.js";

const ALL_SHOTS = ["0", "5"];
const DEFAULT_SELECTION = "__all_macro__";
const DEFAULT_LANGUAGE = "Norwegian";   // falls back to the first language in data.json

const plotlyConfig = makePlotlyConfig("multisynt-chart", () => ({
  language: currentLang,
  shot: state.currentShot + "-shot",
  task_selection: state.currentTaskSelection,
  task_type: state.taskTypeFilter,
  metric_type: state.metricMode,
  decoding: state.currentDecoding,
  prompts: state.currentPromptAgg,
  formulation: state.currentFormulation,
  loglikelihood_normalization: state.currentAccNorm,
  normalization: state.currentNormalization,
  ...(state.currentMetric && { metric: state.currentMetric }),
  error_bands: state.showCIBands ? "shown" : "hidden",
  ...(lastSignals && {
    signals: {
      monotonicity: lastSignals.monotonicity,
      ranking_consistency: lastSignals.rankingConsistency,
      non_randomness: lastSignals.nonRandomness,
    },
  }),
}));

let currentLang = null;
let urlState;
let lastSignals = null;

// ─────────────────────────────────────────────────────────────
// Data helpers
// ─────────────────────────────────────────────────────────────

function getLangData() {
  return state.DATA.languages[currentLang];
}

function getModels() {
  return getLangData().models;
}

function getModelTokens(modelDir) {
  const progress = getModels()[modelDir].progress;
  return Object.keys(progress)
    .filter((k) => k !== "main" && !isNaN(Number(k)))
    .map(Number)
    .sort((a, b) => a - b);
}

function getTrajectories() {
  const models = getModels();
  return Object.entries(models).map(([modelDir, modelData]) => ({
    name: modelData.display_name,
    key: modelDir,
    color: modelData.color || MODEL_COLORS[0],
    dataSource: modelData.progress,
    checkpoints: () => getModelTokens(modelDir),
  }));
}

// ─────────────────────────────────────────────────────────────
// Chart config
// ─────────────────────────────────────────────────────────────

const chartConfig = {
  getTrajectories,
  xToTokens: (x) => x,           // multisynt already stores in B-tokens
  xAxisLabel: "tokens (B)",
  allShots: ALL_SHOTS,
  legendPosition: "top-left",
  plotlyConfig,
  hoverXFormat: (x, traceName) => `${traceName || ""} — ${x}B tokens`,
  // Recomputed every render so it tracks language tab changes.
  titlePrefix: () => currentLang.replace(/_/g, " "),
  // The trajectories are different models: z-score / min-max against the
  // checkpoints of all of them, so the curves stay comparable.
  normAcrossTrajectories: true,
  // Always fully zoomed: the y-axis fits the plotted points (and bands) of
  // the displayed shot on every render.
  yRangeFit: true,
  // FineWeb2 signal measures of exactly what is plotted, shown under the title.
  onSeries: (series) => {
    lastSignals = computeSignals(series);
    renderSignals(document.getElementById("chart-signals"), lastSignals);
  },
};

// ─────────────────────────────────────────────────────────────
// Selection helpers
// ─────────────────────────────────────────────────────────────

function getBenchmarksForSelection(sel) {
  const ms = state.metricsSetup;
  if (sel === "__all__" || sel === "__all_macro__") return Object.keys(ms);
  if (sel === "__custom__" || sel === "__custom_macro__") return [];
  if (sel.startsWith("__cat__")) {
    const c = sel.slice(7);
    return Object.keys(ms).filter((b) => ms[b].category === c);
  }
  if (sel.startsWith("__eval__")) {
    const e = sel.slice(8);
    return Object.keys(ms).filter((b) => ms[b].evaluation_type === e);
  }
  if (ms[sel]) return [sel];
  return [];
}

function autoSetNormalization() {
  state.currentNormalization = "baseline";
  document.getElementById("norm-select").value = state.currentNormalization;
}

const checkedTasks = () => state.checkedTasks;

// ─────────────────────────────────────────────────────────────
// Tabs and dropdown
// ─────────────────────────────────────────────────────────────

function buildLangTabs(languages) {
  const nav = document.getElementById("tab-nav");
  nav.innerHTML = "";
  for (const lang of languages) {
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (lang === currentLang ? " active" : "");
    btn.dataset.lang = lang;
    btn.textContent = lang.replace(/_/g, " ");
    nav.appendChild(btn);
  }
}

function populateTaskDropdown() {
  const select = document.getElementById("task-select");
  select.querySelectorAll("optgroup").forEach((g) => g.remove());
  const ms = state.metricsSetup;

  const categories = {};
  for (const [bench, info] of Object.entries(ms)) {
    (categories[info.category] = categories[info.category] || []).push(bench);
  }
  if (Object.keys(categories).length > 1) {
    const catGroup = document.createElement("optgroup");
    catGroup.label = "Aggregate by category";
    for (const catName of Object.keys(categories).sort()) {
      const opt = document.createElement("option");
      opt.value = "__cat__" + catName;
      opt.textContent = capitalize(catName);
      catGroup.appendChild(opt);
    }
    select.appendChild(catGroup);
  }

  const taskGroup = document.createElement("optgroup");
  taskGroup.label = "Individual tasks";
  const entries = Object.entries(ms).map(([bench, info]) => ({ value: bench, label: capitalize(info.pretty_name) }));
  entries.sort((a, b) => a.label.localeCompare(b.label));
  for (const entry of entries) {
    const opt = document.createElement("option");
    opt.value = entry.value;
    opt.textContent = entry.label;
    taskGroup.appendChild(opt);
  }
  select.appendChild(taskGroup);
}

// ─────────────────────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────────────────────

function bindSelect(id, apply) {
  document.getElementById(id).addEventListener("change", (e) => {
    apply(e.target.value);
    render();
  });
}

function bindEventListeners() {
  document.getElementById("tab-nav").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    document.querySelector(".tab-btn.active")?.classList.remove("active");
    btn.classList.add("active");
    setLanguage(btn.dataset.lang);
  });

  document.querySelectorAll(".shot-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelector(".shot-btn.active")?.classList.remove("active");
      btn.classList.add("active");
      state.currentShot = btn.dataset.shot;
      render();
    });
  });
  document.querySelectorAll(".ci-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelector(".ci-btn.active")?.classList.remove("active");
      btn.classList.add("active");
      state.showCIBands = btn.dataset.ci === "1";
      render();
    });
  });

  bindSelect("task-type-select", (v) => state.taskTypeFilter = v);
  bindSelect("metric-mode-select", (v) => state.metricMode = v);
  bindSelect("decoding-select", (v) => state.currentDecoding = v);
  bindSelect("prompt-agg-select", (v) => state.currentPromptAgg = v);
  bindSelect("formulation-select", (v) => state.currentFormulation = v);
  bindSelect("acc-norm-select", (v) => state.currentAccNorm = v);
  bindSelect("norm-select", (v) => state.currentNormalization = v);
  bindSelect("metric-select", (v) => state.currentMetric = v);

  document.getElementById("task-select").addEventListener("change", (e) => {
    state.currentTaskSelection = e.target.value;
    const benchmarks = getBenchmarksForSelection(state.currentTaskSelection);
    if (benchmarks.length > 0) state.checkedTasks = new Set(benchmarks);
    syncTaskCheckboxStates(checkedTasks);
    autoSetNormalization();
    render();
  });

  document.getElementById("select-all-btn").addEventListener("click", () => {
    state.checkedTasks = new Set(Object.keys(state.metricsSetup));
    state.currentTaskSelection = DEFAULT_SELECTION;
    document.getElementById("task-select").value = DEFAULT_SELECTION;
    syncTaskCheckboxStates(checkedTasks);
    autoSetNormalization();
    render();
  });
  document.getElementById("select-none-btn").addEventListener("click", () => {
    state.checkedTasks.clear();
    syncTaskCheckboxStates(checkedTasks);
    render();
  });
}

function onTaskCheckboxChange() {
  if (state.checkedTasks.size === 1) {
    const bench = [...state.checkedTasks][0];
    state.currentTaskSelection = bench;
    if (state.metricsSetup[bench]) document.getElementById("task-select").value = bench;
    autoSetNormalization();
    render();
    return;
  }
  // A hand-picked subset keeps the averaging of the view it was made from:
  // category average stays category average.
  state.currentTaskSelection = isMacroSelection() ? "__custom_macro__" : "__custom__";
  document.getElementById("task-select").value = state.currentTaskSelection;
  autoSetNormalization();
  render();
}

// ─────────────────────────────────────────────────────────────
// Language switching
// ─────────────────────────────────────────────────────────────

function setLanguage(lang) {
  currentLang = lang;
  state.metricsSetup = state.DATA.languages[lang].metrics_setup;

  populateTaskDropdown();
  populateFormulationOptions();
  // Reset selections that don't exist in the new language: unknown individual
  // tasks, and category subsets that match nothing here.
  const sel = state.currentTaskSelection;
  if ((!isAggregateSelection(sel) && !state.metricsSetup[sel])
      || ((sel.startsWith("__cat__") || sel.startsWith("__eval__"))
          && getBenchmarksForSelection(sel).length === 0)) {
    state.currentTaskSelection = DEFAULT_SELECTION;
  }
  document.getElementById("task-select").value = state.currentTaskSelection;
  // Re-derive the checked set from the kept selection (a category subset
  // means different tasks in the new language); fall back to all tasks.
  const kept = getBenchmarksForSelection(state.currentTaskSelection);
  state.checkedTasks = new Set(kept.length ? kept : Object.keys(state.metricsSetup));
  buildTaskCheckboxes({ filterSourceFn: checkedTasks, onChange: onTaskCheckboxChange });
  autoSetNormalization();
  render();
}

// ─────────────────────────────────────────────────────────────
// Render entry point
// ─────────────────────────────────────────────────────────────

function render() {
  updateProgressTitle(chartConfig);
  renderProgressChart(chartConfig);
  // After the chart: the single-task metric selector is populated during
  // the render, and the loglikelihood-normalization control follows it.
  updateVariantControlVisibility();
  applyTaskTypeMask();
  urlState.save();
}

// ─────────────────────────────────────────────────────────────
// URL state
// ─────────────────────────────────────────────────────────────

// Values written by earlier versions of the dashboard, mapped onto the
// current selectors so old links keep working.
const LEGACY_PROMPT_AGG = { median: "max", min: "max", first: "max", stdev: "max" };
const LEGACY_LL_NORM = { acc: "none", acc_norm: "norm", acc_mutual_info: "mutual_info" };

function setupUrlState() {
  urlState = new UrlState([
    { key: "lang", get: () => currentLang, set: (v) => currentLang = v, default: null, noDefault: true },
    { key: "shot", get: () => state.currentShot, set: (v) => state.currentShot = v, default: "5" },
    {
      key: "task",
      get: () => state.currentTaskSelection,
      set: (v) => {
        // The former "aggregate by evaluation type" entries became the
        // task-type selector; the former signal-filtered selection is gone.
        if (v.startsWith("__eval__")) {
          state.taskTypeFilter = v.slice(8);
          state.currentTaskSelection = DEFAULT_SELECTION;
        } else {
          state.currentTaskSelection = v === "__filtered__" ? DEFAULT_SELECTION : v;
        }
      },
      default: DEFAULT_SELECTION,
    },
    { key: "ttype", get: () => state.taskTypeFilter, set: (v) => state.taskTypeFilter = v, default: "all" },
    { key: "mmode", get: () => state.metricMode, set: (v) => state.metricMode = v, default: "hard" },
    { key: "dec", get: () => state.currentDecoding, set: (v) => state.currentDecoding = v, default: "sampling" },
    { key: "pagg", get: () => state.currentPromptAgg, set: (v) => state.currentPromptAgg = LEGACY_PROMPT_AGG[v] || v, default: "max" },
    { key: "form", get: () => state.currentFormulation, set: (v) => state.currentFormulation = v, default: "max" },
    { key: "anorm", get: () => state.currentAccNorm, set: (v) => state.currentAccNorm = LEGACY_LL_NORM[v] || v, default: "max" },
    { key: "ci", get: () => state.showCIBands ? "1" : "0", set: (v) => state.showCIBands = v !== "0", default: "0" },
    { key: "norm", get: () => state.currentNormalization, set: (v) => state.currentNormalization = v === "percentile" ? "baseline" : v, default: "baseline" },
    { key: "metric", get: () => state.currentMetric || "", set: (v) => state.currentMetric = v, default: "" },
  ], { mode: "search" });
}

/** Push every selector's state into its control (after a URL restore).
 *  Unknown values (e.g. a removed option) fall back to the control's
 *  default and are written back to the state. */
function syncControlsFromState() {
  const setSelect = (id, value, fallback) => {
    const select = document.getElementById(id);
    select.value = value;
    if (select.value !== value) select.value = fallback;
    return select.value;
  };
  setSelect("task-select", state.currentTaskSelection, DEFAULT_SELECTION);
  state.taskTypeFilter = setSelect("task-type-select", state.taskTypeFilter, "all");
  state.metricMode = setSelect("metric-mode-select", state.metricMode, "hard");
  state.currentDecoding = setSelect("decoding-select", state.currentDecoding, "sampling");
  state.currentPromptAgg = setSelect("prompt-agg-select", state.currentPromptAgg, "max");
  state.currentFormulation = setSelect("formulation-select", state.currentFormulation, "max");
  state.currentAccNorm = setSelect("acc-norm-select", state.currentAccNorm, "max");
  state.currentNormalization = setSelect("norm-select", state.currentNormalization, "baseline");
  document.querySelectorAll(".shot-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.shot === state.currentShot));
  document.querySelectorAll(".ci-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.ci === (state.showCIBands ? "1" : "0")));
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.lang === currentLang));
}

// ─────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────

async function init() {
  try {
    const response = await fetch("data.json");
    state.DATA = await response.json();
    const languages = Object.keys(state.DATA.languages);
    if (!languages.length) throw new Error("No languages found in data");

    currentLang = languages.includes(DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : languages[0];
    state.currentTaskSelection = DEFAULT_SELECTION;
    state.showCIBands = false;
    state.currentFormulation = "max";
    state.formulationCombine = true;
    state.currentAccNorm = "max";
    state.llNormScope = "all";
    state.metricMode = "hard";
    state.taskTypeFilter = "all";
    state.currentDecoding = "sampling";
    setupUrlState();
    const hasURL = urlState.load();
    if (!state.DATA.languages[currentLang]) {
      currentLang = languages.includes(DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : languages[0];
    }

    state.metricsSetup = state.DATA.languages[currentLang].metrics_setup;
    // A restored task unknown here, or a category subset that is empty here,
    // falls back to the default aggregate instead of an empty chart.
    const restored = state.currentTaskSelection;
    if ((!isAggregateSelection(restored) && !state.metricsSetup[restored])
        || (restored.startsWith("__cat__") && getBenchmarksForSelection(restored).length === 0)) {
      state.currentTaskSelection = DEFAULT_SELECTION;
    }
    // A URL-restored category selection means a task subset, not all.
    const initBenches = getBenchmarksForSelection(state.currentTaskSelection);
    state.checkedTasks = new Set(initBenches.length ? initBenches : Object.keys(state.metricsSetup));

    buildLangTabs(languages);
    populateTaskDropdown();
    populateFormulationOptions();
    bindEventListeners();
    buildTaskCheckboxes({ filterSourceFn: checkedTasks, onChange: onTaskCheckboxChange });
    bindModuleActionStopPropagation();
    attachControlTooltips(VARIANT_CONTROL_TOOLTIPS);

    syncControlsFromState();
    if (hasURL) {
      syncTaskCheckboxStates(checkedTasks);
    } else {
      autoSetNormalization();
    }

    render();
    markAppReady();
  } catch (err) {
    console.error("init failed:", err);
    const el = document.getElementById("chart");
    if (el) el.innerHTML = "<pre style='color:red;padding:1rem;'>" + err.stack + "</pre>";
    markAppReady();
  }
}

document.addEventListener("DOMContentLoaded", init);
