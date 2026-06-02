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
  getScore, getCombinedCI, scaleCIDistances, applyNorm, toDisplayScale,
  getBaseMetric, getNormYLabel, getMetricYLabel,
  aggregateScores, isAggregateSelection, isMacroSelection,
  getEffectiveMetric, isStderrCompatible, formatTitleWithShot,
} from "./core.js";
import {
  darkenColor, makePlotlyConfig, getPlotlyLayout, plotChart,
  computeTickAngle, computeAnnotationFontSize, computeYRange,
} from "./chart.js";
import {
  showTooltip, hideTooltip, attachTooltip, populateMetricSelector, hideMetricSelector,
  buildTaskCheckboxes, syncTaskCheckboxStates, bindModuleActionStopPropagation,
  attachControlTooltips, markAppReady,
} from "./ui.js";
import { UrlState } from "./url-state.js";

let CFG = null;            // Dashboard configuration (set in initComparison)
let plotlyConfig = null;   // Built from CFG.filenamePrefix
let urlState = null;

// Org → local logo filename (all stored white in docs/shared/logos/).
// Files in this folder are downloaded copies — no runtime network
// dependency. All 18 orgs in the dataset are now covered.
const ORG_LOGO = {
  "Google": "google.png",
  "Meta": "meta.png",
  "Mistral AI": "mistral.png",
  "Alibaba": "qwen.png",
  "AI Sweden": "ai_sweden.png",
  "Allen AI": "allen_ai.png",
  "SpeakLeash": "bielik.png",
  "Cohere Labs": "cohere.png",
  "DFM": "dfm.png",
  "DeepSeek AI": "deepseek.png",
  "EuroLLM": "eurollm.png",
  "LTG/UiO": "uio.png",
  "Nasjonalbiblioteket": "nb.png",
  "NorwAI/NTNU": "ntnu.png",
  "NVIDIA": "nvidia.png",
  "SILO AI": "silo_ai.png",
  "Swiss AI": "swiss_ai.png",
  "Z.ai": "zai.png",
};
// Optional per-org size multiplier (1.0 = default). Useful for logos with
// thin/detailed designs (e.g. coats of arms) that read visually smaller
// than bolder marks at the same Plotly box size.
const ORG_LOGO_SCALE = {
  // Wide-and-short text logo — after square-padding it has more vertical
  // breathing room than the other (roughly square) marks, so bump up a bit.
  "LTG/UiO": 1.15,
};

/** Plotly layout.images entries: one white logo per model at the bar's
 *  bottom, positioned via data-x + paper-y (so the vertical placement
 *  stays a fixed fraction of the chart height regardless of y-axis range). */
function buildOrgImages(modelNames, xPositions, xOffset) {
  return modelNames.map((modelDir, i) => {
    const org = state.DATA.model_organizations?.[modelDir];
    const filename = org && ORG_LOGO[org];
    if (!filename) return null;
    const scale = (org && ORG_LOGO_SCALE[org]) || 1;
    return {
      source: `../shared/logos/${filename}`,
      xref: "x", yref: "paper",
      x: xPositions[i] + (xOffset || 0),
      // yanchor:middle + y:0.05 puts the box's vertical centre at ~5% of
      // chart height above the axis. With sizing:"contain", the logo
      // (PNGs now square-padded at 85% fill — matching SVG safe-area)
      // is centred in the box, so the logo's vertical centre lands at
      // exactly that point regardless of which dimension constrains it.
      y: 0.04,
      sizex: 0.5 * scale, sizey: 0.05 * scale,
      xanchor: "center", yanchor: "middle",
      sizing: "contain",
      layer: "above",
    };
  }).filter(Boolean);
}

/** Plotly layout.images entries for scatter mode: one logo per model placed
 *  at its (size, score) point. xref:"x" on a log axis expects coordinates
 *  in log10 space (not raw data), so we convert here. yref:"paper" with
 *  score converted to a paper fraction keeps logos a consistent visual size
 *  regardless of how tight the y-range is. */
function buildScatterOrgImages(modelDirs, xs, paperYs) {
  return modelDirs.map((modelDir, i) => {
    const org = state.DATA.model_organizations?.[modelDir];
    const filename = org && ORG_LOGO[org];
    if (!filename) return null;
    const scale = (org && ORG_LOGO_SCALE[org]) || 1;
    return {
      source: `../shared/logos/${filename}`,
      xref: "x", yref: "paper",
      x: Math.log10(xs[i]), y: paperYs[i],
      // Sized to fit inside the 32px (single/aggregate) / 24px (grouped)
      // scatter markers. sizex is in log10 units (≈ 0.045 ≈ 2% of plot
      // width on the 1–150B range); sizey is a paper-height fraction.
      sizex: 0.045 * scale, sizey: 0.045 * scale,
      xanchor: "center", yanchor: "middle",
      sizing: "contain",
      layer: "above",
    };
  }).filter(Boolean);
}

/** SVG data URL for a colored disk with a white outline — the per-marker
 *  background that lives alongside each logo in layout.images. */
function coloredDiskDataUrl(color) {
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
    + `<circle cx='32' cy='32' r='30' fill='${color}' stroke='white' stroke-width='2'/>`
    + "</svg>";
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

/** Interleaved layout.images: [disk_0, logo_0, disk_1, logo_1, …].
 *  Plotly paints layout.images in array order, so interleaving per model
 *  means each model's disk+logo paint as a unit — later models cleanly
 *  cover earlier ones when they overlap, rather than all logos painting
 *  on top of all disks.
 *  Returns { images, imageToModel } where imageToModel[i] is the model
 *  index that image i belongs to — needed at hover time so scaling
 *  affects only the hovered model's images, not nearby ones. */
function buildScatterCompositeImages(modelDirs, xs, paperYs, colors) {
  const images = [];
  const imageToModel = [];
  for (let i = 0; i < modelDirs.length; i++) {
    const x = Math.log10(xs[i]);
    const y = paperYs[i];
    images.push({
      source: coloredDiskDataUrl(colors[i]),
      xref: "x", yref: "paper",
      x, y,
      sizex: 0.07, sizey: 0.065,
      xanchor: "center", yanchor: "middle",
      sizing: "contain",
      layer: "above",
    });
    imageToModel.push(i);
    const org = state.DATA.model_organizations?.[modelDirs[i]];
    const filename = org && ORG_LOGO[org];
    if (filename) {
      const scale = (org && ORG_LOGO_SCALE[org]) || 1;
      images.push({
        source: `../shared/logos/${filename}`,
        xref: "x", yref: "paper",
        x, y,
        sizex: 0.045 * scale, sizey: 0.045 * scale,
        xanchor: "center", yanchor: "middle",
        sizing: "contain",
        layer: "above",
      });
      imageToModel.push(i);
    }
  }
  return { images, imageToModel };
}

// Comparison-specific state (not in shared/state.js). These are overwritten
// by the dashboard's initComparison() defaults before first render.
let currentSizeMin = 6;
let currentSizeMax = 24;
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
    defaultSizeMin: 6,
    defaultSizeMax: 24,
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

    // If `task` was specified in the URL but `tasks` was not, derive checkedTasks
    // from the task selection (mirrors the dropdown change handler). Without
    // this, checkedTasks stays at the initial "all tasks" value, which both
    // shows wrong results and pollutes the URL with an explicit tasks= list on
    // the next save.
    if (urlState.has("task") && !urlState.has("tasks")) {
      const benchmarks = getBenchmarksForSelection(state.currentTaskSelection);
      if (benchmarks.length > 0) state.checkedTasks = new Set(benchmarks);
    }

    // Sync UI controls
    populateTaskDropdown();
    bindEventListeners();
    buildCheckboxes();
    buildModelCheckboxes();
    bindModuleActionStopPropagation();
    attachControlTooltips();

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
      syncModelCheckboxStates();
      updateRangeSliderUI();
      const fo = document.getElementById("fully-open-toggle");
      if (fo) fo.checked = fullyOpenOnly;
    }

    renderChart();
    markAppReady();
  } catch (err) {
    console.error("init failed:", err);
    const el = document.getElementById("chart");
    if (el) el.innerHTML = "<pre style='color:red;padding:1rem;'>" + err.stack + "</pre>";
    markAppReady();
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
    catGroup.label = "Aggregate by category";
    for (const catName of Object.keys(categories).sort()) {
      const opt = document.createElement("option");
      opt.value = "__cat__" + catName;
      opt.textContent = capitalize(catName);
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
      evalGroup.label = "Aggregate by evaluation type";
      for (const etName of Object.keys(evalTypes).sort()) {
        const opt = document.createElement("option");
        opt.value = "__eval__" + etName;
        opt.textContent = capitalize(etName);
        evalGroup.appendChild(opt);
      }
      select.appendChild(evalGroup);
    }
  }

  if (CFG.enableLanguageGroups) {
    const langGroup = document.createElement("optgroup");
    langGroup.label = "Aggregate by language";
    for (const [val, label] of [["__lang__nob", "Bokmål"], ["__lang__nno", "Nynorsk"], ["__lang__sme", "Northern Sámi"]]) {
      const opt = document.createElement("option");
      opt.value = val; opt.textContent = label;
      langGroup.appendChild(opt);
    }
    select.appendChild(langGroup);
  }

  const taskGroup = document.createElement("optgroup");
  taskGroup.label = "Individual tasks";
  const entries = [];
  if (CFG.enableTaskGroups && state.DATA.task_groups) {
    for (const groupName of Object.keys(state.DATA.task_groups)) {
      entries.push({ value: "__group__" + groupName, label: capitalize(groupName) });
    }
  }
  const standalones = state.DATA.standalone_benchmarks || Object.keys(state.metricsSetup);
  for (const bench of standalones) {
    const info = state.metricsSetup[bench];
    if (info) entries.push({ value: bench, label: capitalize(info.pretty_name) });
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
  // Labels are absolutely positioned inside the slider, centred on each
  // thumb via translateX(-50%) in style.css — set their `left` here.
  const minLabel = document.getElementById("size-min-label");
  const maxLabel = document.getElementById("size-max-label");
  if (minLabel) { minLabel.style.left = pctMin + "%"; minLabel.textContent = currentSizeMin + "B"; }
  if (maxLabel) { maxLabel.style.left = pctMax + "%"; maxLabel.textContent = currentSizeMax + "B"; }
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

/** Populate (or clear) the HTML chart legend in the Model-size controls bar.
 *  Pass an array of {name, color} entries to render the legend; pass [] to clear.
 *  CSS hides the element automatically when empty. */
function updateChartLegend(entries) {
  const el = document.getElementById("chart-legend");
  if (!el) return;
  el.innerHTML = "";
  for (const e of entries || []) {
    const item = document.createElement("span");
    item.className = "legend-item";
    const dot = document.createElement("span");
    dot.className = "legend-dot";
    dot.style.backgroundColor = e.color;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(e.name));
    el.appendChild(item);
  }
}

/** Numeric x positions for the models — uniformly spaced (1 unit apart).
 *  Previously this added extra spacing between different organizations, but
 *  the user found that visually confusing. Kept as a separate function so
 *  per-org spacing can be re-introduced cheaply if desired. */
function computeOrgXPositions(modelNames) {
  return modelNames.map((_, i) => i);
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
        // Each model is a <details>; click the name to expand its description
        // and metadata. Checkbox click stops propagation so it doesn't toggle.
        const item = document.createElement("details");
        item.className = "model-item";
        item.dataset.model = modelDir;

        const summary = document.createElement("summary");
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = checkedModels.has(modelDir);
        cb.dataset.model = modelDir;
        cb.addEventListener("change", () => {
          if (cb.checked) checkedModels.add(modelDir);
          else checkedModels.delete(modelDir);
          syncModelCheckboxStates();
          renderChart();
        });
        cb.addEventListener("click", (e) => e.stopPropagation());

        const dot = document.createElement("span");
        dot.className = "model-color-dot";
        dot.style.backgroundColor = getModelColor(modelDir);

        const nameSpan = document.createElement("span");
        nameSpan.className = "model-name";
        nameSpan.textContent = getModelLabel(modelDir);

        summary.appendChild(cb);
        summary.appendChild(dot);
        summary.appendChild(nameSpan);
        item.appendChild(summary);

        // Description body
        const info = state.DATA.model_info?.[modelDir];
        const desc = document.createElement("div");
        desc.className = "model-description-inline";
        if (info) {
          const params = state.DATA.model_parameters?.[modelDir];
          const paramsPart = params
            ? (params < 1 ? `${Math.round(params * 1000)}M parameters` : `${params}B parameters`)
            : "";
          const licensePart = info.license ? `License: ${info.license}` : "";
          const meta = [paramsPart, licensePart, getModelOpenLabel(modelDir)].filter(Boolean).join("  ·  ");
          if (meta) {
            const metaEl = document.createElement("span");
            metaEl.className = "meta";
            metaEl.textContent = meta;
            desc.appendChild(metaEl);
          }
          if (info.description) desc.appendChild(document.createTextNode(info.description));
          if (info.huggingface_url) {
            if (info.description) desc.appendChild(document.createElement("br"));
            const a = document.createElement("a");
            a.href = info.huggingface_url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = info.huggingface_url.replace("https://huggingface.co/", "hf.co/");
            desc.appendChild(a);
          }
        }
        item.appendChild(desc);
        orgDiv.appendChild(item);
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

  let ciStr = "";
  if (state.showStderr && cd != null && typeof cd === "object" && cd.ci) {
    const v = Number(pt.y);
    const lo = v - (cd.ci.loDist ?? 0), hi = v + (cd.ci.hiDist ?? 0);
    if ((cd.ci.loDist ?? 0) > 0 || (cd.ci.hiDist ?? 0) > 0) {
      ciStr = ` (95% CI: ${Number(lo).toFixed(fmt)} – ${Number(hi).toFixed(fmt)})`;
    }
  }

  let scoreBody;
  if (isAggregateSelection(sel)) {
    const unit = isMacroSelection() ? "categories" : "tasks";
    const countStr = cd && typeof cd === "object" ? cd.count : cd;
    scoreBody = "Average: " + scoreStr + ciStr + (countStr != null ? " (" + countStr + " " + unit + ")" : "");
  } else if (sel.startsWith("__group__") && pt.data.name) {
    scoreBody = pt.data.name + ": " + scoreStr + ciStr;
  } else {
    scoreBody = "Score: " + scoreStr + ciStr;
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

  updateChartTitle();

  // When the user fully opens the size range, the bar chart would squeeze
  // 70+ models into illegible 1–2 pixel bars; switch to a scatter plot
  // with model size on a log x-axis so each model becomes a distinct point.
  const useScatter = isFullSizeRange();

  if (isAggregateSelection(sel)) {
    if (useScatter) renderAggregateScatter();
    else renderAggregateBarChart();
  } else if (sel.startsWith("__group__")) {
    if (useScatter) renderGroupedScatter(sel.slice(9));
    else renderGroupedBarChart(sel.slice(9));
  } else {
    if (useScatter) renderSingleBenchmarkScatter(sel);
    else renderSingleBenchmarkBarChart(sel);
  }

  urlState.save();
}

/** True when the user has fully opened the size-range slider — the cue we
 *  use to switch from per-model bars to a size-vs-score scatter plot. */
function isFullSizeRange() {
  return currentSizeMin <= CFG.sizeRangeMin && currentSizeMax >= CFG.sizeRangeMax;
}

/** Convert a y-data value to a paper-fraction (for image positioning). */
function paperFraction(y, yRange) {
  const [lo, hi] = yRange;
  if (hi === lo) return 0.5;
  return (y - lo) / (hi - lo);
}

/** Shared scatter-plot setup: filter models down to those with a known size
 *  and a non-null score, return parallel arrays + per-model colors. The
 *  scoreFn may return any extra fields (e.g. count for aggregate hover);
 *  they're collected into a parallel `extras` array. */
function collectScatterPoints(modelNames, scoreFn) {
  const xs = [], ys = [], dirs = [], colors = [], cis = [], extras = [];
  for (const m of modelNames) {
    const size = state.DATA.model_parameters?.[m];
    if (!size) continue;            // can't place models without a known size
    const res = scoreFn(m);
    if (res == null || res.score == null) continue;
    xs.push(size);
    ys.push(res.score);
    cis.push(res.ci || null);
    dirs.push(m);
    colors.push(getModelColor(m));
    const { score, ci, ...rest } = res;
    extras.push(rest);
  }
  return { xs, ys, dirs, colors, cis, extras };
}

function scatterXAxis() {
  return {
    type: "log",
    range: [Math.log10(CFG.sizeRangeMin), Math.log10(CFG.sizeRangeMax)],
    automargin: false,
    title: { text: "Model size (B parameters)", font: { size: 13, color: "#64748b" }, standoff: 12 },
    showgrid: true, gridcolor: "#d8dce3",
    tickvals: [1, 3, 10, 30, 100],
    ticktext: ["1B", "3B", "10B", "30B", "100B"],
  };
}

function renderAggregateBarChart() {
  updateChartLegend([]);
  const modelNames = getModelList();
  const labels = modelNames.map(getModelLabel);
  const colors = modelNames.map(getModelColor);
  const scores = [], taskCounts = [], aggCIs = [];

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
      const ci = wantSE ? scaleCIDistances(getCombinedCI(state.DATA.models, m, bench, state.currentShot), bench, undefined, allRaw) : undefined;
      return { score, ci };
    }, macro);
    scores.push(result ? result.score : 0);
    taskCounts.push(result ? result.count : 0);
    aggCIs.push(result ? result.ci : null);
  }

  const xPositions = computeOrgXPositions(modelNames);
  const xRange = xPositions.length
    ? [xPositions[0] - 0.6, xPositions[xPositions.length - 1] + 0.5]
    : null;
  const fmt = state.currentNormalization === "zscore" ? 2 : 1;
  const trace = {
    x: xPositions, y: scores, type: "bar",
    width: 0.85,
    marker: { color: colors, line: { width: 0 }, cornerradius: 6 },
    customdata: taskCounts.map((c, i) => ({ count: c, ci: aggCIs[i], modelDir: modelNames[i] })),
    hoverinfo: "none",
  };
  if (wantSE) {
    trace.error_y = {
      type: "data", symmetric: false,
      array: aggCIs.map((c) => c?.hiDist ?? 0),
      arrayminus: aggCIs.map((c) => c?.loDist ?? 0),
      visible: true,
      color: "rgba(0,0,0,0.5)", thickness: 2.4, width: 5,
    };
  }

  const yRange = computeAggregateYRange(state.checkedTasks);
  const layout = getPlotlyLayout({
    yaxis: {
      title: "", range: yRange,
      showgrid: true, gridcolor: "#d4d8dd", automargin: false, ticks: "", ticklen: 0,
      zeroline: state.currentNormalization === "zscore",
    },
    xaxis: { automargin: false,
      title: "",
      range: xRange,
      tickvals: xPositions, ticktext: labels,
      tickangle: computeTickAngle(labels),
      showgrid: false,
    },
    showlegend: false,
    margin: { l: 105, r: 4, t: 8, b: 100 },
    annotations: labels.map((label, i) => ({
      x: xPositions[i], y: scores[i] + (wantSE ? (aggCIs[i]?.hiDist ?? 0) : 0),
      text: scores[i].toFixed(fmt), showarrow: false, yshift: 10,
      xanchor: "center",
      font: { size: computeAnnotationFontSize(labels.length), color: "#000", weight: 500 },
    })),
    images: buildOrgImages(modelNames, xPositions),
  });
  layout._annAnim = labels.map((_, i) => ({
    score: scores[i], se: wantSE ? (aggCIs[i]?.hiDist ?? 0) : 0,
  }));
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

  const xPositions = computeOrgXPositions(modelNames);
  const xRange = xPositions.length
    ? [xPositions[0] - 0.6, xPositions[xPositions.length - 1] + 0.5]
    : null;
  const nBars = group.benchmarks.length;
  const totalGroupWidth = 0.85;
  const barWidth = totalGroupWidth / nBars;

  const dataTraces = group.benchmarks.map((bench, i) => {
    const allRaw = needAllRaw
      ? modelNames.map((mm) => getScore(state.DATA.models, mm, bench, state.currentShot, metric)).filter((v) => v !== undefined)
      : null;
    const values = modelNames.map((m) => {
      const raw = getScore(state.DATA.models, m, bench, state.currentShot, metric);
      if (raw == null) return null;
      return useNorm ? applyNorm(raw, bench, allRaw, metric) : toDisplayScale(raw, bench, metric);
    });
    const ciValues = wantSE ? modelNames.map((m) => {
      const ci = getCombinedCI(state.DATA.models, m, bench, state.currentShot, metric);
      return scaleCIDistances(ci, bench, metric, allRaw);
    }) : null;
    const barColors = modelNames.map((m) => {
      const base = getModelColor(m);
      return i === 0 ? base : darkenColor(base, 0.3);
    });
    const hiArr = ciValues ? ciValues.map((c) => c?.hiDist ?? 0) : null;
    const loArr = ciValues ? ciValues.map((c) => c?.loDist ?? 0) : null;
    // Bar offset (relative to x): place sub-bars side-by-side, centered on x.
    const offset = -totalGroupWidth / 2 + i * barWidth;
    const trace = {
      x: xPositions, y: values, name: group.labels[i], type: "bar",
      width: barWidth, offset,
      marker: { color: barColors, line: { width: 0 }, cornerradius: 6 },
      customdata: modelNames.map((m, j) => ({ ci: ciValues ? ciValues[j] : null, modelDir: m })),
      hoverinfo: "none", showlegend: true,
    };
    if (wantSE && hiArr) {
      trace.error_y = { type: "data", symmetric: false,
        array: hiArr, arrayminus: loArr,
        visible: true,
        color: "rgba(0,0,0,0.5)", thickness: 2.4, width: 5 };
    }
    groupValuesArr.push(values);
    groupSeArrs.push(hiArr);  // used only for annotation y-offset (top of error bar)
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
  const annotations = [];
  const annAnim = [];
  labels.forEach((_, catIdx) => {
    groupValuesArr.forEach((values, gi) => {
      if (values[catIdx] == null) return;
      const se = (wantSE && groupSeArrs[gi]) ? groupSeArrs[gi][catIdx] : 0;
      // Centre of the i-th sub-bar in [-totalGroupWidth/2 … +totalGroupWidth/2]
      const subBarCentre = -totalGroupWidth / 2 + (gi + 0.5) * barWidth;
      annotations.push({
        x: xPositions[catIdx] + subBarCentre,
        y: values[catIdx] + se,
        text: values[catIdx].toFixed(fmt),
        showarrow: false, yshift: 10,
        xanchor: "center",
        font: { size: computeAnnotationFontSize(labels.length * nBars), color: "#000", weight: 500 },
      });
      annAnim.push({ score: values[catIdx], se: se || 0 });
    });
  });
  const layout = getPlotlyLayout({
    yaxis: {
      title: "", range: yRange,
      showgrid: true, gridcolor: "#d4d8dd", automargin: false, ticks: "", ticklen: 0,
      zeroline: state.currentNormalization === "zscore",
    },
    xaxis: { automargin: false,
      range: xRange,
      tickvals: xPositions, ticktext: labels,
      tickangle: computeTickAngle(labels), showgrid: false,
    },
    margin: { l: 105, r: 4, t: 8, b: 100 },
    showlegend: false,
    annotations,
    images: buildOrgImages(modelNames, xPositions),
  });
  layout._annAnim = annAnim;
  // Populate the HTML legend in the Model-size controls bar.
  // Per-model bar colors vary; the legend uses a representative shade so the
  // viewer can see WHICH sub-bar (light vs darkened) is which label.
  const repColor = MODEL_COLORS[0];
  updateChartLegend(group.benchmarks.map((_, i) => ({
    name: group.labels[i],
    color: i === 0 ? repColor : darkenColor(repColor, 0.3),
  })));
  plotChart(dataTraces, layout, plotlyConfig, onChartHover, hideTooltip);
}

function renderSingleBenchmarkBarChart(benchmark) {
  updateChartLegend([]);
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
  const ciValues = wantSE ? modelNames.map((m) => {
    const ci = getCombinedCI(state.DATA.models, m, benchmark, state.currentShot, metric);
    return scaleCIDistances(ci, benchmark, metric, allRaw);
  }) : null;

  const yRange = computeSingleYRange(benchmark, metric);
  const yLabel = state.currentNormalization === "none" ? getMetricYLabel(benchmark, metric) : getNormYLabel();
  const fmt = state.currentNormalization === "zscore" ? 2 : 1;
  const hiArr = ciValues ? ciValues.map((c) => c?.hiDist ?? 0) : null;
  const loArr = ciValues ? ciValues.map((c) => c?.loDist ?? 0) : null;
  const xPositions = computeOrgXPositions(modelNames);
  const xRange = xPositions.length
    ? [xPositions[0] - 0.6, xPositions[xPositions.length - 1] + 0.5]
    : null;
  const trace = {
    x: xPositions, y: values, type: "bar",
    width: 0.85,
    marker: { color: colors, line: { width: 0 }, cornerradius: 6 },
    customdata: modelNames.map((m, i) => ({ ci: ciValues ? ciValues[i] : null, modelDir: m })),
    hoverinfo: "none",
  };
  if (wantSE && hiArr) {
    trace.error_y = { type: "data", symmetric: false,
      array: hiArr, arrayminus: loArr,
      visible: true,
      color: "rgba(0,0,0,0.5)", thickness: 2.4, width: 5 };
  }
  const layout = getPlotlyLayout({
    yaxis: {
      title: "", range: yRange,
      showgrid: true, gridcolor: "#d4d8dd", automargin: false, ticks: "", ticklen: 0,
      zeroline: state.currentNormalization === "zscore",
    },
    xaxis: { automargin: false,
      range: xRange,
      tickvals: xPositions, ticktext: labels,
      tickangle: computeTickAngle(labels), showgrid: false,
    },
    showlegend: false,
    margin: { l: 105, r: 4, t: 8, b: 100 },
    annotations: labels.map((label, i) => ({
      x: xPositions[i], y: (values[i] || 0) + (wantSE && hiArr ? (hiArr[i] || 0) : 0),
      text: values[i] != null ? values[i].toFixed(fmt) : "",
      showarrow: false, yshift: 10,
      xanchor: "center",
      font: { size: computeAnnotationFontSize(labels.length), color: "#000", weight: 500 },
    })),
    images: buildOrgImages(modelNames, xPositions),
  });
  layout._annAnim = labels.map((_, i) => ({
    score: values[i] || 0, se: wantSE && hiArr ? (hiArr[i] || 0) : 0,
  }));
  plotChart([trace], layout, plotlyConfig, onChartHover, hideTooltip);
}

// ─────────────────────────────────────────────────────────────
// Scatter rendering (used when size-range slider is fully open).
// Logos overlay invisible markers — the markers handle hover, the logos
// are the visible glyph.
// ─────────────────────────────────────────────────────────────

function renderAggregateScatter() {
  updateChartLegend([]);
  const modelNames = getModelList();
  const needAllRaw = ["minmax", "zscore", "percentile"].includes(state.currentNormalization);
  const wantSE = (state.showStderr || state.showPromptDeviation) && isStderrCompatible();
  const macro = isMacroSelection();

  const { xs, ys, dirs, colors, cis, extras } = collectScatterPoints(modelNames, (m) => {
    const res = aggregateScores(state.checkedTasks, (bench) => {
      const raw = getScore(state.DATA.models, m, bench, state.currentShot);
      if (raw === undefined) return undefined;
      const allRaw = needAllRaw
        ? modelNames.map((mm) => getScore(state.DATA.models, mm, bench, state.currentShot)).filter((v) => v !== undefined)
        : null;
      const score = applyNorm(raw, bench, allRaw);
      const ci = wantSE ? scaleCIDistances(getCombinedCI(state.DATA.models, m, bench, state.currentShot), bench, undefined, allRaw) : undefined;
      return { score, ci };
    }, macro);
    if (!res) return null;
    return { score: res.score, ci: res.ci, count: res.count };
  });

  const yRange = computeAggregateYRange(state.checkedTasks);
  plotScatter(xs, ys, dirs, colors, cis, yRange, extras);
}

function renderSingleBenchmarkScatter(benchmark) {
  updateChartLegend([]);
  const info = state.metricsSetup[benchmark];
  if (!info) return;
  const metric = getEffectiveMetric(benchmark);
  const modelNames = getModelList();
  const allRaw = (state.currentNormalization !== "none")
    ? modelNames.map((mm) => getScore(state.DATA.models, mm, benchmark, state.currentShot, metric)).filter((v) => v !== undefined)
    : null;
  const wantSE = (state.showStderr || state.showPromptDeviation) && isStderrCompatible();

  const { xs, ys, dirs, colors, cis, extras } = collectScatterPoints(modelNames, (m) => {
    const raw = getScore(state.DATA.models, m, benchmark, state.currentShot, metric);
    if (raw == null) return null;
    const score = state.currentNormalization === "none"
      ? toDisplayScale(raw, benchmark, metric)
      : applyNorm(raw, benchmark, allRaw, metric);
    const ci = wantSE
      ? scaleCIDistances(getCombinedCI(state.DATA.models, m, benchmark, state.currentShot, metric), benchmark, metric, allRaw)
      : null;
    return { score, ci };
  });

  const yRange = computeSingleYRange(benchmark, metric);
  plotScatter(xs, ys, dirs, colors, cis, yRange, extras);
}

function renderGroupedScatter(groupName) {
  const group = state.DATA.task_groups[groupName];
  if (!group) return;
  const metric = getEffectiveMetric(group.benchmarks[0]);
  const modelNames = getModelList();
  const useNorm = state.currentNormalization !== "none";
  const needAllRaw = ["minmax", "zscore", "percentile"].includes(state.currentNormalization);
  const wantSE = (state.showStderr || state.showPromptDeviation) && isStderrCompatible();

  // One trace per sub-benchmark, distinguished by colored dots only (no
  // logos in grouped scatter — overlapping logos at the same x would be
  // unreadable). The HTML chart legend tells the viewer which is which.
  const allLogoDirs = [];
  const allLogoXs = [];
  const allLogoYs = [];
  const traces = group.benchmarks.map((bench, gi) => {
    const allRaw = needAllRaw
      ? modelNames.map((mm) => getScore(state.DATA.models, mm, bench, state.currentShot, metric)).filter((v) => v !== undefined)
      : null;
    const xs = [], ys = [], dirs = [], colors = [], cis = [];
    for (const m of modelNames) {
      const size = state.DATA.model_parameters?.[m];
      if (!size) continue;
      const raw = getScore(state.DATA.models, m, bench, state.currentShot, metric);
      if (raw == null) continue;
      const score = useNorm ? applyNorm(raw, bench, allRaw, metric) : toDisplayScale(raw, bench, metric);
      const ci = wantSE
        ? scaleCIDistances(getCombinedCI(state.DATA.models, m, bench, state.currentShot, metric), bench, metric, allRaw)
        : null;
      xs.push(size); ys.push(score); dirs.push(m); cis.push(ci);
      const base = getModelColor(m);
      colors.push(gi === 0 ? base : darkenColor(base, 0.3));
    }
    // Only the first sub-benchmark contributes logo positions, placed at
    // the midpoint of the two sub-scores — keeps the org-mark associated
    // with the model rather than duplicated above each sub-point.
    if (gi === 0) {
      const partnerBench = group.benchmarks[1] || bench;
      const partnerAllRaw = needAllRaw
        ? modelNames.map((mm) => getScore(state.DATA.models, mm, partnerBench, state.currentShot, metric)).filter((v) => v !== undefined)
        : null;
      dirs.forEach((m, i) => {
        const rawP = getScore(state.DATA.models, m, partnerBench, state.currentShot, metric);
        const partnerScore = rawP == null ? ys[i]
          : (useNorm ? applyNorm(rawP, partnerBench, partnerAllRaw, metric) : toDisplayScale(rawP, partnerBench, metric));
        allLogoDirs.push(m);
        allLogoXs.push(xs[i]);
        allLogoYs.push((ys[i] + partnerScore) / 2);
      });
    }
    const trace = {
      x: xs, y: ys, type: "scatter", mode: "markers",
      name: group.labels[gi], showlegend: true,
      marker: { size: 24, color: colors, line: { width: 1.4, color: "rgba(255,255,255,0.95)" } },
      customdata: dirs.map((m, i) => ({ modelDir: m, ci: cis[i] })),
      hoverinfo: "none",
    };
    return trace;
  });

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

  const paperYs = allLogoYs.map((y) => paperFraction(y, yRange));
  const layout = getPlotlyLayout({
    yaxis: {
      title: "", range: yRange,
      showgrid: true, gridcolor: "#d4d8dd", automargin: false, ticks: "", ticklen: 0,
      zeroline: state.currentNormalization === "zscore",
    },
    xaxis: scatterXAxis(),
    showlegend: false,
    margin: { l: 105, r: 4, t: 8, b: 60 },
    images: buildScatterOrgImages(allLogoDirs, allLogoXs, paperYs),
  });

  const repColor = MODEL_COLORS[0];
  updateChartLegend(group.benchmarks.map((_, i) => ({
    name: group.labels[i],
    color: i === 0 ? repColor : darkenColor(repColor, 0.3),
  })));

  plotChart(traces, layout, plotlyConfig, onChartHover, hideTooltip);
}

/** Build a single-trace scatter chart: one marker per model, org logos
 *  overlaid via layout.images. Used by aggregate and single-benchmark
 *  scatter modes. */
function plotScatter(xs, ys, dirs, colors, cis, yRange, extras) {
  const paperYs = ys.map((y) => paperFraction(y, yRange));
  const customdata = dirs.map((m, i) => Object.assign(
    { modelDir: m, ci: cis[i] },
    (extras && extras[i]) || {}));
  // Invisible scatter markers handle hover; the visible glyphs (colored
  // disk + white logo) live in layout.images, interleaved per model so
  // overlapping points stack as units instead of all-disks-then-all-logos.
  const trace = {
    x: xs, y: ys, type: "scatter", mode: "markers",
    marker: { size: 32, color: "rgba(0,0,0,0)", line: { width: 0 } },
    customdata,
    hoverinfo: "none",
  };

  const composite = buildScatterCompositeImages(dirs, xs, paperYs, colors);
  const layout = getPlotlyLayout({
    yaxis: {
      title: "", range: yRange,
      showgrid: true, gridcolor: "#d4d8dd", automargin: false, ticks: "", ticklen: 0,
      zeroline: state.currentNormalization === "zscore",
    },
    xaxis: scatterXAxis(),
    showlegend: false,
    margin: { l: 105, r: 4, t: 8, b: 60 },
    images: composite.images,
  });
  // Stash the image→model mapping so the scatter hover handler (in chart.js)
  // can scale only the hovered model's images, not nearby ones.
  document.getElementById("chart")._scatterImageMap = composite.imageToModel;

  plotChart([trace], layout, plotlyConfig, onChartHover, hideTooltip);
}

// ─────────────────────────────────────────────────────────────
// Y-range helpers
// ─────────────────────────────────────────────────────────────

const ALL_SHOTS = ["0", "1", "5"];

function computeAggregateYRange(benchmarks) {
  const allAvgs = [];
  const needAllRaw = ["minmax", "zscore", "percentile"].includes(state.currentNormalization);
  const wantSE = (state.showStderr || state.showPromptDeviation) && isStderrCompatible();
  const macro = isMacroSelection();
  const modelNames = Object.keys(state.DATA.models).filter((e) => checkedModels.has(e) && isModelInSizeRange(e));
  for (const entity of Object.keys(state.DATA.models)) {
    if (!checkedModels.has(entity) || !isModelInSizeRange(entity)) continue;
    const result = aggregateScores(benchmarks, (bench) => {
      const raw = getScore(state.DATA.models, entity, bench, state.currentShot);
      if (raw === undefined) return undefined;
      const allRaw = needAllRaw
        ? modelNames.map((mm) => getScore(state.DATA.models, mm, bench, state.currentShot)).filter((v) => v !== undefined)
        : null;
      const score = applyNorm(raw, bench, allRaw);
      const ci = wantSE ? scaleCIDistances(getCombinedCI(state.DATA.models, entity, bench, state.currentShot), bench, undefined, allRaw) : undefined;
      return { score, ci };
    }, macro);
    // Include error-bar top in the range so very large CIs don't clip.
    if (result) allAvgs.push(result.score + (result.ci?.hiDist ?? 0));
  }
  return computeYRange(allAvgs);
}

function computeRawYMax_display(benchmarks, metric) {
  const vals = [];
  const wantSE = (state.showStderr || state.showPromptDeviation) && isStderrCompatible();
  for (const entity of Object.keys(state.DATA.models)) {
    if (!checkedModels.has(entity) || !isModelInSizeRange(entity)) continue;
    for (const bench of benchmarks) {
      const v = getScore(state.DATA.models, entity, bench, state.currentShot, metric);
      if (v != null) {
        const displayV = toDisplayScale(v, bench, metric);
        const ci = wantSE
          ? scaleCIDistances(getCombinedCI(state.DATA.models, entity, bench, state.currentShot, metric), bench, metric)
          : null;
        vals.push(displayV + (ci?.hiDist ?? 0));
      }
    }
  }
  if (!vals.length) return 100;
  const mx = Math.max(...vals);
  return Math.min(mx + Math.max(mx * 0.15, 2), 115);
}

function computeSingleYRange(benchmark, metric) {
  const vals = [];
  const wantSE = (state.showStderr || state.showPromptDeviation) && isStderrCompatible();
  const entities = Object.keys(state.DATA.models).filter((e) => checkedModels.has(e) && isModelInSizeRange(e));
  const raws = entities.map((e) => getScore(state.DATA.models, e, benchmark, state.currentShot, metric))
    .filter((v) => v !== undefined);
  for (const e of entities) {
    const raw = getScore(state.DATA.models, e, benchmark, state.currentShot, metric);
    if (raw === undefined) continue;
    const displayV = state.currentNormalization === "none"
      ? toDisplayScale(raw, benchmark, metric)
      : applyNorm(raw, benchmark, raws, metric);
    const ci = wantSE
      ? scaleCIDistances(getCombinedCI(state.DATA.models, e, benchmark, state.currentShot, metric), benchmark, metric, raws)
      : null;
    vals.push(displayV + (ci?.hiDist ?? 0));
  }
  return computeYRange(vals);
}

// ─────────────────────────────────────────────────────────────
// Chart title & hover description
// ─────────────────────────────────────────────────────────────

/** Natural-language plot title for the current state.
 *  Aggregate views lead with "Category average" (macro) or "Task average" (micro);
 *  single-task or group views just name the task / group.
 *  Examples:
 *    "Category average across all NorEval tasks (5-shot)"
 *    "Task average across Bokmål tasks (5-shot)"
 *    "MultiBLiMP (5-shot)"
 *    "translation (English↔Bokmål; 5-shot)" */
function getChartTitleText() {
  const sel = state.currentTaskSelection;
  const shot = state.currentShot + "-shot";
  const prefix = isMacroSelection() ? "Category average" : "Task average";

  if (sel === "__all_macro__" || sel === "__all__") {
    return prefix + " across all NorEval tasks (" + shot + ")";
  }
  if (sel === "__filtered__") return prefix + " across signal-filtered tasks (" + shot + ")";
  if (sel === "__custom__") return prefix + " across " + state.checkedTasks.size + " selected tasks (" + shot + ")";
  if (sel.startsWith("__cat__")) return prefix + " across " + sel.slice(7) + " tasks (" + shot + ")";
  if (sel.startsWith("__eval__")) return prefix + " across " + sel.slice(8) + " tasks (" + shot + ")";
  if (sel === "__lang__nob") return prefix + " across Bokmål tasks (" + shot + ")";
  if (sel === "__lang__nno") return prefix + " across Nynorsk tasks (" + shot + ")";
  if (sel === "__lang__sme") return prefix + " across Northern Sámi tasks (" + shot + ")";
  if (sel.startsWith("__group__")) return formatTitleWithShot(sel.slice(9), shot);
  if (state.metricsSetup[sel]) return formatTitleWithShot(state.metricsSetup[sel].pretty_name, shot);
  return "";
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

/** Build the hover description shown when the user hovers the chart title.
 *  Returns { body, footer }. Body is plain text; footer is an optional URL. */
function getChartTitleDescription() {
  const sel = state.currentTaskSelection;
  if (isAggregateSelection(sel)) {
    return { body: getAggregateDescription(), footer: "" };
  }
  let body = "", url = "";
  if (sel.startsWith("__group__")) {
    const g = state.DATA.task_groups[sel.slice(9)];
    if (g) {
      const info = state.metricsSetup[g.benchmarks[0]];
      if (info) {
        body = info.description || "";
        url = info.url || "";
        const metric = getEffectiveMetric(g.benchmarks[0]);
        const metricName = METRIC_DISPLAY[metric] || metric;
        const baseMetric = getBaseMetric(metric);
        const subtaskDesc = getSubtaskDescription(g.benchmarks[0], metric);
        const metricDesc = subtaskDesc || METRIC_DESCRIPTIONS[baseMetric] || METRIC_DESCRIPTIONS[metric] || "";
        body = (body ? body + " " : "") + "Metric: " + metricName + ". " + metricDesc;
      }
    }
  } else if (state.metricsSetup[sel]) {
    body = state.metricsSetup[sel].description || "";
    url = state.metricsSetup[sel].url || "";
    const metric = getEffectiveMetric(sel);
    const metricName = METRIC_DISPLAY[metric] || metric;
    const baseMetric = getBaseMetric(metric);
    const subtaskDesc = getSubtaskDescription(sel, metric);
    const metricDesc = subtaskDesc || METRIC_DESCRIPTIONS[baseMetric] || METRIC_DESCRIPTIONS[metric] || "";
    body = (body ? body + " " : "") + "Metric: " + metricName + ". " + metricDesc;
  }
  const footer = url ? url.replace("https://huggingface.co/", "https://hf.co/") : "";
  return { body, footer };
}

/** Capitalize the first letter (used so titles like "multiple-choice QA …"
 *  or "grammar correction (5-shot)" lead with a capital). */
function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Update the chart title text and the inline description (shown when the user
 *  expands the <details> that wraps the title). */
function updateChartTitle() {
  const titleEl = document.getElementById("chart-title");
  if (titleEl) titleEl.textContent = capitalize(getChartTitleText());

  const descEl = document.getElementById("chart-description");
  if (!descEl) return;
  const { body, footer } = getChartTitleDescription();
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
