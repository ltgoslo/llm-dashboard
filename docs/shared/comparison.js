// Comparison dashboard — bar charts comparing multiple models on selected benchmarks.
// Shared by both /noreval (base models) and /noreval-gen (instruct models).
//
// Each dashboard supplies dashboard-specific configuration via initComparison():
//   - title, subtitle
//   - default shot setting (5 for base, 0 for instruct)
//   - default size-slider range
//   - filenamePrefix for chart export

import { state } from "./state.js";
import {
  MODEL_COLORS, METRIC_DISPLAY, METRIC_DESCRIPTIONS,
  getScore, getCombinedSE, scaleStderr, applyNorm, toDisplayScale,
  getBaseMetric, getNormYLabel, getMetricYLabel,
  aggregateScores, isAggregateSelection, isMacroSelection,
  getEffectiveMetric, isStderrCompatible,
} from "./core.js";
import {
  darkenColor, makePlotlyConfig, getPlotlyLayout, plotChart,
  computeTickAngle, computeAnnotationFontSize, computeYRange,
} from "./chart.js";
import {
  showTooltip, hideTooltip, attachTooltip, populateMetricSelector, hideMetricSelector,
  buildTaskCheckboxes, syncTaskCheckboxStates,
} from "./ui.js";
import { UrlState } from "./url-state.js";

let CFG = null;            // Dashboard configuration (set in initComparison)
let plotlyConfig = null;   // Built from CFG.filenamePrefix
let urlState = null;

// Comparison-specific state (not in shared/state.js).
let currentSizeMin = 7;
let currentSizeMax = 14;
let fullyOpenOnly = false;

// Model checkbox state.
export const checkedModels = new Set();

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/** Entry point. Loads data.json, initializes state, wires DOM, renders. */
export async function initComparison(config) {
  CFG = Object.assign({
    title: "Model Comparison",
    defaultShot: "5",
    defaultSizeMin: 7,
    defaultSizeMax: 14,
    sizeRangeMin: 1,
    sizeRangeMax: 73,
    filenamePrefix: "comparison-chart",
    enableLanguageGroups: true,
    enableEvalTypes: true,
    enableTaskGroups: true,
  }, config);
  plotlyConfig = makePlotlyConfig(CFG.filenamePrefix, () => ({
    shot: state.currentShot + "-shot",
    task_selection: state.currentTaskSelection,
    prompt_aggregation: state.currentPromptAgg,
    normalization: state.currentNormalization,
  }));

  // Apply dashboard defaults
  state.currentShot = CFG.defaultShot;
  currentSizeMin = CFG.defaultSizeMin;
  currentSizeMax = CFG.defaultSizeMax;

  try {
    const response = await fetch("data.json");
    state.DATA = await response.json();
    state.metricsSetup = state.DATA.metrics_setup;

    // Defaults
    const defaultModels = state.DATA.default_models || Object.keys(state.DATA.models);
    for (const m of defaultModels) if (m in state.DATA.models) checkedModels.add(m);
    state.checkedTasks = new Set(Object.keys(state.metricsSetup));

    setupUrlState();
    const hasURL = urlState.load();

    // Sync UI controls
    populateTaskDropdown();
    bindEventListeners();
    buildCheckboxes();
    buildModelCheckboxes();

    if (hasURL) {
      document.getElementById("task-select").value = state.currentTaskSelection;
      document.getElementById("prompt-agg-select").value = state.currentPromptAgg;
      document.getElementById("norm-select").value = state.currentNormalization;
      document.querySelectorAll(".shot-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.shot === state.currentShot));
      syncTaskCheckboxStates(() => state.checkedTasks);
      syncModelCheckboxStates();
      updateRangeSliderUI();
      const fo = document.getElementById("fully-open-toggle");
      if (fo) fo.checked = fullyOpenOnly;
    } else {
      autoSetNormalization();
    }

    renderChart();
  } catch (err) {
    console.error("init failed:", err);
    const el = document.getElementById("chart");
    if (el) el.innerHTML = "<pre style='color:red;padding:1rem;'>" + err.stack + "</pre>";
  }
}

// ─────────────────────────────────────────────────────────────
// URL state
// ─────────────────────────────────────────────────────────────

// Lazy alias maps (built on first use).
const taskAlias = { _toAlias: {}, _toSel: {} };

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function buildTaskAliasMaps() {
  taskAlias._toAlias["__all__"] = "all-micro";
  taskAlias._toSel["all-micro"] = "__all__";
  taskAlias._toAlias["__custom__"] = "custom";
  taskAlias._toSel["custom"] = "__custom__";
  taskAlias._toAlias["__filtered__"] = "filtered";
  taskAlias._toSel["filtered"] = "__filtered__";

  const cats = new Set(), evals = new Set();
  for (const info of Object.values(state.metricsSetup)) {
    cats.add(info.category);
    if (info.evaluation_type) evals.add(info.evaluation_type);
  }
  for (const c of cats) {
    const sel = "__cat__" + c, a = "c:" + slugify(c);
    taskAlias._toAlias[sel] = a; taskAlias._toSel[a] = sel;
  }
  for (const e of evals) {
    const sel = "__eval__" + e, a = "e:" + slugify(e);
    taskAlias._toAlias[sel] = a; taskAlias._toSel[a] = sel;
  }
  for (const lang of ["nob", "nno", "sme"]) {
    const sel = "__lang__" + lang, a = "l:" + lang;
    taskAlias._toAlias[sel] = a; taskAlias._toSel[a] = sel;
  }
  if (state.DATA.task_groups) {
    for (const gn of Object.keys(state.DATA.task_groups)) {
      const sel = "__group__" + gn, a = "g:" + slugify(gn);
      taskAlias._toAlias[sel] = a; taskAlias._toSel[a] = sel;
    }
  }
}

const modelAlias = { _toAlias: {}, _toSel: {} };
function buildModelAliasMaps() {
  for (const dir of Object.keys(state.DATA.models)) {
    const a = slugify(getModelLabel(dir));
    modelAlias._toAlias[dir] = a;
    modelAlias._toSel[a] = dir;
  }
}

function setupUrlState() {
  buildTaskAliasMaps();
  buildModelAliasMaps();

  urlState = new UrlState([
    { key: "shot", get: () => state.currentShot, set: (v) => state.currentShot = v, default: CFG.defaultShot },
    {
      key: "task",
      get: () => taskAlias._toAlias[state.currentTaskSelection] || state.currentTaskSelection,
      set: (v) => { state.currentTaskSelection = taskAlias._toSel[v] || v; },
      default: "__all_macro__",
      encode: (v) => v,
      decode: (v) => v,
    },
    { key: "prompt", get: () => state.currentPromptAgg, set: (v) => state.currentPromptAgg = v, default: "max" },
    {
      key: "metric",
      get: () => {
        if (!state.currentMetric || isAggregateSelection(state.currentTaskSelection)) return "";
        const benchmarks = getBenchmarksForSelection(state.currentTaskSelection);
        const main = benchmarks.length > 0 ? state.metricsSetup[benchmarks[0]]?.main_metric : null;
        return state.currentMetric === main ? "" : state.currentMetric;
      },
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
      key: "size",
      get: () => currentSizeMin + "-" + currentSizeMax,
      set: (v) => {
        const parts = v.split("-");
        if (parts.length === 2) {
          currentSizeMin = parseInt(parts[0], 10) || CFG.sizeRangeMin;
          currentSizeMax = parseInt(parts[1], 10) || CFG.sizeRangeMax;
        }
      },
      default: () => CFG.defaultSizeMin + "-" + CFG.defaultSizeMax,
    },
    {
      key: "open",
      get: () => fullyOpenOnly ? "1" : "0",
      set: (v) => fullyOpenOnly = v === "1",
      default: "0",
    },
    {
      key: "models",
      get: () => {
        const all = new Set(Object.keys(state.DATA.models));
        const defaults = new Set((state.DATA.default_models || Object.keys(state.DATA.models)).filter((m) => m in state.DATA.models));
        if (setsEqual(checkedModels, defaults)) return "";
        if (setsEqual(checkedModels, all)) return "all";
        return [...checkedModels].map((d) => modelAlias._toAlias[d] || d).sort().join(",");
      },
      set: (v) => {
        const all = new Set(Object.keys(state.DATA.models));
        checkedModels.clear();
        if (v === "all") {
          for (const m of all) checkedModels.add(m);
        } else if (v) {
          for (const a of v.split(",")) {
            const dir = modelAlias._toSel[a] || a;
            if (state.DATA.models[dir]) checkedModels.add(dir);
          }
        }
      },
      default: "",
    },
    {
      key: "tasks",
      get: () => {
        const auto = new Set(getBenchmarksForSelection(state.currentTaskSelection));
        return setsEqual(state.checkedTasks, auto) ? "" : [...state.checkedTasks].sort().join(",");
      },
      set: (v) => {
        if (v) state.checkedTasks = new Set(v.split(",").filter((t) => t in state.metricsSetup));
        else state.checkedTasks = new Set();
      },
      default: "",
    },
  ]);
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// Selection helpers
// ─────────────────────────────────────────────────────────────

function getBenchmarksForSelection(sel) {
  if (sel === "__all__" || sel === "__all_macro__" || sel === "__filtered__") return Object.keys(state.metricsSetup);
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
  if (state.DATA.standalone_benchmarks && state.DATA.standalone_benchmarks.includes(bench)) return bench;
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

  if (CFG.enableTaskGroups) {
    const categories = {};
    for (const [bench, info] of Object.entries(state.metricsSetup)) {
      (categories[info.category] = categories[info.category] || []).push(bench);
    }
    const catGroup = document.createElement("optgroup");
    catGroup.label = "Aggregate by Category";
    for (const catName of Object.keys(categories).sort()) {
      const opt = document.createElement("option");
      opt.value = "__cat__" + catName;
      opt.textContent = catName;
      catGroup.appendChild(opt);
    }
    select.appendChild(catGroup);
  }

  if (CFG.enableEvalTypes) {
    const evalTypes = {};
    for (const [bench, info] of Object.entries(state.metricsSetup)) {
      const et = info.evaluation_type;
      if (et) (evalTypes[et] = evalTypes[et] || []).push(bench);
    }
    if (Object.keys(evalTypes).length > 0) {
      const evalGroup = document.createElement("optgroup");
      evalGroup.label = "Aggregate by Evaluation Type";
      for (const etName of Object.keys(evalTypes).sort()) {
        const opt = document.createElement("option");
        opt.value = "__eval__" + etName;
        opt.textContent = etName;
        evalGroup.appendChild(opt);
      }
      select.appendChild(evalGroup);
    }
  }

  if (CFG.enableLanguageGroups) {
    const langGroup = document.createElement("optgroup");
    langGroup.label = "Aggregate by Language";
    for (const [val, label] of [["__lang__nob", "Bokmål"], ["__lang__nno", "Nynorsk"], ["__lang__sme", "Northern Sámi"]]) {
      const opt = document.createElement("option");
      opt.value = val; opt.textContent = label;
      langGroup.appendChild(opt);
    }
    select.appendChild(langGroup);
  }

  const taskGroup = document.createElement("optgroup");
  taskGroup.label = "Individual Tasks";
  const entries = [];
  if (CFG.enableTaskGroups && state.DATA.task_groups) {
    for (const groupName of Object.keys(state.DATA.task_groups)) {
      entries.push({ value: "__group__" + groupName, label: groupName });
    }
  }
  const standalones = state.DATA.standalone_benchmarks || Object.keys(state.metricsSetup);
  for (const bench of standalones) {
    const info = state.metricsSetup[bench];
    if (info) entries.push({ value: bench, label: info.pretty_name });
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
      renderChart();
    });
  });

  document.getElementById("prompt-agg-select").addEventListener("change", (e) => {
    state.currentPromptAgg = e.target.value;
    renderChart();
  });

  document.getElementById("norm-select").addEventListener("change", (e) => {
    state.currentNormalization = e.target.value;
    renderChart();
  });

  const foToggle = document.getElementById("fully-open-toggle");
  if (foToggle) {
    foToggle.addEventListener("change", (e) => {
      fullyOpenOnly = e.target.checked;
      renderChart();
    });
  }

  document.getElementById("metric-select").addEventListener("change", (e) => {
    state.currentMetric = e.target.value;
    renderChart();
  });

  document.getElementById("task-select").addEventListener("change", (e) => {
    state.currentTaskSelection = e.target.value;
    const benchmarks = getBenchmarksForSelection(state.currentTaskSelection);
    if (benchmarks.length > 0) state.checkedTasks = new Set(benchmarks);
    syncTaskCheckboxStates(() => state.checkedTasks);
    autoSetNormalization();
    renderChart();
  });

  document.getElementById("select-all-btn").addEventListener("click", () => {
    state.checkedTasks = new Set(Object.keys(state.metricsSetup));
    state.currentTaskSelection = "__all__";
    document.getElementById("task-select").value = "__all__";
    syncTaskCheckboxStates(() => state.checkedTasks);
    autoSetNormalization();
    renderChart();
  });
  document.getElementById("select-none-btn").addEventListener("click", () => {
    state.checkedTasks.clear();
    syncTaskCheckboxStates(() => state.checkedTasks);
    renderChart();
  });

  document.querySelectorAll(".model-select-all").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.category;
      for (const m of Object.keys(state.DATA.models)) {
        if ((state.DATA.model_categories?.[m] || "multilingual") === cat) checkedModels.add(m);
      }
      syncModelCheckboxStates();
      renderChart();
    });
  });
  document.querySelectorAll(".model-select-none").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.category;
      for (const m of Object.keys(state.DATA.models)) {
        if ((state.DATA.model_categories?.[m] || "multilingual") === cat) checkedModels.delete(m);
      }
      syncModelCheckboxStates();
      renderChart();
    });
  });

  initRangeSlider();
}

// ─────────────────────────────────────────────────────────────
// Task checkboxes
// ─────────────────────────────────────────────────────────────

function buildCheckboxes() {
  buildTaskCheckboxes({
    filterSourceFn: () => state.checkedTasks,
    onChange: onTaskCheckboxChange,
  });
}

function onTaskCheckboxChange() {
  if (state.checkedTasks.size === 1) {
    const bench = [...state.checkedTasks][0];
    state.currentTaskSelection = bench;
    const ddVal = findDropdownValueForBench(bench);
    if (ddVal) document.getElementById("task-select").value = ddVal;
    autoSetNormalization();
    renderChart();
    return;
  }
  if (CFG.enableTaskGroups && state.checkedTasks.size === 2 && state.DATA.task_groups) {
    const arr = [...state.checkedTasks];
    for (const [gn, g] of Object.entries(state.DATA.task_groups)) {
      if (g.benchmarks.length === 2 && g.benchmarks.includes(arr[0]) && g.benchmarks.includes(arr[1])) {
        state.currentTaskSelection = "__group__" + gn;
        document.getElementById("task-select").value = state.currentTaskSelection;
        autoSetNormalization();
        renderChart();
        return;
      }
    }
  }
  state.currentTaskSelection = "__custom__";
  document.getElementById("task-select").value = "__custom__";
  autoSetNormalization();
  renderChart();
}

// ─────────────────────────────────────────────────────────────
// Size slider
// ─────────────────────────────────────────────────────────────

function valueToPercent(val) {
  const logMin = Math.log(CFG.sizeRangeMin);
  const logMax = Math.log(CFG.sizeRangeMax);
  return (Math.log(val) - logMin) / (logMax - logMin) * 100;
}

function percentToValue(pct) {
  const logMin = Math.log(CFG.sizeRangeMin);
  const logMax = Math.log(CFG.sizeRangeMax);
  return Math.max(CFG.sizeRangeMin, Math.min(CFG.sizeRangeMax,
    Math.round(Math.exp(logMin + pct / 100 * (logMax - logMin)))));
}

function updateRangeSliderUI() {
  const slider = document.getElementById("range-slider");
  if (!slider) return;
  const thumbMin = document.getElementById("thumb-min");
  const thumbMax = document.getElementById("thumb-max");
  const fill = document.getElementById("range-fill");
  if (!thumbMin || !thumbMax || !fill) return;
  const pctMin = valueToPercent(currentSizeMin);
  const pctMax = valueToPercent(currentSizeMax);
  thumbMin.style.left = pctMin + "%";
  thumbMax.style.left = pctMax + "%";
  fill.style.left = pctMin + "%";
  fill.style.right = (100 - pctMax) + "%";
  document.getElementById("size-min-label").textContent = currentSizeMin + "B";
  document.getElementById("size-max-label").textContent = currentSizeMax + "B";
}

function initRangeSlider() {
  const slider = document.getElementById("range-slider");
  if (!slider) return;
  const thumbMin = document.getElementById("thumb-min");
  const thumbMax = document.getElementById("thumb-max");

  updateRangeSliderUI();

  let activeThumb = null;
  function getValueFromEvent(e) {
    const rect = slider.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const pct = Math.max(0, Math.min(100, (clientX - rect.left) / rect.width * 100));
    return percentToValue(pct);
  }
  function onMove(e) {
    if (!activeThumb) return;
    e.preventDefault();
    const val = getValueFromEvent(e);
    if (activeThumb === thumbMin) currentSizeMin = Math.min(val, currentSizeMax);
    else currentSizeMax = Math.max(val, currentSizeMin);
    updateRangeSliderUI();
    renderChart();
  }
  function onEnd() {
    if (activeThumb) activeThumb.classList.remove("active");
    activeThumb = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onEnd);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onEnd);
    urlState.save();
  }
  function onStart(thumb, e) {
    e.preventDefault();
    activeThumb = thumb;
    thumb.classList.add("active");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onEnd);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
  }
  thumbMin.addEventListener("mousedown", (e) => onStart(thumbMin, e));
  thumbMin.addEventListener("touchstart", (e) => onStart(thumbMin, e), { passive: false });
  thumbMax.addEventListener("mousedown", (e) => onStart(thumbMax, e));
  thumbMax.addEventListener("touchstart", (e) => onStart(thumbMax, e), { passive: false });
  slider.addEventListener("mousedown", (e) => {
    if (e.target === thumbMin || e.target === thumbMax) return;
    const val = getValueFromEvent(e);
    const distMin = Math.abs(val - currentSizeMin);
    const distMax = Math.abs(val - currentSizeMax);
    const thumb = distMin <= distMax ? thumbMin : thumbMax;
    if (thumb === thumbMin) currentSizeMin = Math.min(val, currentSizeMax);
    else currentSizeMax = Math.max(val, currentSizeMin);
    updateRangeSliderUI();
    renderChart();
    onStart(thumb, e);
  });
}

// ─────────────────────────────────────────────────────────────
// Model helpers
// ─────────────────────────────────────────────────────────────

function getModelLabel(modelDir) {
  return state.DATA.model_display_names?.[modelDir] || modelDir;
}

function getModelColor(modelDir) {
  const explicit = state.DATA.model_colors?.[modelDir];
  if (explicit) return explicit;
  const assigned = new Set(Object.values(state.DATA.model_colors || {}));
  const available = MODEL_COLORS.filter((c) => !assigned.has(c));
  const unassigned = Object.keys(state.DATA.models).filter((m) => !state.DATA.model_colors?.[m]);
  const idx = unassigned.indexOf(modelDir);
  return available[idx % available.length] || MODEL_COLORS[idx % MODEL_COLORS.length];
}

function getModelOpenLabel(modelDir) {
  return state.DATA.model_fully_open?.[modelDir] ? "fully-open" : "open weights";
}

function isModelInSizeRange(modelDir) {
  const size = state.DATA.model_parameters?.[modelDir];
  if (size !== undefined && size !== 0) {
    if (size < currentSizeMin || size > currentSizeMax) return false;
  }
  if (fullyOpenOnly && !state.DATA.model_fully_open?.[modelDir]) return false;
  return true;
}

function getModelList() {
  return Object.keys(state.DATA.models)
    .filter((m) => checkedModels.has(m) && isModelInSizeRange(m))
    .sort((a, b) => {
      const orgA = state.DATA.model_organizations?.[a] || "";
      const orgB = state.DATA.model_organizations?.[b] || "";
      const orgCmp = orgA.localeCompare(orgB);
      if (orgCmp !== 0) return orgCmp;
      const sizeCmp = (state.DATA.model_parameters?.[a] || 0) - (state.DATA.model_parameters?.[b] || 0);
      if (sizeCmp !== 0) return sizeCmp;
      return getModelLabel(a).localeCompare(getModelLabel(b));
    });
}

// ─────────────────────────────────────────────────────────────
// Model checkbox panel
// ─────────────────────────────────────────────────────────────

function buildModelCheckboxes() {
  const modelsData = state.DATA.models;
  const catModels = { norwegian: {}, multilingual: {} };
  for (const dir of Object.keys(modelsData)) {
    const cat = state.DATA.model_categories?.[dir] || "multilingual";
    const org = state.DATA.model_organizations?.[dir] || "Other";
    if (!catModels[cat]) catModels[cat] = {};
    if (!catModels[cat][org]) catModels[cat][org] = [];
    catModels[cat][org].push(dir);
  }

  const gridIds = { norwegian: "norwegian-model-grid", multilingual: "multilingual-model-grid" };
  for (const catKey of ["norwegian", "multilingual"]) {
    const grid = document.getElementById(gridIds[catKey]);
    if (!grid) continue;
    grid.innerHTML = "";

    const orgs = Object.keys(catModels[catKey] || {}).sort();
    for (const org of orgs) {
      const models = catModels[catKey][org];
      models.sort((a, b) => {
        const sizeCmp = (state.DATA.model_parameters?.[a] || 0) - (state.DATA.model_parameters?.[b] || 0);
        if (sizeCmp !== 0) return sizeCmp;
        return getModelLabel(a).localeCompare(getModelLabel(b));
      });

      const orgDiv = document.createElement("div");
      orgDiv.className = "model-org-group";
      const headerDiv = document.createElement("div");
      headerDiv.className = "model-org-header";
      const gcb = document.createElement("input");
      gcb.type = "checkbox"; gcb.className = "model-group-checkbox";
      gcb.dataset.org = org; gcb.dataset.cat = catKey;
      const initAll = models.length > 0 && models.every((m) => checkedModels.has(m));
      const initSome = models.some((m) => checkedModels.has(m));
      gcb.checked = initAll;
      gcb.indeterminate = !initAll && initSome;
      gcb.addEventListener("change", () => {
        for (const m of models) {
          if (gcb.checked) checkedModels.add(m); else checkedModels.delete(m);
        }
        syncModelCheckboxStates();
        renderChart();
      });
      headerDiv.addEventListener("click", (e) => { if (e.target !== gcb) gcb.click(); });
      const h4 = document.createElement("h4"); h4.textContent = org;
      headerDiv.appendChild(gcb); headerDiv.appendChild(h4);
      orgDiv.appendChild(headerDiv);

      for (const modelDir of models) {
        const label = document.createElement("label");
        label.dataset.model = modelDir;
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = checkedModels.has(modelDir);
        cb.dataset.model = modelDir;
        cb.addEventListener("change", () => {
          if (cb.checked) checkedModels.add(modelDir);
          else checkedModels.delete(modelDir);
          syncModelCheckboxStates();
          renderChart();
        });
        const dot = document.createElement("span");
        dot.className = "model-color-dot";
        dot.style.backgroundColor = getModelColor(modelDir);
        label.appendChild(cb);
        label.appendChild(dot);
        label.appendChild(document.createTextNode(" " + getModelLabel(modelDir)));
        attachModelTooltip(label, modelDir);
        orgDiv.appendChild(label);
      }
      grid.appendChild(orgDiv);
    }
  }
}

function syncModelCheckboxStates() {
  document.querySelectorAll(".model-checkbox-grid input[data-model]").forEach((cb) => {
    cb.checked = checkedModels.has(cb.dataset.model);
  });
  document.querySelectorAll(".model-group-checkbox").forEach((gcb) => {
    const org = gcb.dataset.org;
    const cat = gcb.dataset.cat;
    const models = Object.keys(state.DATA.models).filter(
      (m) => (state.DATA.model_categories?.[m] || "multilingual") === cat
          && (state.DATA.model_organizations?.[m] || "Other") === org
    );
    const allChecked = models.length > 0 && models.every((m) => checkedModels.has(m));
    const someChecked = models.some((m) => checkedModels.has(m));
    gcb.checked = allChecked;
    gcb.indeterminate = !allChecked && someChecked;
  });
}

function attachModelTooltip(element, modelDir) {
  attachTooltip(element, () => {
    const info = state.DATA.model_info?.[modelDir];
    if (!info) return null;
    const params = state.DATA.model_parameters?.[modelDir];
    let paramsPart = "";
    if (params) paramsPart = params < 1 ? `${Math.round(params * 1000)}M parameters` : `${params}B parameters`;
    const licensePart = info.license ? `License: ${info.license}` : "";
    const meta = [paramsPart, licensePart, getModelOpenLabel(modelDir)].filter(Boolean).join("  ·  ");
    const footer = info.huggingface_url ? info.huggingface_url.replace("https://huggingface.co/", "hf.co/") : "";
    return { title: getModelLabel(modelDir), meta, body: info.description || "", footer };
  });
}

// ─────────────────────────────────────────────────────────────
// Chart hover
// ─────────────────────────────────────────────────────────────

function onChartHover(data) {
  if (!data.points || !data.points.length) return;
  const pt = data.points[0];
  if (pt.y == null) return;
  const fmt = state.currentNormalization === "zscore" ? 2 : 1;
  const scoreStr = Number(pt.y).toFixed(fmt);
  const sel = state.currentTaskSelection;
  const cd = pt.customdata;

  let seStr = "";
  if (state.showStderr && cd != null) {
    if (isAggregateSelection(sel)) {
      if (cd && typeof cd === "object" && cd.stderr != null) {
        seStr = " ± " + Number(cd.stderr).toFixed(fmt);
      }
    } else if (typeof cd === "number" && cd > 0) {
      seStr = " ± " + Number(cd).toFixed(fmt);
    } else if (cd && typeof cd === "object" && cd.stderr != null && cd.stderr > 0) {
      seStr = " ± " + Number(cd.stderr).toFixed(fmt);
    }
  }

  let scoreBody;
  if (isAggregateSelection(sel)) {
    const unit = isMacroSelection() ? "categories" : "tasks";
    const countStr = cd && typeof cd === "object" ? cd.count : cd;
    scoreBody = "Average: " + scoreStr + seStr + (countStr != null ? " (" + countStr + " " + unit + ")" : "");
  } else if (sel.startsWith("__group__") && pt.data.name) {
    scoreBody = pt.data.name + ": " + scoreStr + seStr;
  } else {
    scoreBody = "Score: " + scoreStr + seStr;
  }

  let title = String(pt.x);
  let meta = "", body = scoreBody, footer = "";
  const modelDir = cd && typeof cd === "object" ? cd.modelDir : null;
  if (modelDir) {
    const info = state.DATA.model_info?.[modelDir];
    if (info && info.description) {
      const params = state.DATA.model_parameters?.[modelDir];
      const paramsPart = params ? (params < 1 ? `${Math.round(params * 1000)}M parameters` : `${params}B parameters`) : "";
      const licensePart = info.license ? `License: ${info.license}` : "";
      title = getModelLabel(modelDir);
      meta = [paramsPart, licensePart, getModelOpenLabel(modelDir)].filter(Boolean).join("  ·  ");
      body = info.description;
      footer = scoreBody;
    }
  }
  showTooltip(data.event, title, body, footer, meta);
}

// ─────────────────────────────────────────────────────────────
// Chart rendering
// ─────────────────────────────────────────────────────────────

function renderChart() {
  const sel = state.currentTaskSelection;

  // Metric selector
  if (isAggregateSelection(sel)) {
    hideMetricSelector();
  } else if (sel.startsWith("__group__")) {
    const g = state.DATA.task_groups[sel.slice(9)];
    if (g) populateMetricSelector(g.benchmarks);
  } else if (state.metricsSetup[sel]) {
    populateMetricSelector([sel]);
  }

  updateDescription();

  if (isAggregateSelection(sel)) renderAggregateBarChart();
  else if (sel.startsWith("__group__")) renderGroupedBarChart(sel.slice(9));
  else renderSingleBenchmarkBarChart(sel);

  urlState.save();
}

function renderAggregateBarChart() {
  const modelNames = getModelList();
  const labels = modelNames.map(getModelLabel);
  const colors = modelNames.map(getModelColor);
  const scores = [], taskCounts = [], aggStderrs = [];

  const needAllRaw = ["minmax", "zscore", "percentile"].includes(state.currentNormalization);
  const wantSE = (state.showStderr || state.showPromptDeviation) && isStderrCompatible();
  const macro = isMacroSelection();

  for (const m of modelNames) {
    const result = aggregateScores(state.checkedTasks, (bench) => {
      const raw = getScore(state.DATA.models, m, bench, state.currentShot);
      if (raw === undefined) return undefined;
      const allRaw = needAllRaw
        ? modelNames.map((mm) => getScore(state.DATA.models, mm, bench, state.currentShot)).filter((v) => v !== undefined)
        : null;
      const score = applyNorm(raw, bench, allRaw);
      const se = wantSE ? scaleStderr(getCombinedSE(state.DATA.models, m, bench, state.currentShot), bench, undefined, allRaw) : undefined;
      return { score, stderr: se };
    }, macro);
    scores.push(result ? result.score : 0);
    taskCounts.push(result ? result.count : 0);
    aggStderrs.push(result ? result.stderr : 0);
  }

  const fmt = state.currentNormalization === "zscore" ? 2 : 1;
  const trace = {
    x: labels, y: scores, type: "bar",
    marker: { color: colors, line: { width: 0 } },
    customdata: taskCounts.map((c, i) => ({ count: c, stderr: aggStderrs[i], modelDir: modelNames[i] })),
    hoverinfo: "none",
  };
  if (wantSE) {
    trace.error_y = {
      type: "data", array: aggStderrs, visible: true,
      color: "rgba(0,0,0,0.35)", thickness: 1.5, width: 4,
    };
  }

  const avgLabel = macro ? "category average" : "task average";
  const yRange = computeAggregateYRange(state.checkedTasks);
  const layout = getPlotlyLayout({
    title: { text: getAggregateLabel() + " – " + avgLabel + " (" + state.currentShot + "-shot)", font: { size: 16 } },
    yaxis: { title: getNormYLabel(), range: yRange, showgrid: false, zeroline: state.currentNormalization === "zscore" },
    xaxis: { title: "", tickangle: computeTickAngle(labels), showgrid: false },
    showlegend: false,
    margin: { l: 60, r: 20, t: 50, b: 100 },
    annotations: labels.map((label, i) => ({
      x: label, y: scores[i] + (wantSE ? (aggStderrs[i] || 0) : 0),
      text: scores[i].toFixed(fmt), showarrow: false, yshift: 10,
      xanchor: "center",
      font: { size: computeAnnotationFontSize(labels.length) },
    })),
  });
  plotChart([trace], layout, plotlyConfig, onChartHover, hideTooltip);
}

function renderGroupedBarChart(groupName) {
  const group = state.DATA.task_groups[groupName];
  if (!group) return;
  const metric = getEffectiveMetric(group.benchmarks[0]);
  const modelNames = getModelList();
  const labels = modelNames.map(getModelLabel);
  const bench0 = group.benchmarks[0];
  const useNorm = state.currentNormalization !== "none";
  const needAllRaw = ["minmax", "zscore", "percentile"].includes(state.currentNormalization);
  const wantSE = (state.showStderr || state.showPromptDeviation) && isStderrCompatible();
  const fmt = state.currentNormalization === "zscore" ? 2 : 1;
  const groupValuesArr = [], groupSeArrs = [];

  const dataTraces = group.benchmarks.map((bench, i) => {
    const allRaw = needAllRaw
      ? modelNames.map((mm) => getScore(state.DATA.models, mm, bench, state.currentShot, metric)).filter((v) => v !== undefined)
      : null;
    const values = modelNames.map((m) => {
      const raw = getScore(state.DATA.models, m, bench, state.currentShot, metric);
      if (raw == null) return null;
      return useNorm ? applyNorm(raw, bench, allRaw, metric) : toDisplayScale(raw, bench, metric);
    });
    const seValues = wantSE ? modelNames.map((m) => {
      const se = getCombinedSE(state.DATA.models, m, bench, state.currentShot, metric);
      return scaleStderr(se, bench, metric, allRaw);
    }) : null;
    const barColors = modelNames.map((m) => {
      const base = getModelColor(m);
      return i === 0 ? base : darkenColor(base, 0.3);
    });
    const seArr = seValues ? seValues.map((v) => v || 0) : null;
    const trace = {
      x: labels, y: values, name: group.labels[i], type: "bar",
      legendgroup: group.labels[i], offsetgroup: String(i),
      marker: { color: barColors, line: { width: 0 } },
      customdata: modelNames.map((m, j) => ({ stderr: seValues ? seValues[j] : null, modelDir: m })),
      hoverinfo: "none", showlegend: true,
    };
    if (wantSE && seArr) {
      trace.error_y = { type: "data", array: seArr, visible: true,
        color: "rgba(0,0,0,0.35)", thickness: 1.5, width: 4 };
    }
    groupValuesArr.push(values);
    groupSeArrs.push(seArr);
    return trace;
  });

  const yLabel = useNorm ? getNormYLabel() : getMetricYLabel(bench0, metric);
  let yRange;
  if (useNorm) {
    const vals = [];
    for (const shot of ALL_SHOTS) {
      for (const bench of group.benchmarks) {
        const raws = modelNames.map((m) => getScore(state.DATA.models, m, bench, shot, metric)).filter((v) => v !== undefined);
        for (const raw of raws) vals.push(applyNorm(raw, bench, needAllRaw ? raws : null, metric));
      }
    }
    yRange = computeYRange(vals);
  } else {
    yRange = [0, computeRawYMax_display(group.benchmarks, metric)];
  }
  const nGroups = groupValuesArr.length;
  const barWidth = 0.8 / nGroups;
  const annotations = [];
  labels.forEach((_, catIdx) => {
    groupValuesArr.forEach((values, gi) => {
      if (values[catIdx] == null) return;
      const se = (wantSE && groupSeArrs[gi]) ? groupSeArrs[gi][catIdx] : 0;
      annotations.push({
        x: catIdx + (gi - (nGroups - 1) / 2) * barWidth,
        y: values[catIdx] + se,
        text: values[catIdx].toFixed(fmt),
        showarrow: false, yshift: 10,
        xanchor: "center",
        font: { size: computeAnnotationFontSize(labels.length * nGroups) },
      });
    });
  });
  const layout = getPlotlyLayout({
    title: { text: groupName + " (" + state.currentShot + "-shot)", font: { size: 16 } },
    yaxis: { title: yLabel, range: yRange, showgrid: false, zeroline: state.currentNormalization === "zscore" },
    xaxis: { tickangle: computeTickAngle(labels), showgrid: false },
    barmode: "group",
    margin: { l: 60, r: 20, t: 50, b: 100 },
    legend: { orientation: "h", x: 0.01, y: 0.99, xanchor: "left", yanchor: "bottom",
              bgcolor: "rgba(255,255,255,0.8)", bordercolor: "#e2e8f0", borderwidth: 1 },
    annotations,
  });
  plotChart(dataTraces, layout, plotlyConfig, onChartHover, hideTooltip);
}

function renderSingleBenchmarkBarChart(benchmark) {
  const info = state.metricsSetup[benchmark];
  if (!info) return;
  const metric = getEffectiveMetric(benchmark);
  const modelNames = getModelList();
  const labels = modelNames.map(getModelLabel);
  const colors = modelNames.map(getModelColor);
  const allRaw = (state.currentNormalization !== "none")
    ? modelNames.map((mm) => getScore(state.DATA.models, mm, benchmark, state.currentShot, metric)).filter((v) => v !== undefined)
    : null;
  const values = modelNames.map((m) => {
    const raw = getScore(state.DATA.models, m, benchmark, state.currentShot, metric);
    if (raw == null) return null;
    return state.currentNormalization === "none"
      ? toDisplayScale(raw, benchmark, metric)
      : applyNorm(raw, benchmark, allRaw, metric);
  });

  const wantSE = (state.showStderr || state.showPromptDeviation) && isStderrCompatible();
  const seValues = wantSE ? modelNames.map((m) => {
    const se = getCombinedSE(state.DATA.models, m, benchmark, state.currentShot, metric);
    return scaleStderr(se, benchmark, metric, allRaw);
  }) : null;

  const yRange = computeSingleYRange(benchmark, metric);
  const yLabel = state.currentNormalization === "none" ? getMetricYLabel(benchmark, metric) : getNormYLabel();
  const fmt = state.currentNormalization === "zscore" ? 2 : 1;
  const seArr = seValues ? seValues.map((v) => v || 0) : null;
  const trace = {
    x: labels, y: values, type: "bar",
    marker: { color: colors, line: { width: 0 } },
    customdata: modelNames.map((m, i) => ({ stderr: seValues ? seValues[i] : null, modelDir: m })),
    hoverinfo: "none",
  };
  if (wantSE && seArr) {
    trace.error_y = { type: "data", array: seArr, visible: true,
      color: "rgba(0,0,0,0.35)", thickness: 1.5, width: 4 };
  }
  const layout = getPlotlyLayout({
    title: { text: info.pretty_name + " (" + state.currentShot + "-shot)", font: { size: 16 } },
    yaxis: { title: yLabel, range: yRange, showgrid: false, zeroline: state.currentNormalization === "zscore" },
    xaxis: { tickangle: computeTickAngle(labels), showgrid: false },
    showlegend: false,
    margin: { l: 60, r: 20, t: 50, b: 100 },
    annotations: labels.map((label, i) => ({
      x: label, y: (values[i] || 0) + (wantSE && seArr ? (seArr[i] || 0) : 0),
      text: values[i] != null ? values[i].toFixed(fmt) : "",
      showarrow: false, yshift: 10,
      xanchor: "center",
      font: { size: computeAnnotationFontSize(labels.length) },
    })),
  });
  plotChart([trace], layout, plotlyConfig, onChartHover, hideTooltip);
}

// ─────────────────────────────────────────────────────────────
// Y-range helpers
// ─────────────────────────────────────────────────────────────

const ALL_SHOTS = ["0", "1", "5"];

function computeAggregateYRange(benchmarks) {
  const allAvgs = [];
  const needAllRaw = ["minmax", "zscore", "percentile"].includes(state.currentNormalization);
  const macro = isMacroSelection();
  const modelNames = Object.keys(state.DATA.models).filter((e) => checkedModels.has(e) && isModelInSizeRange(e));
  for (const entity of Object.keys(state.DATA.models)) {
    if (!checkedModels.has(entity) || !isModelInSizeRange(entity)) continue;
    const result = aggregateScores(benchmarks, (bench) => {
      const raw = getScore(state.DATA.models, entity, bench, state.currentShot);
      if (raw === undefined) return undefined;
      if (needAllRaw) {
        const allRaw = modelNames.map((mm) => getScore(state.DATA.models, mm, bench, state.currentShot)).filter((v) => v !== undefined);
        return applyNorm(raw, bench, allRaw);
      }
      return applyNorm(raw, bench, null);
    }, macro);
    if (result) allAvgs.push(result.score);
  }
  return computeYRange(allAvgs);
}

function computeRawYMax_display(benchmarks, metric) {
  const vals = [];
  for (const entity of Object.keys(state.DATA.models)) {
    if (!checkedModels.has(entity) || !isModelInSizeRange(entity)) continue;
    for (const bench of benchmarks) {
      const v = getScore(state.DATA.models, entity, bench, state.currentShot, metric);
      if (v != null) vals.push(toDisplayScale(v, bench, metric));
    }
  }
  if (!vals.length) return 100;
  const mx = Math.max(...vals);
  return Math.min(mx + Math.max(mx * 0.15, 2), 115);
}

function computeSingleYRange(benchmark, metric) {
  const vals = [];
  const entities = Object.keys(state.DATA.models).filter((e) => checkedModels.has(e) && isModelInSizeRange(e));
  const raws = entities.map((e) => getScore(state.DATA.models, e, benchmark, state.currentShot, metric))
    .filter((v) => v !== undefined);
  for (const raw of raws) {
    if (state.currentNormalization === "none") vals.push(toDisplayScale(raw, benchmark, metric));
    else vals.push(applyNorm(raw, benchmark, raws, metric));
  }
  return computeYRange(vals);
}

// ─────────────────────────────────────────────────────────────
// Description / labels
// ─────────────────────────────────────────────────────────────

function getAggregateLabel() {
  const sel = state.currentTaskSelection;
  if (sel === "__all_macro__" || sel === "__all__") return "all tasks";
  if (sel === "__custom__") return state.checkedTasks.size + " tasks";
  if (sel.startsWith("__cat__")) return sel.slice(7);
  if (sel.startsWith("__eval__")) return sel.slice(8) + " tasks";
  if (sel === "__lang__nob") return "Bokmål tasks";
  if (sel === "__lang__nno") return "Nynorsk tasks";
  if (sel === "__lang__sme") return "Northern Sámi tasks";
  return "aggregate";
}

function getSubtaskDescription(benchmark, metric) {
  if (!metric || metric.indexOf(": ") === -1) return null;
  const info = state.metricsSetup[benchmark];
  if (!info || !info.subtasks) return null;
  const base = getBaseMetric(metric);
  const label = metric.slice(base.length + 2);
  for (const st of Object.values(info.subtasks)) {
    if (st.pretty_name === label) return st.description || null;
  }
  return null;
}

function updateDescription() {
  const descEl = document.getElementById("task-description");
  if (!descEl) return;
  const sel = state.currentTaskSelection;
  let desc = "", url = "", metricDesc = "";

  if (isAggregateSelection(sel)) {
    desc = getAggregateDescription();
  } else if (sel.startsWith("__group__")) {
    const g = state.DATA.task_groups[sel.slice(9)];
    if (g) {
      const info = state.metricsSetup[g.benchmarks[0]];
      if (info) {
        desc = info.description || "";
        url = info.url || "";
        const metric = getEffectiveMetric(g.benchmarks[0]);
        const metricName = METRIC_DISPLAY[metric] || metric;
        const baseMetric = getBaseMetric(metric);
        const subtaskDesc = getSubtaskDescription(g.benchmarks[0], metric);
        metricDesc = "Metric: " + metricName + ". " + (subtaskDesc || METRIC_DESCRIPTIONS[baseMetric] || METRIC_DESCRIPTIONS[metric] || "");
      }
    }
  } else if (state.metricsSetup[sel]) {
    desc = state.metricsSetup[sel].description || "";
    url = state.metricsSetup[sel].url || "";
    const metric = getEffectiveMetric(sel);
    const metricName = METRIC_DISPLAY[metric] || metric;
    const baseMetric = getBaseMetric(metric);
    const subtaskDesc = getSubtaskDescription(sel, metric);
    metricDesc = "Metric: " + metricName + ". " + (subtaskDesc || METRIC_DESCRIPTIONS[baseMetric] || METRIC_DESCRIPTIONS[metric] || "");
  }
  descEl.innerHTML = "";
  if (desc) {
    descEl.appendChild(document.createTextNode(desc));
    if (url) {
      descEl.appendChild(document.createElement("br"));
      const display = url.replace("https://huggingface.co/", "https://hf.co/");
      const link = document.createElement("a");
      link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
      link.textContent = display;
      link.style.color = "var(--accent)";
      descEl.appendChild(link);
    }
    if (metricDesc) {
      const span = document.createElement("span");
      span.className = "metric-description";
      span.textContent = metricDesc;
      descEl.appendChild(span);
    }
  }
  descEl.style.display = desc ? "block" : "none";
}

function getAggregateDescription() {
  const sel = state.currentTaskSelection;
  const count = sel === "__custom__" ? state.checkedTasks.size : getBenchmarksForSelection(sel).filter((b) => state.checkedTasks.has(b)).length;
  const macro = isMacroSelection();
  let scope = "";
  if (sel === "__all_macro__") {
    const cats = new Set();
    for (const b of state.checkedTasks) {
      const info = state.metricsSetup[b];
      if (info) cats.add(info.category);
    }
    scope = "all " + count + " tasks (" + cats.size + " categories, category average)";
  } else if (sel === "__all__") scope = "all " + count + " tasks (task average)";
  else if (sel === "__custom__") scope = count + " selected tasks (task average)";
  else if (sel.startsWith("__cat__")) scope = count + " tasks in the \"" + sel.slice(7) + "\" category";
  else if (sel.startsWith("__eval__")) scope = count + " " + sel.slice(8) + " tasks";
  else if (sel === "__lang__nob") scope = count + " Bokmål tasks";
  else if (sel === "__lang__nno") scope = count + " Nynorsk tasks";
  else if (sel === "__lang__sme") scope = count + " Northern Sámi tasks";

  const avgDesc = macro
    ? "Scores are first averaged within each task category, then averaged across categories. This gives equal weight to each category regardless of how many tasks it contains. "
    : "";
  const normDescs = {
    none: "Scores are shown on their native metric scales without normalization, then averaged.",
    baseline: "Each task score is normalized to a 0–100 scale where 0 = random baseline performance and 100 = perfect score, then averaged across tasks. This accounts for different chance levels across tasks (e.g. 25% for 4-choice QA vs. 50% for binary classification).",
    minmax: "Each task score is normalized to 0–100 using the minimum and maximum scores observed across all models for that task, then averaged. This shows relative performance within the evaluated model set.",
    zscore: "Each task score is converted to a z-score (number of standard deviations from the mean across models), then averaged. This gives equal weight to all tasks regardless of score spread.",
    percentile: "Each task score is converted to a percentile rank (0 = worst model, 100 = best model) across all evaluated models, then averaged.",
  };
  const normDesc = normDescs[state.currentNormalization] || "";
  return "Aggregate score across " + scope + ". " + avgDesc + normDesc;
}
