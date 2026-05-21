// NorOLMo training-progress dashboard.
// Renders NorOLMo + ablation trajectories on the NorEval benchmark.
//
// Most chart logic lives in shared/progress.js. This file handles the
// dashboard-specific wiring: task dropdown, checkboxes, event listeners,
// URL state, and the construction of the "trajectories" list (main + ablations).

import { state } from "../shared/state.js";
import { MODEL_COLORS, isAggregateSelection } from "../shared/core.js";
import { makePlotlyConfig } from "../shared/chart.js";
import { buildTaskCheckboxes, syncTaskCheckboxStates, bindModuleActionStopPropagation } from "../shared/ui.js";
import { renderProgressChart, updateProgressTitle } from "../shared/progress.js";
import { UrlState } from "../shared/url-state.js";

const TOKENS_PER_STEP = 8192 * 1024;  // 8,388,608 tokens per training step
const ALL_SHOTS = ["0", "1", "5"];

const plotlyConfig = makePlotlyConfig("norolmo-chart", () => ({
  shot: state.currentShot + "-shot",
  task_selection: state.currentTaskSelection,
  prompt_aggregation: state.currentPromptAgg,
  normalization: state.currentNormalization,
}));

let urlState;

// ─────────────────────────────────────────────────────────────
// Trajectory builders
// ─────────────────────────────────────────────────────────────

function getMainCheckpoints() {
  return Object.keys(state.DATA.progress).map(Number).sort((a, b) => a - b);
}

function getAblationCheckpoints(ablName) {
  return Object.keys(state.DATA.ablations[ablName] || {}).map(Number).sort((a, b) => a - b);
}

function getAblationDisplayName(ablName) {
  return state.DATA.ablation_display_names?.[ablName] || ablName;
}

const ABLATION_COLORS_FALLBACK = [
  "#e63946", "#ff7f0e", "#2ca02c", "#9467bd", "#17becf", "#d62728", "#8c564b",
];

function getAblationColor(ablName) {
  if (state.DATA.ablation_colors?.[ablName]) return state.DATA.ablation_colors[ablName];
  const names = Object.keys(state.DATA.ablations || {});
  return ABLATION_COLORS_FALLBACK[names.indexOf(ablName) % ABLATION_COLORS_FALLBACK.length];
}

function getTrajectories() {
  const trajectories = [{
    name: "NorOLMo",
    color: MODEL_COLORS[0],
    dataSource: state.DATA.progress,
    checkpoints: getMainCheckpoints,
  }];
  for (const ablName of Object.keys(state.DATA.ablations || {})) {
    trajectories.push({
      name: getAblationDisplayName(ablName),
      color: getAblationColor(ablName),
      dataSource: state.DATA.ablations[ablName],
      checkpoints: () => getAblationCheckpoints(ablName),
    });
  }
  return trajectories;
}

// ─────────────────────────────────────────────────────────────
// Chart config
// ─────────────────────────────────────────────────────────────

const chartConfig = {
  getTrajectories,
  xToTokens: (step) => step * TOKENS_PER_STEP,
  xAxisLabel: "tokens",
  allShots: ALL_SHOTS,
  legendPosition: "bottom-right",
  plotlyConfig,
  groupBenchmarks: (name) => {
    const g = state.DATA.task_groups?.[name];
    return g ? { name, benchmarks: g.benchmarks, labels: g.labels } : null;
  },
  hoverXFormat: (xTokens, traceName) => {
    const step = Math.round(xTokens / TOKENS_PER_STEP);
    const tokensB = (xTokens / 1e9).toFixed(1);
    return `${traceName} — ${tokensB}B tokens (step ${step.toLocaleString()})`;
  },
  titlePrefix: "NorOLMo progress",
};

// ─────────────────────────────────────────────────────────────
// Selection helpers
// ─────────────────────────────────────────────────────────────

function getBenchmarksForSelection(sel) {
  if (sel === "__all__" || sel === "__all_macro__") return Object.keys(state.metricsSetup);
  if (sel === "__custom__") return [];
  if (sel.startsWith("__cat__")) {
    const c = sel.slice(7);
    return Object.keys(state.metricsSetup).filter((b) => state.metricsSetup[b].category === c);
  }
  if (sel.startsWith("__eval__")) {
    const e = sel.slice(8);
    return Object.keys(state.metricsSetup).filter((b) => state.metricsSetup[b].evaluation_type === e);
  }
  if (sel === "__lang__nno") {
    const nno = new Set(state.DATA.nno_benchmarks || []);
    for (const b of (state.DATA.nob_nno_translation_benchmarks || [])) nno.add(b);
    for (const b of (state.DATA.shared_language_benchmarks || [])) nno.add(b);
    return [...nno];
  }
  if (sel === "__lang__nob") {
    const nnoOnly = new Set(state.DATA.nno_benchmarks || []);
    const smeOnly = new Set(state.DATA.sme_benchmarks || []);
    const nobNno = new Set(state.DATA.nob_nno_translation_benchmarks || []);
    const shared = new Set(state.DATA.shared_language_benchmarks || []);
    return Object.keys(state.metricsSetup).filter((b) =>
      (!nnoOnly.has(b) && !smeOnly.has(b)) || nobNno.has(b) || shared.has(b));
  }
  if (sel === "__lang__sme") return state.DATA.sme_benchmarks || [];
  if (sel.startsWith("__group__")) {
    const g = state.DATA.task_groups[sel.slice(9)];
    return g ? g.benchmarks : [];
  }
  if (state.metricsSetup[sel]) return [sel];
  return [];
}

function findDropdownValueForBench(bench) {
  for (const [gn, g] of Object.entries(state.DATA.task_groups || {})) {
    if (g.benchmarks.includes(bench)) return "__group__" + gn;
  }
  if (state.DATA.standalone_benchmarks?.includes(bench)) return bench;
  return null;
}

function autoSetNormalization() {
  state.currentNormalization = isAggregateSelection(state.currentTaskSelection) ? "baseline" : "none";
  document.getElementById("norm-select").value = state.currentNormalization;
}

// ─────────────────────────────────────────────────────────────
// Dropdown
// ─────────────────────────────────────────────────────────────

function populateTaskDropdown() {
  const select = document.getElementById("task-select");
  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const categories = {};
  for (const [bench, info] of Object.entries(state.metricsSetup)) {
    (categories[info.category] = categories[info.category] || []).push(bench);
  }
  const catGroup = document.createElement("optgroup");
  catGroup.label = "Aggregate by category";
  for (const catName of Object.keys(categories).sort()) {
    const opt = document.createElement("option");
    opt.value = "__cat__" + catName;
    opt.textContent = cap(catName);
    catGroup.appendChild(opt);
  }
  select.appendChild(catGroup);

  const evalTypes = {};
  for (const [bench, info] of Object.entries(state.metricsSetup)) {
    if (info.evaluation_type) (evalTypes[info.evaluation_type] = evalTypes[info.evaluation_type] || []).push(bench);
  }
  if (Object.keys(evalTypes).length > 0) {
    const evalGroup = document.createElement("optgroup");
    evalGroup.label = "Aggregate by evaluation type";
    for (const etName of Object.keys(evalTypes).sort()) {
      const opt = document.createElement("option");
      opt.value = "__eval__" + etName;
      opt.textContent = cap(etName);
      evalGroup.appendChild(opt);
    }
    select.appendChild(evalGroup);
  }

  const langGroup = document.createElement("optgroup");
  langGroup.label = "Aggregate by language";
  for (const [val, label] of [["__lang__nob", "Bokmål"], ["__lang__nno", "Nynorsk"], ["__lang__sme", "Northern Sámi"]]) {
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = label;
    langGroup.appendChild(opt);
  }
  select.appendChild(langGroup);

  const taskGroup = document.createElement("optgroup");
  taskGroup.label = "Individual tasks";
  const entries = [];
  if (state.DATA.task_groups) {
    for (const groupName of Object.keys(state.DATA.task_groups)) {
      entries.push({ value: "__group__" + groupName, label: cap(groupName) });
    }
  }
  const standalones = state.DATA.standalone_benchmarks || Object.keys(state.metricsSetup);
  for (const bench of standalones) {
    const info = state.metricsSetup[bench];
    if (info) entries.push({ value: bench, label: cap(info.pretty_name) });
  }
  entries.sort((a, b) => a.label.localeCompare(b.label));
  for (const entry of entries) {
    const opt = document.createElement("option");
    opt.value = entry.value; opt.textContent = entry.label;
    taskGroup.appendChild(opt);
  }
  select.appendChild(taskGroup);
}

// ─────────────────────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────────────────────

function bindEventListeners() {
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
    const benchmarks = getBenchmarksForSelection(state.currentTaskSelection);
    if (benchmarks.length > 0) state.checkedTasks = new Set(benchmarks);
    syncTaskCheckboxStates(() => state.checkedTasks);
    autoSetNormalization();
    render();
  });

  document.getElementById("select-all-btn").addEventListener("click", () => {
    state.checkedTasks = new Set(Object.keys(state.metricsSetup));
    state.currentTaskSelection = "__all__";
    document.getElementById("task-select").value = "__all__";
    syncTaskCheckboxStates(() => state.checkedTasks);
    autoSetNormalization();
    render();
  });
  document.getElementById("select-none-btn").addEventListener("click", () => {
    state.checkedTasks.clear();
    syncTaskCheckboxStates(() => state.checkedTasks);
    render();
  });
}

function onTaskCheckboxChange() {
  if (state.checkedTasks.size === 1) {
    const bench = [...state.checkedTasks][0];
    state.currentTaskSelection = bench;
    const ddVal = findDropdownValueForBench(bench);
    if (ddVal) document.getElementById("task-select").value = ddVal;
    autoSetNormalization();
    render();
    return;
  }
  if (state.checkedTasks.size === 2 && state.DATA.task_groups) {
    const arr = [...state.checkedTasks];
    for (const [gn, g] of Object.entries(state.DATA.task_groups)) {
      if (g.benchmarks.length === 2 && g.benchmarks.includes(arr[0]) && g.benchmarks.includes(arr[1])) {
        state.currentTaskSelection = "__group__" + gn;
        document.getElementById("task-select").value = state.currentTaskSelection;
        autoSetNormalization();
        render();
        return;
      }
    }
  }
  state.currentTaskSelection = "__custom__";
  document.getElementById("task-select").value = "__custom__";
  autoSetNormalization();
  render();
}

// ─────────────────────────────────────────────────────────────
// Render entry point
// ─────────────────────────────────────────────────────────────

function render() {
  updateProgressTitle(chartConfig);
  renderProgressChart(chartConfig);
  urlState.save();
}

// ─────────────────────────────────────────────────────────────
// URL state
// ─────────────────────────────────────────────────────────────

function setupUrlState() {
  urlState = new UrlState([
    { key: "shot", get: () => state.currentShot, set: (v) => state.currentShot = v, default: "5" },
    { key: "task", get: () => state.currentTaskSelection, set: (v) => state.currentTaskSelection = v, default: "__all_macro__" },
    { key: "prompt", get: () => state.currentPromptAgg, set: (v) => state.currentPromptAgg = v, default: "max" },
    {
      key: "metric",
      get: () => state.currentMetric || "",
      set: (v) => state.currentMetric = v,
      default: "",
    },
    {
      key: "norm",
      get: () => state.currentNormalization,
      set: (v) => state.currentNormalization = v,
      default: () => isAggregateSelection(state.currentTaskSelection) ? "baseline" : "none",
    },
    {
      key: "tasks",
      get: () => {
        const auto = new Set(getBenchmarksForSelection(state.currentTaskSelection));
        const a = state.checkedTasks, b = auto;
        if (a.size === b.size && [...a].every((v) => b.has(v))) return "";
        return [...state.checkedTasks].sort().join(",");
      },
      set: (v) => {
        state.checkedTasks = v ? new Set(v.split(",").filter((t) => t in state.metricsSetup)) : new Set();
      },
      default: "",
    },
  ]);
}

// ─────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────

async function init() {
  try {
    const response = await fetch("data.json");
    state.DATA = await response.json();
    state.metricsSetup = state.DATA.metrics_setup;
    state.checkedTasks = new Set(Object.keys(state.metricsSetup));

    setupUrlState();
    const hasURL = urlState.load();

    // If `task` was specified in the URL but `tasks` was not, derive checkedTasks
    // from the task selection (mirrors the dropdown change handler). Without
    // this, checkedTasks stays at the initial "all tasks" value, which both
    // shows wrong results and pollutes the URL with an explicit tasks= list on
    // the next save.
    if (urlState.has("task") && !urlState.has("tasks")) {
      const benchmarks = getBenchmarksForSelection(state.currentTaskSelection);
      if (benchmarks.length > 0) state.checkedTasks = new Set(benchmarks);
    }

    populateTaskDropdown();
    bindEventListeners();
    buildTaskCheckboxes({
      filterSourceFn: () => state.checkedTasks,
      onChange: onTaskCheckboxChange,
    });
    bindModuleActionStopPropagation();

    // The `norm` URL field has a dynamic default ("baseline" for aggregate
    // selections, "none" otherwise). That default is only applied on save —
    // when `norm` is absent on load, `state.currentNormalization` would
    // otherwise stay at the static state.js default ("baseline"), giving
    // wrong values for individual-task URLs. Apply the dynamic default here.
    if (!urlState.has("norm")) autoSetNormalization();

    if (hasURL) {
      document.getElementById("task-select").value = state.currentTaskSelection;
      document.getElementById("prompt-agg-select").value = state.currentPromptAgg;
      document.getElementById("norm-select").value = state.currentNormalization;
      document.querySelectorAll(".shot-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.shot === state.currentShot));
      syncTaskCheckboxStates(() => state.checkedTasks);
    }

    render();
  } catch (err) {
    console.error("init failed:", err);
    const el = document.getElementById("chart");
    if (el) el.innerHTML = "<pre style='color:red;padding:1rem;'>" + err.stack + "</pre>";
  }
}

document.addEventListener("DOMContentLoaded", init);
