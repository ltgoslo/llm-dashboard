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
  MODEL_COLORS,
  getScore, getCombinedCI, scaleCIDistances, applyNorm,
  getBaseMetric, aggregateScores, isAggregateSelection, isMacroSelection,
  getEffectiveMetric, formatTitleWithShot, capitalize, taskTitleDescription,
  wantCI, normNeedsAllValues, scoreDecimals,
} from "./core.js";
import {
  makePlotlyConfig, getPlotlyLayout, plotChart,
  computeTickAngle, computeAnnotationFontSize, computeYRange,
  makeYAxis, makeErrorY,
} from "./chart.js";
import {
  showTooltip, hideTooltip, populateMetricSelector, hideMetricSelector,
  buildTaskCheckboxes, bindModuleActionStopPropagation,
  attachControlTooltips, markAppReady, setChartHeader, defaultTaskDisplayName,
} from "./ui.js";
import {
  setsEqual, getBenchmarksForSelection, autoSetNormalization,
  populateTaskDropdown, onTaskCheckboxChange, bindTaskControls,
  restoreCheckedTasksFromSelection, syncTaskControlsFromState,
} from "./selection.js";
import { UrlState } from "./url-state.js";

let CFG = null;            // Dashboard configuration (set in initComparison)
let plotlyConfig = null;   // Built from CFG.filenamePrefix
let urlState = null;

// Org → local logo filename (all stored white in docs/shared/logos/).
// Files in this folder are downloaded copies — no runtime network
// dependency. All 20 orgs in the dataset are now covered.
const ORG_LOGO = {
  "Google": "google.png",
  "Meta": "meta.png",
  "Mistral AI": "mistral.png",
  "Alibaba": "qwen.png",
  "AI Sweden": "ai_sweden.png",
  "Allen AI": "allen_ai.png",
  "Arcee AI": "arcee.png",
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
  "Tilde.ai": "tilde.png",
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
function buildOrgImages(modelNames, xPositions) {
  return modelNames.map((modelDir, i) => {
    const org = state.DATA.model_organizations?.[modelDir];
    const filename = org && ORG_LOGO[org];
    if (!filename) return null;
    const scale = (org && ORG_LOGO_SCALE[org]) || 1;
    return {
      source: `../shared/logos/${filename}`,
      xref: "x", yref: "paper",
      x: xPositions[i],
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
      // Sized to fit inside the 32px scatter markers. sizex is in log10
      // units (≈ 0.045 ≈ 2% of plot width on the 1–150B range); sizey is
      // a paper-height fraction.
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
    defaultShot: "5",
    defaultSizeMin: 6,
    defaultSizeMax: 24,
    sizeRangeMin: 1,
    sizeRangeMax: 73,
    filenamePrefix: "comparison-chart",
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
    restoreCheckedTasksFromSelection(urlState);

    // Sync UI controls
    populateTaskDropdown();
    bindEventListeners();
    buildTaskCheckboxes({
      filterSourceFn: () => state.checkedTasks,
      onChange: () => onTaskCheckboxChange(renderChart),
    });
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
      syncTaskControlsFromState();
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
      // Unknown values (e.g. "g:…" pair-group aliases from old URLs) fall
      // back to the default aggregate view instead of an empty chart.
      set: (v) => {
        const sel = taskAlias._toSel[v] || v;
        state.currentTaskSelection = (sel === "__custom__" || getBenchmarksForSelection(sel).length > 0)
          ? sel : "__all_macro__";
      },
      default: "__all_macro__",
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

// ─────────────────────────────────────────────────────────────
// Event listeners (dashboard-specific; shared ones live in selection.js)
// ─────────────────────────────────────────────────────────────

function bindEventListeners() {
  bindTaskControls(renderChart);

  const foToggle = document.getElementById("fully-open-toggle");
  if (foToggle) {
    foToggle.addEventListener("change", (e) => {
      fullyOpenOnly = e.target.checked;
      renderChart();
    });
  }

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

/** "7B parameters  ·  License: X  ·  fully-open" meta line for a model. */
function modelMetaLine(modelDir) {
  const params = state.DATA.model_parameters?.[modelDir];
  const paramsPart = params
    ? (params < 1 ? `${Math.round(params * 1000)}M parameters` : `${params}B parameters`)
    : "";
  const license = state.DATA.model_info?.[modelDir]?.license;
  const licensePart = license ? `License: ${license}` : "";
  return [paramsPart, licensePart, getModelOpenLabel(modelDir)].filter(Boolean).join("  ·  ");
}

/** Raw scores of every listed model on one benchmark (the reference set for
 *  min-max / z-score / percentile normalization). */
function allRawScores(modelNames, bench, metric) {
  return modelNames
    .map((m) => getScore(state.DATA.models, m, bench, state.currentShot, metric))
    .filter((v) => v !== undefined);
}

/** Normalized display score + scaled CI for one model on one benchmark, or
 *  null when the model has no score. CI is null when CIs are off. */
function modelScoreCI(m, bench, metric, allRaw) {
  const raw = getScore(state.DATA.models, m, bench, state.currentShot, metric);
  if (raw == null) return null;
  const score = applyNorm(raw, bench, allRaw, metric);
  const ci = wantCI()
    ? scaleCIDistances(getCombinedCI(state.DATA.models, m, bench, state.currentShot, metric), bench, metric, allRaw)
    : null;
  return { score, ci };
}

/** Aggregate {score, count, ci} for one model across state.checkedTasks,
 *  under the current macro/micro mode and normalization. */
function aggregateModelResult(m, modelNames) {
  const needAll = normNeedsAllValues();
  const useCI = wantCI();
  return aggregateScores(state.checkedTasks, (bench) => {
    const raw = getScore(state.DATA.models, m, bench, state.currentShot);
    if (raw === undefined) return undefined;
    const allRaw = needAll ? allRawScores(modelNames, bench) : null;
    const score = applyNorm(raw, bench, allRaw);
    const ci = useCI
      ? scaleCIDistances(getCombinedCI(state.DATA.models, m, bench, state.currentShot), bench, undefined, allRaw)
      : undefined;
    return { score, ci };
  }, isMacroSelection());
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
          const meta = modelMetaLine(modelDir);
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
  const fmt = scoreDecimals();
  const scoreStr = Number(pt.y).toFixed(fmt);
  const sel = state.currentTaskSelection;
  const cd = pt.customdata;

  let ciStr = "";
  if (cd != null && typeof cd === "object" && cd.ci) {
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
  } else {
    scoreBody = "Score: " + scoreStr + ciStr;
  }

  // With a known model whose info carries a description, the tooltip becomes
  // a model card (name, meta line, description) with the score as footer.
  const modelDir = cd && typeof cd === "object" ? cd.modelDir : null;
  const info = modelDir ? state.DATA.model_info?.[modelDir] : null;
  if (info?.description) {
    showTooltip(data.event, getModelLabel(modelDir), info.description, scoreBody, modelMetaLine(modelDir));
  } else {
    showTooltip(data.event, String(pt.x), scoreBody, "", "");
  }
}

// ─────────────────────────────────────────────────────────────
// Chart rendering
// ─────────────────────────────────────────────────────────────

function renderChart() {
  const sel = state.currentTaskSelection;

  // Metric selector
  if (isAggregateSelection(sel)) {
    hideMetricSelector();
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
    range: [Math.log10(0.6), Math.log10(1050)],
    automargin: false,
    title: { text: "Model size (B parameters)", font: { size: 13, color: "#64748b" }, standoff: 12 },
    showgrid: true, gridcolor: "#d8dce3",
    tickvals: [1, 3, 10, 30, 100, 300, 1000],
    ticktext: ["1B", "3B", "10B", "30B", "100B", "300B", "1T"],
  };
}

/** Render the standard one-bar-per-model chart used by the aggregate and
 *  single-benchmark views. `values` / `ciValues` / `customdata` are parallel
 *  to `modelNames`; `ciValues` is null when CIs are off. */
function renderModelBars(modelNames, { values, ciValues, customdata, yRange }) {
  const labels = modelNames.map(getModelLabel);
  const xPositions = computeOrgXPositions(modelNames);
  const xRange = xPositions.length
    ? [xPositions[0] - 0.6, xPositions[xPositions.length - 1] + 0.5]
    : null;
  const fmt = scoreDecimals();
  const hiArr = ciValues ? ciValues.map((c) => c?.hiDist ?? 0) : null;
  const trace = {
    x: xPositions, y: values, type: "bar",
    width: 0.85,
    marker: { color: modelNames.map(getModelColor), line: { width: 0 }, cornerradius: 6 },
    customdata,
    hoverinfo: "none",
    ...(ciValues && { error_y: makeErrorY(ciValues) }),
  };
  const layout = getPlotlyLayout({
    yaxis: makeYAxis(yRange),
    xaxis: { automargin: false,
      range: xRange,
      tickvals: xPositions, ticktext: labels,
      tickangle: computeTickAngle(labels), showgrid: false,
    },
    showlegend: false,
    margin: { l: 105, r: 4, t: 8, b: 100 },
    annotations: labels.map((label, i) => ({
      x: xPositions[i], y: (values[i] || 0) + (hiArr ? (hiArr[i] || 0) : 0),
      text: values[i] != null ? values[i].toFixed(fmt) : "",
      showarrow: false, yshift: 10,
      xanchor: "center",
      font: { size: computeAnnotationFontSize(labels.length), color: "#000", weight: 500 },
    })),
    images: buildOrgImages(modelNames, xPositions),
  });
  layout._annAnim = labels.map((_, i) => ({
    score: values[i] || 0, se: hiArr ? (hiArr[i] || 0) : 0,
  }));
  plotChart([trace], layout, plotlyConfig, onChartHover, hideTooltip);
}

function renderAggregateBarChart() {
  const modelNames = getModelList();
  const results = modelNames.map((m) => aggregateModelResult(m, modelNames));
  renderModelBars(modelNames, {
    values: results.map((r) => r ? r.score : 0),
    ciValues: wantCI() ? results.map((r) => r ? r.ci : null) : null,
    customdata: results.map((r, i) => ({
      count: r ? r.count : 0, ci: r ? r.ci : null, modelDir: modelNames[i],
    })),
    yRange: computeAggregateYRange(),
  });
}

function renderSingleBenchmarkBarChart(benchmark) {
  if (!state.metricsSetup[benchmark]) return;
  const metric = getEffectiveMetric(benchmark);
  const modelNames = getModelList();
  const allRaw = (state.currentNormalization !== "none")
    ? allRawScores(modelNames, benchmark, metric)
    : null;
  const points = modelNames.map((m) => modelScoreCI(m, benchmark, metric, allRaw));
  renderModelBars(modelNames, {
    values: points.map((p) => p ? p.score : null),
    ciValues: wantCI() ? points.map((p) => p ? p.ci : null) : null,
    customdata: modelNames.map((m, i) => ({ ci: points[i]?.ci ?? null, modelDir: m })),
    yRange: computeSingleYRange(benchmark, metric),
  });
}

// ─────────────────────────────────────────────────────────────
// Scatter rendering (used when size-range slider is fully open).
// Logos overlay invisible markers — the markers handle hover, the logos
// are the visible glyph.
// ─────────────────────────────────────────────────────────────

function renderAggregateScatter() {
  const modelNames = getModelList();
  const { xs, ys, dirs, colors, cis, extras } = collectScatterPoints(modelNames, (m) => {
    const res = aggregateModelResult(m, modelNames);
    return res ? { score: res.score, ci: res.ci, count: res.count } : null;
  });
  plotScatter(xs, ys, dirs, colors, cis, computeAggregateYRange(), extras);
}

function renderSingleBenchmarkScatter(benchmark) {
  if (!state.metricsSetup[benchmark]) return;
  const metric = getEffectiveMetric(benchmark);
  const modelNames = getModelList();
  const allRaw = (state.currentNormalization !== "none")
    ? allRawScores(modelNames, benchmark, metric)
    : null;
  const { xs, ys, dirs, colors, cis, extras } = collectScatterPoints(
    modelNames, (m) => modelScoreCI(m, benchmark, metric, allRaw));
  plotScatter(xs, ys, dirs, colors, cis, computeSingleYRange(benchmark, metric), extras);
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
    yaxis: makeYAxis(yRange),
    xaxis: scatterXAxis(),
    showlegend: false,
    margin: { l: 105, r: 20, t: 8, b: 60 },
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

function computeAggregateYRange() {
  const modelNames = getModelList();
  const allAvgs = [];
  for (const m of modelNames) {
    const result = aggregateModelResult(m, modelNames);
    // Include error-bar top in the range so very large CIs don't clip.
    if (result) allAvgs.push(result.score + (result.ci?.hiDist ?? 0));
  }
  return computeYRange(allAvgs);
}

function computeSingleYRange(benchmark, metric) {
  const modelNames = getModelList();
  const raws = allRawScores(modelNames, benchmark, metric);
  const vals = [];
  for (const m of modelNames) {
    const p = modelScoreCI(m, benchmark, metric, raws);
    if (p) vals.push(p.score + (p.ci?.hiDist ?? 0));
  }
  return computeYRange(vals);
}

// ─────────────────────────────────────────────────────────────
// Chart title & hover description
// ─────────────────────────────────────────────────────────────

/** Natural-language plot title for the current state.
 *  Aggregate views lead with "Category average" (macro) or "Task average" (micro);
 *  single-task views just name the task.
 *  Examples:
 *    "Category average across all NorEval tasks (5-shot)"
 *    "Task average across Bokmål tasks (5-shot)"
 *    "MultiBLiMP (5-shot)"
 *    "translation (English → Bokmål; 5-shot)" */
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
  if (state.metricsSetup[sel]) return formatTitleWithShot(defaultTaskDisplayName(sel), shot);
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
  if (state.metricsSetup[sel]) {
    return taskTitleDescription(sel, getSubtaskDescription);
  }
  return { body: "", footer: "" };
}

/** Update the chart title text and the inline description (shown when the user
 *  expands the <details> that wraps the title). */
function updateChartTitle() {
  setChartHeader(capitalize(getChartTitleText()), getChartTitleDescription());
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
