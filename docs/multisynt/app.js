// MultiSynt multilingual training-progress dashboard.
//
// Each language is a separate dataset ({metrics_setup, models}); switching the
// language tab re-binds state.metricsSetup and rebuilds the dropdown/checkbox grid.
//
// This is the only dashboard that uses the HPLT-E signal-quality filter.

import { state } from "../shared/state.js";
import {
  MODEL_COLORS, isAggregateSelection, capitalize,
} from "../shared/core.js";
import { makePlotlyConfig, downloadJSON } from "../shared/chart.js";
import {
  buildTaskCheckboxes, syncTaskCheckboxStates,
  bindModuleActionStopPropagation, attachControlTooltips, markAppReady,
} from "../shared/ui.js";
import {
  renderProgressChart, updateProgressTitle,
} from "../shared/progress.js";
import {
  filter, initFilter, runFilter, showFilterUI, hideFilterUI,
  resetFilterPanel, serializeCriteria, deserializeCriteria,
} from "../shared/filter.js";
import { UrlState } from "../shared/url-state.js";

const ALL_SHOTS = ["0", "5"];

const plotlyConfig = makePlotlyConfig("multisynt-chart", () => ({
  language: currentLang,
  shot: state.currentShot + "-shot",
  task_selection: state.currentTaskSelection,
  prompt_aggregation: state.currentPromptAgg,
  normalization: state.currentNormalization,
}));

let currentLang = null;
let urlState;

// ─────────────────────────────────────────────────────────────
// HPLT-E filter definitions
// ─────────────────────────────────────────────────────────────

const DEFAULT_CRITERIA = () => ({
  monotonicity: {
    enabled: true, min: 10, max: 100, threshold: 0.5, direction: ">=",
    label: "Monotonicity", description: "Spearman ρ (tokens vs. score)",
    tooltip: "Spearman rank correlation between checkpoint token count and benchmark score. Measures whether performance improves monotonically during training. Default threshold: ≥ 0.5.",
  },
  snr: {
    enabled: false, min: 10, max: 100, threshold: 3.0, direction: ">=",
    label: "Signal-to-noise ratio (SNR)", description: "Signal-to-noise ratio",
    tooltip: "Ratio of mean signal (score minus random baseline) to mean prompt standard deviation across checkpoints. Note: unlike the original HPLT-E implementation, the random baseline is subtracted from the signal so that chance-level performance yields SNR ≈ 0. Default threshold: ≥ 3.",
  },
  cv: {
    enabled: false, min: 10, max: 100, threshold: 15.0, direction: "<=",
    label: "Stable pretraining (CV)", description: "Coefficient of variation (%)",
    tooltip: "Standard deviation divided by mean score across checkpoints, as percentage. Measures score stability during training. Default threshold: ≤ 15%.",
  },
  mad: {
    enabled: false, min: 10, max: 100, threshold: 5.0, direction: "<=",
    label: "Prompt sensitivity (MAD)", description: "Median MAD across prompts",
    tooltip: "Median Absolute Deviation of scores across prompt variants, taken as the median over all checkpoints. Default threshold: ≤ 5.",
  },
  consistency: {
    enabled: false, min: 10, max: 100, threshold: 0.5, direction: ">=",
    label: "Ranking consistency", description: "Kendall τ (model rankings)",
    tooltip: "Average Kendall's τ correlation of model rankings between successive checkpoints. Measures whether the relative ordering of models is preserved across training. Default threshold: ≥ 0.5.",
  },
  promptSwitch: {
    enabled: false, min: 10, max: 100, threshold: 20.0, direction: "<=",
    label: "Prompt-switch rate", description: "Best-prompt change rate (%)",
    tooltip: "Fraction of checkpoints where the best-performing prompt variant changes, as a percentage.",
  },
  nonRandom: {
    enabled: false, min: 10, max: 100, threshold: 5.0, direction: ">=",
    label: "Non-randomness", description: "Max score − random baseline",
    tooltip: "Difference between the maximum score and the task's random baseline. Verifies the model learned beyond chance. Default threshold: ≥ 5.",
  },
});

// Per-language filter defaults (only used on first load, before URL state
// or user overrides). Migrated 1:1 from multisynt-dashboard/docs/app.js.
const FILTER_DEFAULTS = {
  French: {
    monotonicity: { enabled: true, min: 2, max: 95, threshold: 0.25 },
    snr:          { enabled: true, min: 10, max: 95, threshold: 1 },
    cv:           { enabled: false, min: 10, max: 100, threshold: 15 },
    mad:          { enabled: false, min: 10, max: 100, threshold: 5 },
    consistency:  { enabled: true, min: 10, max: 95, threshold: 0.5 },
    promptSwitch: { enabled: false, min: 10, max: 100, threshold: 20 },
    nonRandom:    { enabled: true, min: 10, max: 95, threshold: 5 },
  },
  Spanish: {
    monotonicity: { enabled: true, min: 2, max: 95, threshold: 0.25 },
    snr:          { enabled: true, min: 10, max: 95, threshold: 1 },
    cv:           { enabled: false, min: 10, max: 100, threshold: 15 },
    mad:          { enabled: true, min: 10, max: 95, threshold: 5 },
    consistency:  { enabled: true, min: 10, max: 95, threshold: 0 },
    promptSwitch: { enabled: false, min: 10, max: 100, threshold: 20 },
    nonRandom:    { enabled: true, min: 10, max: 95, threshold: 5 },
  },
};

function applyFilterDefaults(lang) {
  const defaults = FILTER_DEFAULTS[lang];
  if (!defaults) return;
  for (const [name, vals] of Object.entries(defaults)) {
    if (!filter.criteria[name]) continue;
    Object.assign(filter.criteria[name], vals);
  }
}

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
    color: modelData.color || MODEL_COLORS[0],
    dataSource: modelData.progress,
    checkpoints: () => getModelTokens(modelDir),
  }));
}

function getAllModelsForFilter() {
  // The filter module expects {name, color, progress, checkpoints} per model.
  return Object.entries(getModels()).map(([modelDir, modelData]) => ({
    name: modelDir,
    color: modelData.color,
    progress: modelData.progress,
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
  groupBenchmarks: null,         // multisynt has no task groups
  hoverXFormat: (x, traceName) => `${traceName || ""} — ${x}B tokens`,
  // Recomputed every render so it tracks language tab changes.
  titlePrefix: () => currentLang,
};

// ─────────────────────────────────────────────────────────────
// Selection helpers
// ─────────────────────────────────────────────────────────────

function getBenchmarksForSelection(sel) {
  const ms = state.metricsSetup;
  if (sel === "__all__" || sel === "__all_macro__" || sel === "__filtered__") return Object.keys(ms);
  if (sel === "__custom__") return [];
  if (sel.startsWith("__cat__")) {
    const c = sel.slice(7);
    return Object.keys(ms).filter((b) => ms[b].category === c);
  }
  if (ms[sel]) return [sel];
  return [];
}

function autoSetNormalization() {
  state.currentNormalization = "baseline";
  document.getElementById("norm-select").value = state.currentNormalization;
}

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
    btn.textContent = lang;
    nav.appendChild(btn);
  }
}

function populateTaskDropdown() {
  const select = document.getElementById("task-select");
  while (select.children.length > 4) select.removeChild(select.lastChild);
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

  document.getElementById("prompt-agg-select").addEventListener("change", (e) => {
    state.currentPromptAgg = e.target.value;
    render();
  });
  document.getElementById("norm-select").addEventListener("change", (e) => {
    state.currentNormalization = e.target.value;
    render();
  });
  document.getElementById("metric-select").addEventListener("change", (e) => {
    state.currentMetric = e.target.value;
    render();
  });

  document.getElementById("task-select").addEventListener("change", (e) => {
    state.currentTaskSelection = e.target.value;
    if (state.currentTaskSelection === "__filtered__") {
      filter.allBenchmarks = new Set(Object.keys(state.metricsSetup));
      state.checkedTasks = new Set(filter.allBenchmarks);
      showFilterUI();
      runFilter(getAllModelsForFilter(), state.currentShot);
    } else {
      hideFilterUI();
      const benchmarks = getBenchmarksForSelection(state.currentTaskSelection);
      if (benchmarks.length > 0) state.checkedTasks = new Set(benchmarks);
    }
    syncTaskCheckboxStates(() => state.currentTaskSelection === "__filtered__" ? filter.allBenchmarks : state.checkedTasks);
    autoSetNormalization();
    render();
  });

  document.getElementById("select-all-btn").addEventListener("click", () => {
    if (state.currentTaskSelection === "__filtered__") {
      filter.allBenchmarks = new Set(Object.keys(state.metricsSetup));
      syncTaskCheckboxStates(() => filter.allBenchmarks);
      runFilter(getAllModelsForFilter(), state.currentShot);
      render();
    } else {
      state.checkedTasks = new Set(Object.keys(state.metricsSetup));
      state.currentTaskSelection = "__all__";
      document.getElementById("task-select").value = "__all__";
      syncTaskCheckboxStates(() => state.checkedTasks);
      autoSetNormalization();
      render();
    }
  });
  document.getElementById("select-none-btn").addEventListener("click", () => {
    if (state.currentTaskSelection === "__filtered__") {
      filter.allBenchmarks.clear();
      syncTaskCheckboxStates(() => filter.allBenchmarks);
      runFilter(getAllModelsForFilter(), state.currentShot);
      render();
    } else {
      state.checkedTasks.clear();
      syncTaskCheckboxStates(() => state.checkedTasks);
      render();
    }
  });
}

function onTaskCheckboxChange() {
  if (state.currentTaskSelection === "__filtered__") {
    filter.allBenchmarks = new Set();
    document.querySelectorAll("#checkbox-grid input[data-bench]").forEach((cb) => {
      if (cb.checked) filter.allBenchmarks.add(cb.dataset.bench);
    });
    runFilter(getAllModelsForFilter(), state.currentShot);
    render();
    return;
  }
  if (state.checkedTasks.size === 1) {
    const bench = [...state.checkedTasks][0];
    state.currentTaskSelection = bench;
    if (state.metricsSetup[bench]) document.getElementById("task-select").value = bench;
    autoSetNormalization();
    render();
    return;
  }
  state.currentTaskSelection = "__custom__";
  document.getElementById("task-select").value = "__custom__";
  autoSetNormalization();
  render();
}

// ─────────────────────────────────────────────────────────────
// Filter UI bindings
// ─────────────────────────────────────────────────────────────

function onFilterChange() {
  runFilter(getAllModelsForFilter(), state.currentShot);
  render();
}

function bindFilterIO() {
  // (Re)bind every time the filter UI is shown, since the buttons exist in the
  // panel but the body is conditionally rendered.
  const dlBtn = document.getElementById("filter-download-btn");
  if (dlBtn) {
    dlBtn.onclick = () => {
      downloadJSON(serializeCriteria(),
        "filter-criteria-" + (currentLang || "default").toLowerCase() + ".json");
    };
  }
  const ulBtn = document.getElementById("filter-upload-btn");
  const ulInput = document.getElementById("filter-upload-input");
  if (ulBtn && ulInput) {
    ulBtn.onclick = () => ulInput.click();
    ulInput.onchange = () => {
      const file = ulInput.files[0];
      if (!file) return;
      file.text().then((json) => {
        try {
          deserializeCriteria(JSON.parse(json));
          showFilterUI();  // re-render with new values
          runFilter(getAllModelsForFilter(), state.currentShot);
          render();
        } catch (e) {
          console.error("Failed to import criteria:", e);
        }
      });
      ulInput.value = "";
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Language switching
// ─────────────────────────────────────────────────────────────

function setLanguage(lang) {
  currentLang = lang;
  state.metricsSetup = state.DATA.languages[lang].metrics_setup;
  applyFilterDefaults(lang);

  populateTaskDropdown();
  if (!isAggregateSelection(state.currentTaskSelection) && !state.metricsSetup[state.currentTaskSelection]) {
    state.currentTaskSelection = "__filtered__";
    document.getElementById("task-select").value = "__filtered__";
  }
  filter.allBenchmarks = new Set(Object.keys(state.metricsSetup));
  state.checkedTasks = new Set(Object.keys(state.metricsSetup));
  buildTaskCheckboxes({
    filterSourceFn: () => state.currentTaskSelection === "__filtered__" ? filter.allBenchmarks : state.checkedTasks,
    onChange: onTaskCheckboxChange,
  });
  resetFilterPanel();
  autoSetNormalization();
  render();
}

// ─────────────────────────────────────────────────────────────
// Render entry point
// ─────────────────────────────────────────────────────────────

function render() {
  updateProgressTitle(chartConfig);
  if (state.currentTaskSelection === "__filtered__") {
    if (filter.allBenchmarks.size === 0) {
      filter.allBenchmarks = new Set(Object.keys(state.metricsSetup));
    }
    showFilterUI();
    bindFilterIO();
    runFilter(getAllModelsForFilter(), state.currentShot);
  } else {
    hideFilterUI();
  }
  renderProgressChart(chartConfig);
  urlState.save();
}

// ─────────────────────────────────────────────────────────────
// URL state
// ─────────────────────────────────────────────────────────────

function setupUrlState() {
  urlState = new UrlState([
    { key: "lang", get: () => currentLang, set: (v) => currentLang = v, default: null, noDefault: true },
    { key: "shot", get: () => state.currentShot, set: (v) => state.currentShot = v, default: "5" },
    { key: "task", get: () => state.currentTaskSelection, set: (v) => state.currentTaskSelection = v, default: "__filtered__" },
    { key: "pagg", get: () => state.currentPromptAgg, set: (v) => state.currentPromptAgg = v, default: "max" },
    { key: "norm", get: () => state.currentNormalization, set: (v) => state.currentNormalization = v, default: "baseline" },
    { key: "metric", get: () => state.currentMetric || "", set: (v) => state.currentMetric = v, default: "" },
    {
      key: "fc",
      get: () => {
        // Encode criteria compactly: name=enabled,min,max,thresh
        const parts = [];
        for (const [name, cfg] of Object.entries(filter.criteria)) {
          parts.push(name + ":" + (cfg.enabled ? "1" : "0") + "," + cfg.min + "," + cfg.max + "," + cfg.threshold);
        }
        return parts.join(";");
      },
      set: (v) => {
        for (const part of v.split(";")) {
          const [name, vals] = part.split(":");
          if (!name || !vals || !filter.criteria[name]) continue;
          const [en, mn, mx, th] = vals.split(",");
          const cfg = filter.criteria[name];
          cfg.enabled = en === "1";
          if (!isNaN(Number(mn))) cfg.min = Number(mn);
          if (!isNaN(Number(mx))) cfg.max = Number(mx);
          if (!isNaN(Number(th))) cfg.threshold = Number(th);
        }
      },
      default: "",
      noDefault: true,
    },
  ], { mode: "search" });
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

    // Initialize filter module with criteria template + UI config
    initFilter(DEFAULT_CRITERIA(), {
      criterionOrder: ["monotonicity", "snr", "cv", "mad", "consistency", "promptSwitch", "nonRandom"],
      criterionHeaders: ["Monotonicity", "SNR", "CV", "MAD", "Consistency", "Switch rate", "Non-Randomness"],
      onChange: onFilterChange,
    });

    currentLang = languages[0];
    applyFilterDefaults(currentLang);
    setupUrlState();
    const hasURL = urlState.load();
    if (!state.DATA.languages[currentLang]) {
      currentLang = languages[0];
      applyFilterDefaults(currentLang);
    }

    state.metricsSetup = state.DATA.languages[currentLang].metrics_setup;
    state.checkedTasks = new Set(Object.keys(state.metricsSetup));
    filter.allBenchmarks = new Set(Object.keys(state.metricsSetup));

    buildLangTabs(languages);
    populateTaskDropdown();
    bindEventListeners();
    buildTaskCheckboxes({
      filterSourceFn: () => state.currentTaskSelection === "__filtered__" ? filter.allBenchmarks : state.checkedTasks,
      onChange: onTaskCheckboxChange,
    });
    bindModuleActionStopPropagation();
    attachControlTooltips();

    if (hasURL) {
      document.getElementById("task-select").value = state.currentTaskSelection;
      document.getElementById("prompt-agg-select").value = state.currentPromptAgg;
      document.getElementById("norm-select").value = state.currentNormalization;
      document.querySelectorAll(".shot-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.shot === state.currentShot));
      document.querySelectorAll(".tab-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.lang === currentLang));
      syncTaskCheckboxStates(() => state.currentTaskSelection === "__filtered__" ? filter.allBenchmarks : state.checkedTasks);
    } else {
      state.currentTaskSelection = "__filtered__";
      document.getElementById("task-select").value = "__filtered__";
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
