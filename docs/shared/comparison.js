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
  wantCI, normNeedsAllValues, scoreDecimals, taskBaseMetric, getNormYLabel,
} from "./core.js";
import {
  makePlotlyConfig, getPlotlyLayout, plotChart,
  computeTickAngle, computeAnnotationFontSize, computeYRange,
  makeYAxis, makeErrorY,
} from "./chart.js";
import {
  showTooltip, hideTooltip, populateMetricSelector, hideMetricSelector,
  attachControlTooltips, markAppReady, setChartHeader, defaultTaskDisplayName,
} from "./ui.js";
import {
  setsEqual, getBenchmarksForSelection, autoSetNormalization,
  populateTaskDropdown, onTaskCheckboxChange, bindTaskControls,
  restoreCheckedTasksFromSelection, syncTaskControlsFromState,
} from "./selection.js";
import {
  PHONE_SCREEN, initModuleToggles, initChartJump, buildTaskPicker, syncTaskPicker, attachInfoCard,
  setGroupCheckbox, shortUrl,
} from "./pickers.js";
import { UrlState } from "./url-state.js";

let CFG = null;            // Dashboard configuration (set in initComparison)
let plotlyConfig = null;   // Built from CFG.filenamePrefix
let urlState = null;

// Org → local logo filename (all stored white in docs/shared/logos/).
// Files in this folder are downloaded copies — no runtime network
// dependency. All 22 orgs in the dataset are now covered.
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
  "Liquid AI": "liquid_ai.png",
  "LTG/UiO": "uio.png",
  "Marin": "marin.png",
  "Nasjonalbiblioteket": "nb.png",
  "NorwAI/NTNU": "ntnu.png",
  "NVIDIA": "nvidia.png",
  "OpenEuroLLM": "openeurollm.png",
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

// 1×1 transparent stand-in for a missing logo (see buildOrgImages).
const BLANK_IMAGE = "data:image/svg+xml;utf8,"
  + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>");

/** Plotly layout.images entries: one white logo per model at the bar's
 *  bottom, positioned via data-x + paper-y (so the vertical placement
 *  stays a fixed fraction of the chart height regardless of y-axis range).
 *  The bars start at 0: with a y-range reaching below 0 the logos sit just
 *  inside each bar at the zero line (under it for a negative bar), not at
 *  the plot's bottom edge, where they'd be white on white. */
function buildOrgImages(modelNames, xPositions, values = [], yRange = [0, 1]) {
  const [lo, hi] = yRange;
  const zero = lo < 0 && hi > lo ? Math.min(1, -lo / (hi - lo)) : 0;   // paper y of the zero line
  return modelNames.map((modelDir, i) => {
    const org = state.DATA.model_organizations?.[modelDir];
    const filename = org && ORG_LOGO[org];
    const scale = (org && ORG_LOGO_SCALE[org]) || 1;
    return {
      // A model without a logo gets a blank image rather than none: the bar
      // hover (chart.js) moves the logos by bar index, so it needs exactly
      // one image per bar, in bar order.
      source: filename ? `../shared/logos/${filename}` : BLANK_IMAGE,
      xref: "x", yref: "paper",
      x: xPositions[i],
      // yanchor:middle + y:0.05 puts the box's vertical centre at ~5% of
      // chart height above the axis. With sizing:"contain", the logo
      // (PNGs now square-padded at 85% fill — matching SVG safe-area)
      // is centred in the box, so the logo's vertical centre lands at
      // exactly that point regardless of which dimension constrains it.
      y: values[i] != null && values[i] < 0 ? zero - 0.04 : zero + 0.04,
      sizex: 0.5 * scale, sizey: 0.05 * scale,
      xanchor: "center", yanchor: "middle",
      sizing: "contain",
      layer: "above",
    };
  });
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

// Scatter glyphs: disk diameter in px (what the former fixed 1B–1T axis drew
// on a full-width desktop chart) and the logo's share of it.
const SCATTER_DISK_PX = 24.4;
const SCATTER_DISK_PX_NARROW = 20;
const SCATTER_LOGO_SHARE = 0.643;

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
function buildScatterCompositeImages(modelDirs, xs, paperYs, colors, glyph) {
  const images = [];
  const imageToModel = [];
  // Glyph sizes are given in pixels (`glyph`: disk diameter, plot size,
  // x-span in decades), so they don't change with the fitted x-range or
  // shrink on a phone: xref "x" sizes are in log10 units, yref "paper" ones
  // in fractions of the plot height.
  const sizeX = (px) => px / glyph.plotW * glyph.xSpan;
  const sizeY = (px) => px / glyph.plotH;
  for (let i = 0; i < modelDirs.length; i++) {
    const x = Math.log10(xs[i]);
    const y = paperYs[i];
    images.push({
      source: coloredDiskDataUrl(colors[i]),
      xref: "x", yref: "paper",
      x, y,
      sizex: sizeX(glyph.disk), sizey: sizeY(glyph.disk),
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
        sizex: sizeX(glyph.disk * SCATTER_LOGO_SHARE * scale), sizey: sizeY(glyph.disk * SCATTER_LOGO_SHARE * scale),
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
// Whether the URL supplied a valid normalization; otherwise the selection-
// dependent default applies (autoSetNormalization).
let urlNormApplied = false;

const DEFAULT_SELECTION = "__all_macro__";

// Model checkbox state.
export const checkedModels = new Set();

// ─────────────────────────────────────────────────────────────
// Results loading
// ─────────────────────────────────────────────────────────────
// A comparison data.json either carries every model's results under
// `models`, or (build_data.py write_comparison_data) only the metadata and
// `model_ids`, with each model's results in models/<id>.json. Those are
// fetched when a view first shows the model (renderChart waits for them),
// and the default models' are prefetched once the first chart is up.

/** All models of the dashboard (loaded or not), in data order. */
function allModelIds() {
  return state.DATA.model_ids || Object.keys(state.DATA.models);
}

let knownModels = null;
/** Whether `m` is one of the dashboard's models. */
function isKnownModel(m) {
  if (!knownModels) knownModels = new Set(allModelIds());
  return knownModels.has(m);
}

// Model id → promise of its results being merged into state.DATA.models.
const modelLoads = new Map();
// Counts renderChart calls; a render waiting for results draws only if no
// newer one came in meanwhile.
let renderToken = 0;

/** Resolve once the results of all `models` are in state.DATA.models,
 *  fetching those that aren't. A file that fails to load counts as a model
 *  without scores (logged), so one bad file can't block the chart. */
function ensureModelsLoaded(models) {
  const pending = [];
  for (const m of models) {
    if (Object.hasOwn(state.DATA.models, m)) continue;
    if (!modelLoads.has(m)) {
      const version = state.DATA.results_version ? "?v=" + state.DATA.results_version : "";
      const url = "models/" + encodeURIComponent(m) + ".json" + version;
      modelLoads.set(m, fetch(url)
        .then((r) => { if (!r.ok) throw new Error(r.status + " " + r.statusText + " (" + url + ")"); return r.json(); })
        .catch((err) => { console.error(`Could not load the results of ${m}:`, err); return {}; })
        .then((results) => { state.DATA.models[m] = results; }));
    }
    pending.push(modelLoads.get(m));
  }
  return Promise.all(pending);
}

/** After the first chart: load the default models' results in the
 *  background, so moving the size slider over them needs no wait. */
function prefetchDefaultModels() {
  if (!state.DATA.model_ids) return;
  const run = () => ensureModelsLoaded((state.DATA.default_models || []).filter(isKnownModel));
  if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}

/** Dim the chart while a view waits for results (the class's CSS delays
 *  the dimming, so quick loads don't flash). */
function setChartLoading(on) {
  document.getElementById("chart")?.classList.toggle("chart-loading", on);
}

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
    // Unchecking tasks in the category-average view keeps averaging by
    // category (a hidden "__custom_macro__" selection, as on the prelude
    // pages), and "Select all" from there returns to the default view.
    // Off: such a subset is task-averaged, as before.
    keepCategoryAverage: false,
    // Most models drawn as bars; with more, the chart switches to the
    // size-vs-score scatter plot (as it does when the size range is fully
    // open), since that many bars become too thin to read.
    maxBars: 40,
  }, config);
  plotlyConfig = makePlotlyConfig(CFG.filenamePrefix, exportMetadata);
  // Scopes the comparison pages' phone layout in style.css.
  document.body.classList.add("comparison-page");

  try {
    const response = await fetch("data.json");
    state.DATA = await response.json();
    state.metricsSetup = state.DATA.metrics_setup;
    // Results in per-model files: none loaded yet (ensureModelsLoaded).
    if (state.DATA.model_ids && !state.DATA.models) state.DATA.models = {};

    if (CFG.keepCategoryAverage) addCustomMacroOption();
    resetViewState();
    setupUrlState();
    const hasURL = urlState.load();
    restoreCheckedTasksFromSelection(urlState);

    // Sync UI controls
    populateTaskDropdown();
    bindEventListeners();
    buildTaskPicker({ onChange: () => onTaskCheckboxChange(renderChart) });
    buildModelPicker();
    initModuleToggles();
    initChartJump();
    buildSettingsToggle();
    attachControlTooltips();

    // The `norm` URL field has a dynamic default ("baseline" for aggregate
    // selections, "none" otherwise). That default is only applied on save —
    // when `norm` is absent (or invalid) on load, `state.currentNormalization`
    // would otherwise stay at the static state.js default ("baseline"),
    // giving wrong values for individual-task URLs. Apply the dynamic default here.
    if (!urlNormApplied) autoSetNormalization();

    if (hasURL) syncControlsFromState();

    // The first chart is drawn under the loading overlay, with its results.
    await ensureModelsLoaded(getModelList());
    renderChart();
    markAppReady();
    prefetchDefaultModels();
    // Opening a share link in a tab that already shows this dashboard only
    // changes the hash (no reload) — apply it. Our own URL updates use
    // history.replaceState, which fires no hashchange.
    window.addEventListener("hashchange", applyUrlFromHash);
    bindNarrowScreenListeners();
  } catch (err) {
    console.error("init failed:", err);
    const el = document.getElementById("chart");
    if (el) el.innerHTML = "<pre style='color:red;padding:1rem;'>" + err.stack + "</pre>";
    markAppReady();
  }
}

/** The hidden "custom subset, category average" option: with it, the task
 *  checkboxes keep category averaging when used from the category-average
 *  view (selection.js onTaskCheckboxChange looks for it). */
function addCustomMacroOption() {
  const select = document.getElementById("task-select");
  if (!select || select.querySelector('option[value="__custom_macro__"]')) return;
  const opt = document.createElement("option");
  opt.value = "__custom_macro__";
  opt.hidden = true;
  opt.textContent = "Custom (category average)";
  select.insertBefore(opt, select.querySelector('option[value="__custom__"]'));
}

/** Metadata of "Export data as JSON": the settings it always carried, plus
 *  what else determines the plotted numbers. The title is drawn outside the
 *  Plotly figure, so the export can't read it from the layout. */
function exportMetadata() {
  const sel = state.currentTaskSelection;
  const aggregate = isAggregateSelection(sel);
  return {
    shot: state.currentShot + "-shot",
    task_selection: sel,
    prompt_aggregation: state.currentPromptAgg,
    normalization: state.currentNormalization,
    title: document.getElementById("chart-title")?.textContent.trim() || "",
    y_axis: getNormYLabel(),
    metric: aggregate ? "main metric of each task" : getEffectiveMetric(sel),
    tasks: aggregate ? selectedTasks().sort() : [sel],
    // null: that end of the size slider is open (see isModelInSizeRange).
    model_size_b: {
      min: currentSizeMin <= CFG.sizeRangeMin ? null : currentSizeMin,
      max: currentSizeMax >= CFG.sizeRangeMax ? null : currentSizeMax,
    },
    fully_open_only: fullyOpenOnly,
  };
}

/** The checked tasks the data knows — what an aggregate view averages over. */
function selectedTasks() {
  return [...state.checkedTasks].filter((t) => Object.hasOwn(state.metricsSetup, t));
}

// ─────────────────────────────────────────────────────────────
// URL state
// ─────────────────────────────────────────────────────────────

/** Put every URL-controlled setting back to the dashboard default (the URL
 *  only records departures from these). */
function resetViewState() {
  state.currentShot = CFG.defaultShot;
  state.currentTaskSelection = DEFAULT_SELECTION;
  state.currentPromptAgg = "max";
  state.currentMetric = null;
  state.currentNormalization = "baseline";   // replaced by the dynamic default unless the URL sets one
  currentSizeMin = CFG.defaultSizeMin;
  currentSizeMax = CFG.defaultSizeMax;
  fullyOpenOnly = false;
  checkedModels.clear();
  addDefaultModels();
  state.checkedTasks = new Set(Object.keys(state.metricsSetup));
  urlNormApplied = false;
}

/** Check the data's default model set. */
function addDefaultModels() {
  for (const m of state.DATA.default_models || allModelIds()) {
    if (isKnownModel(m)) checkedModels.add(m);
  }
}

/** Show the view the URL hash now describes (on hashchange). */
function applyUrlFromHash() {
  resetViewState();
  urlState.load();
  restoreCheckedTasksFromSelection(urlState);
  if (!urlNormApplied) autoSetNormalization();
  syncControlsFromState();
  renderChart();
}

/** Sync every control's DOM state from the current settings. */
function syncControlsFromState() {
  syncTaskControlsFromState();
  syncPickers();
  updateRangeSliderUI();
  const fo = document.getElementById("fully-open-toggle");
  if (fo) fo.checked = fullyOpenOnly;
}

// Alias maps between selection values and their URL spellings (built once
// the data is loaded). Prototype-free, so a URL value such as "constructor"
// is not mistaken for an entry.
const taskAlias = { _toAlias: Object.create(null), _toSel: Object.create(null) };

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function buildTaskAliasMaps() {
  taskAlias._toAlias["__all__"] = "all-micro";
  taskAlias._toSel["all-micro"] = "__all__";
  taskAlias._toAlias["__custom__"] = "custom";
  taskAlias._toSel["custom"] = "__custom__";
  taskAlias._toAlias["__custom_macro__"] = "custom-macro";
  taskAlias._toSel["custom-macro"] = "__custom_macro__";
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

const modelAlias = { _toAlias: Object.create(null), _toSel: Object.create(null) };
function buildModelAliasMaps() {
  for (const dir of allModelIds()) {
    const a = slugify(getModelLabel(dir));
    modelAlias._toAlias[dir] = a;
    modelAlias._toSel[a] = dir;
  }
}

/** The shots the page offers (its shot buttons). */
function shotValues() {
  return [...document.querySelectorAll(".shot-btn")].map((b) => b.dataset.shot);
}

/** The option values of a <select>. */
function selectValues(id) {
  const el = document.getElementById(id);
  return el ? [...el.options].map((o) => o.value) : [];
}

/** Whether `sel` is a task selection this dashboard can show. */
function isValidSelection(sel) {
  if (sel === "__custom__") return true;
  if (sel === "__custom_macro__") return !!CFG.keepCategoryAverage;
  if (Object.hasOwn(state.metricsSetup, sel)) return true;
  return isAggregateSelection(sel) && getBenchmarksForSelection(sel).length > 0;
}

function setupUrlState() {
  buildTaskAliasMaps();
  buildModelAliasMaps();

  // URL values are validated: an unknown one (a stale or hand-edited link)
  // keeps the default instead of plotting nothing or NaN, or crashing.
  urlState = new UrlState([
    {
      key: "shot", get: () => state.currentShot,
      set: (v) => { if (shotValues().includes(v)) state.currentShot = v; },
      default: CFG.defaultShot,
    },
    {
      key: "task",
      get: () => taskAlias._toAlias[state.currentTaskSelection] || state.currentTaskSelection,
      // Unknown values (e.g. "g:…" pair-group aliases from old URLs) fall
      // back to the default aggregate view instead of an empty chart.
      set: (v) => {
        const sel = taskAlias._toSel[v] || v;
        state.currentTaskSelection = isValidSelection(sel) ? sel : DEFAULT_SELECTION;
      },
      default: DEFAULT_SELECTION,
    },
    {
      key: "prompt", get: () => state.currentPromptAgg,
      set: (v) => { if (selectValues("prompt-agg-select").includes(v)) state.currentPromptAgg = v; },
      default: "max",
    },
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
      set: (v) => {
        if (!selectValues("norm-select").includes(v)) return;
        state.currentNormalization = v;
        urlNormApplied = true;
      },
      default: () => isAggregateSelection(state.currentTaskSelection) ? "baseline" : "none",
    },
    {
      key: "size",
      get: () => currentSizeMin + "-" + currentSizeMax,
      set: (v) => {
        const parts = v.split("-");
        if (parts.length === 2) {
          // A missing / zero end opens that side, as before; both ends are
          // kept on the track and in order.
          const clamp = (x) => Math.max(CFG.sizeRangeMin, Math.min(CFG.sizeRangeMax, x));
          const a = clamp(parseInt(parts[0], 10) || CFG.sizeRangeMin);
          const b = clamp(parseInt(parts[1], 10) || CFG.sizeRangeMax);
          currentSizeMin = Math.min(a, b);
          currentSizeMax = Math.max(a, b);
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
        const all = new Set(allModelIds());
        const defaults = new Set((state.DATA.default_models || allModelIds()).filter(isKnownModel));
        if (setsEqual(checkedModels, defaults)) return "";
        if (setsEqual(checkedModels, all)) return "all";
        // An empty value would be dropped from the URL (= the default set).
        if (checkedModels.size === 0) return "none";
        return [...checkedModels].map((d) => modelAlias._toAlias[d] || d).sort().join(",");
      },
      set: (v) => {
        const all = new Set(allModelIds());
        checkedModels.clear();
        if (v === "all") {
          for (const m of all) checkedModels.add(m);
        } else if (v && v !== "none") {
          for (const a of v.split(",")) {
            const dir = modelAlias._toSel[a] || a;
            if (isKnownModel(dir)) checkedModels.add(dir);
          }
          // A list naming no known model (a stale link) keeps the default set.
          if (checkedModels.size === 0) addDefaultModels();
        }
      },
      default: "",
    },
    {
      key: "tasks",
      get: () => {
        // An empty value would be dropped from the URL (= the selection's tasks).
        if (state.checkedTasks.size === 0) return "none";
        const auto = new Set(getBenchmarksForSelection(state.currentTaskSelection));
        return setsEqual(state.checkedTasks, auto) ? "" : [...state.checkedTasks].sort().join(",");
      },
      set: (v) => {
        if (v && v !== "none") {
          state.checkedTasks = new Set(v.split(",").filter((t) => Object.hasOwn(state.metricsSetup, t)));
          // A list naming no known task (a stale link) keeps the selection's tasks.
          if (!state.checkedTasks.size) {
            const own = getBenchmarksForSelection(state.currentTaskSelection);
            state.checkedTasks = new Set(own.length ? own : Object.keys(state.metricsSetup));
          }
        } else state.checkedTasks = new Set();
      },
      default: "",
    },
  ]);
}

// ─────────────────────────────────────────────────────────────
// Event listeners (dashboard-specific; shared ones live in selection.js)
// ─────────────────────────────────────────────────────────────

function bindEventListeners() {
  // With keepCategoryAverage, "Select all" from a category-average view
  // returns to the default (category-average) view; otherwise, as before,
  // it shows the task average of all tasks.
  bindTaskControls(renderChart, {
    selectAll: () => (CFG.keepCategoryAverage && isMacroSelection() ? DEFAULT_SELECTION : "__all__"),
  });

  const foToggle = document.getElementById("fully-open-toggle");
  if (foToggle) {
    foToggle.addEventListener("change", (e) => {
      fullyOpenOnly = e.target.checked;
      renderChart();
    });
  }

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
  function getPercentFromEvent(e) {
    const rect = slider.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.max(0, Math.min(100, (clientX - rect.left) / rect.width * 100));
  }
  function getValueFromEvent(e) {
    return percentToValue(getPercentFromEvent(e));
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
    const pct = getPercentFromEvent(e);
    const val = percentToValue(pct);
    // Move the thumb nearest on the (logarithmic) track, not the one nearest
    // in billions; with both thumbs on one spot, the side clicked decides.
    const distMin = Math.abs(pct - valueToPercent(currentSizeMin));
    const distMax = Math.abs(pct - valueToPercent(currentSizeMax));
    const thumb = currentSizeMin === currentSizeMax
      ? (val > currentSizeMax ? thumbMax : thumbMin)
      : (distMin <= distMax ? thumbMin : thumbMax);
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
  const unassigned = allModelIds().filter((m) => !state.DATA.model_colors?.[m]);
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

/** Min-max rescaling with fewer than two reference values (one model shown,
 *  or only one with a score on the task) has no range to rescale by;
 *  core.applyNorm then returns the raw score (left so for the progress
 *  pages), which here would mix raw values into averages of rescaled ones.
 *  Use the midpoint, as applyNorm does for a single distinct value. */
function minmaxWithoutRange(allRaw) {
  return state.currentNormalization === "minmax" && state.currentPromptAgg !== "stdev"
    && (!allRaw || allRaw.length < 2);
}
function normScore(raw, bench, allRaw, metric) {
  return minmaxWithoutRange(allRaw) ? 50 : applyNorm(raw, bench, allRaw, metric);
}
function normCI(ci, bench, metric, allRaw) {
  if (minmaxWithoutRange(allRaw)) return ci ? { loDist: 0, hiDist: 0 } : undefined;
  return scaleCIDistances(ci, bench, metric, allRaw);
}

/** Normalized display score + scaled CI for one model on one benchmark, or
 *  null when the model has no score. CI is null when CIs are off. */
function modelScoreCI(m, bench, metric, allRaw) {
  const raw = getScore(state.DATA.models, m, bench, state.currentShot, metric);
  if (raw == null) return null;
  const score = normScore(raw, bench, allRaw, metric);
  const ci = wantCI()
    ? normCI(getCombinedCI(state.DATA.models, m, bench, state.currentShot, metric), bench, metric, allRaw)
    : null;
  return { score, ci };
}

/** Number of prompt templates behind a model's stored score on `bench`
 *  (current shot), or undefined when the entry doesn't say. */
function promptCount(m, bench, metric) {
  const e = state.DATA.models[m]?.[bench]?.[state.currentShot]?.[metric];
  return e && typeof e === "object" && Number.isFinite(e.n_prompts) ? e.n_prompts : undefined;
}

/** The most prompt templates any model has on `bench` (current shot): a
 *  max / min / mean over fewer prompts is not directly comparable. With
 *  per-model results files, from the build's table over all models (the
 *  loaded ones may not include the model with the most). */
const maxPromptCache = new Map();
function maxPromptCount(bench, metric) {
  const table = state.DATA.max_prompts;
  if (table) {
    const n = table[bench]?.[state.currentShot]?.[metric];
    return typeof n === "number" ? n : undefined;
  }
  const key = bench + "\n" + state.currentShot + "\n" + metric;
  if (!maxPromptCache.has(key)) {
    let mx;
    for (const m of Object.keys(state.DATA.models)) {
      const n = promptCount(m, bench, metric);
      if (n !== undefined && (mx === undefined || n > mx)) mx = n;
    }
    maxPromptCache.set(key, mx);
  }
  return maxPromptCache.get(key);
}

/** Aggregate {score, count, ci} for one model across state.checkedTasks,
 *  under the current macro/micro mode and normalization — plus, for the
 *  tooltip, the `tasksUsed` of `tasksTotal` selected tasks the model has a
 *  score on (models are otherwise silently compared on different task
 *  sets), the tasks it was scored on with fewer prompts than others, and
 *  its average per task category (categoryBreakdown). */
function aggregateModelResult(m, modelNames) {
  const needAll = normNeedsAllValues();
  const useCI = wantCI();
  let tasksUsed = 0;
  const fewerPrompts = [];
  const taskScores = [];
  const res = aggregateScores(state.checkedTasks, (bench) => {
    const raw = getScore(state.DATA.models, m, bench, state.currentShot);
    if (raw === undefined) return undefined;
    tasksUsed++;
    const metric = taskBaseMetric(bench);
    const n = promptCount(m, bench, metric), nMax = maxPromptCount(bench, metric);
    if (n !== undefined && nMax !== undefined && n < nMax) fewerPrompts.push({ bench, n, nMax });
    const allRaw = needAll ? allRawScores(modelNames, bench) : null;
    const score = normScore(raw, bench, allRaw);
    const ci = useCI
      ? normCI(getCombinedCI(state.DATA.models, m, bench, state.currentShot), bench, undefined, allRaw)
      : undefined;
    taskScores.push([bench, score]);
    return { score, ci };
  }, isMacroSelection());
  return res && {
    ...res, tasksUsed, tasksTotal: selectedTasks().length, fewerPrompts,
    categories: categoryBreakdown(taskScores),
  };
}

/** A model's average (rescaled) score per task category, from its
 *  [bench, score] pairs — [{category, score, n}] in the task grid's
 *  (alphabetical) order, or [] when the tasks span fewer than two
 *  categories. Shown in the tooltips of aggregate views. */
function categoryBreakdown(taskScores) {
  const groups = new Map();
  for (const [bench, score] of taskScores) {
    const category = state.metricsSetup[bench]?.category;
    if (score === undefined || Number.isNaN(score) || !category) continue;
    const g = groups.get(category) || { sum: 0, n: 0 };
    g.sum += score; g.n++;
    groups.set(category, g);
  }
  if (groups.size < 2) return [];
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([category, g]) => ({ category, score: g.sum / g.n, n: g.n }));
}

function isModelInSizeRange(modelDir) {
  const size = state.DATA.model_parameters?.[modelDir];
  if (size !== undefined && size !== 0) {
    // A thumb resting at either end of the track leaves that side open, so a
    // model outside the track's range (a 0.9B model below its 1B end) shows
    // whenever the slider is opened to that end.
    const lo = currentSizeMin <= CFG.sizeRangeMin ? -Infinity : currentSizeMin;
    const hi = currentSizeMax >= CFG.sizeRangeMax ? Infinity : currentSizeMax;
    if (size < lo || size > hi) return false;
  }
  if (fullyOpenOnly && !state.DATA.model_fully_open?.[modelDir]) return false;
  return true;
}

function getModelList() {
  return allModelIds()
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
// Model picker
// ─────────────────────────────────────────────────────────────
// The models by category (Norwegian / multilingual) and organization, one
// toggle chip per model, smallest first. The picker lists the models the
// size range and the fully-open filter let into the chart; "Show N more"
// adds the others, faded, as does a search that matches them. The bulk
// toggles — Select all / none, an organization's or a category's checkbox —
// act on the chips listed.

const MODEL_CATEGORIES = [
  ["norwegian", "Norwegian language models"],
  ["multilingual", "Multilingual & non-Norwegian language models"],
];
// Whether the models outside the filters are listed too ("Show N more").
let showAllModels = false;
// The words of the model search, lowercased ([] = no search).
let modelSearchWords = [];

function modelCategory(m) {
  return state.DATA.model_categories?.[m] || "multilingual";
}
function modelOrg(m) {
  return state.DATA.model_organizations?.[m] || "Other";
}
function modelSize(m) {
  return state.DATA.model_parameters?.[m] || 0;
}

/** Whether model `m` matches every word of the model search. */
function matchesModelSearch(m) {
  const text = [getModelLabel(m), modelOrg(m), m].join(" ").toLowerCase();
  return modelSearchWords.every((w) => text.includes(w));
}

/** The size range as text ("8–20B", "up to 20B", "from 8B"), or "" when
 *  the slider is fully open. */
function sizeRangeText() {
  const lo = currentSizeMin > CFG.sizeRangeMin, hi = currentSizeMax < CFG.sizeRangeMax;
  if (lo && hi) return `${currentSizeMin}–${currentSizeMax}B`;
  if (hi) return `up to ${currentSizeMax}B`;
  if (lo) return `from ${currentSizeMin}B`;
  return "";
}

/** The models the filters leave out, as a phrase completing "Show 12 more
 *  models …": "outside 8–20B", "larger than 20B", "smaller than 8B", each
 *  "… or not fully open" with the fully-open filter on. */
function filteredOutPhrase() {
  const lo = currentSizeMin > CFG.sizeRangeMin, hi = currentSizeMax < CFG.sizeRangeMax;
  const size = lo && hi ? `outside ${currentSizeMin}–${currentSizeMax}B`
    : hi ? `larger than ${currentSizeMax}B`
    : lo ? `smaller than ${currentSizeMin}B` : "";
  return [size, fullyOpenOnly ? "not fully open" : ""].filter(Boolean).join(" or ");
}

/** Why model `m` isn't in the chart although it may be selected, or "". */
function modelFilterNote(m) {
  if (isModelInSizeRange(m)) return "";
  const size = modelSize(m);
  const lo = currentSizeMin <= CFG.sizeRangeMin ? -Infinity : currentSizeMin;
  const hi = currentSizeMax >= CFG.sizeRangeMax ? Infinity : currentSizeMax;
  const reasons = [];
  if (size && (size < lo || size > hi)) reasons.push(`outside the size range (${sizeRangeText()})`);
  if (fullyOpenOnly && !state.DATA.model_fully_open?.[m]) reasons.push("not fully open");
  return reasons.length ? "Not in the chart: " + reasons.join(" and ") + "." : "";
}

/** Info-card content of a model's chip. */
function modelCard(m) {
  const info = state.DATA.model_info?.[m];
  const url = info?.huggingface_url;
  return {
    title: getModelLabel(m),
    meta: modelMetaLine(m),
    body: info?.description || "",
    note: modelFilterNote(m),
    link: url ? { href: url, text: shortUrl(url) } : null,
  };
}

/** The organization's badge: its logo on a disk of its color, as on the
 *  bars and the scatter points. */
function orgBadge(org, color) {
  const badge = document.createElement("span");
  badge.className = "org-badge";
  badge.style.setProperty("--badge", color);
  const file = ORG_LOGO[org];
  if (file) {
    const img = document.createElement("img");
    img.src = `../shared/logos/${file}`;
    img.alt = "";
    img.decoding = "async";
    const scale = ORG_LOGO_SCALE[org];
    if (scale) img.style.scale = String(scale);
    badge.append(img);
  }
  return badge;
}

/** Build the model picker into #model-picker and wire its toolbar. */
function buildModelPicker() {
  const root = document.getElementById("model-picker");
  if (!root) return;
  root.replaceChildren();
  const bySize = (a, b) => modelSize(a) - modelSize(b) || getModelLabel(a).localeCompare(getModelLabel(b));

  for (const [category, title] of MODEL_CATEGORIES) {
    const models = allModelIds().filter((m) => modelCategory(m) === category);
    if (!models.length) continue;
    const section = document.createElement("section");
    section.className = "model-cat";

    const header = document.createElement("label");
    header.className = "model-cat-header";
    const catBox = document.createElement("input");
    catBox.type = "checkbox";
    const name = document.createElement("span");
    name.textContent = title;
    header.append(catBox, name);
    section.append(header);

    const rows = document.createElement("div");
    rows.className = "org-rows";
    const orgs = [...new Set(models.map(modelOrg))].sort((a, b) => a.localeCompare(b));
    for (const org of orgs) {
      const orgModels = models.filter((m) => modelOrg(m) === org).sort(bySize);
      const row = document.createElement("div");
      row.className = "org-row";

      const label = document.createElement("label");
      label.className = "org-label";
      const orgBox = document.createElement("input");
      orgBox.type = "checkbox";
      const orgName = document.createElement("span");
      orgName.className = "org-name";
      orgName.textContent = org;
      label.append(orgBox, orgBadge(org, getModelColor(orgModels[0])), orgName);

      const chips = document.createElement("div");
      chips.className = "org-chips";
      for (const m of orgModels) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "model-chip";
        chip.dataset.model = m;
        const dot = document.createElement("span");
        dot.className = "model-chip-dot";
        dot.style.setProperty("--dot", getModelColor(m));
        const text = document.createElement("span");
        text.className = "model-chip-name";
        text.textContent = getModelLabel(m);
        chip.append(dot, text);
        attachInfoCard(chip, () => modelCard(m));
        chips.append(chip);
      }
      row.append(label, chips);
      rows.append(row);
    }
    section.append(rows);
    root.append(section);
  }

  const listed = (scope) => [...scope.querySelectorAll(".model-chip:not([hidden])")].map((c) => c.dataset.model);
  const setModels = (models, on) => {
    for (const m of models) {
      if (on) checkedModels.add(m); else checkedModels.delete(m);
    }
    renderChart();
  };

  root.addEventListener("click", (e) => {
    const chip = e.target.closest(".model-chip");
    if (!chip) return;
    const m = chip.dataset.model;
    setModels([m], !checkedModels.has(m));
  });
  root.addEventListener("change", (e) => {
    const box = e.target;
    const scope = box.closest(".org-row") || box.closest(".model-cat");
    if (scope) setModels(listed(scope), box.checked);
  });

  document.getElementById("model-select-all")?.addEventListener("click", () => setModels(listed(root), true));
  document.getElementById("model-select-none")?.addEventListener("click", () => setModels(listed(root), false));
  document.getElementById("model-reset")?.addEventListener("click", () => {
    checkedModels.clear();
    addDefaultModels();
    renderChart();
  });
  document.getElementById("model-search")?.addEventListener("input", (e) => {
    modelSearchWords = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
    syncModelPicker();
  });
  document.getElementById("model-show-more")?.addEventListener("click", () => {
    showAllModels = !showAllModels;
    syncModelPicker();
  });
}

/** Show the selection, the filters and the search in the model picker and
 *  its section header. */
function syncModelPicker() {
  const root = document.getElementById("model-picker");
  if (!root) return;
  const searching = modelSearchWords.length > 0;
  let outside = 0;
  for (const chip of root.querySelectorAll(".model-chip")) {
    const m = chip.dataset.model;
    const inFilters = isModelInSizeRange(m);
    if (!inFilters) outside++;
    chip.hidden = searching ? !matchesModelSearch(m) : !(inFilters || showAllModels);
    chip.classList.toggle("filtered-out", !inFilters);
    chip.setAttribute("aria-pressed", String(checkedModels.has(m)));
  }
  const groupState = (scope, boxSelector) => {
    const models = [...scope.querySelectorAll(".model-chip:not([hidden])")].map((c) => c.dataset.model);
    scope.hidden = models.length === 0;
    setGroupCheckbox(scope.querySelector(boxSelector), models.filter((m) => checkedModels.has(m)).length, models.length);
    return models.length;
  };
  for (const row of root.querySelectorAll(".org-row")) groupState(row, ".org-label input");
  let listedCount = 0;
  for (const section of root.querySelectorAll(".model-cat")) listedCount += groupState(section, ".model-cat-header input");

  const summary = document.getElementById("model-summary");
  if (summary) summary.textContent = `${getModelList().length} in the chart`;

  const empty = document.getElementById("model-picker-empty");
  if (empty) {
    empty.hidden = listedCount > 0;
    const range = sizeRangeText();
    empty.textContent = searching ? "No model matches the search."
      : `No ${fullyOpenOnly ? "fully-open " : ""}model${range ? ` within the size range (${range})` : ""}.`;
  }

  const more = document.getElementById("model-show-more");
  if (more) {
    more.hidden = searching || outside === 0;
    const reason = filteredOutPhrase();
    more.textContent = showAllModels
      ? `Hide the models ${reason}`
      : `Show ${outside} more ${outside === 1 ? "model" : "models"} ${reason}`;
    more.setAttribute("aria-expanded", String(showAllModels));
  }
}

/** Show the current task and model selection in the pickers under the chart. */
function syncPickers() {
  syncTaskPicker();
  syncModelPicker();
}

// ─────────────────────────────────────────────────────────────
// Phone settings
// ─────────────────────────────────────────────────────────────
// On a phone the controls between the chart title and the chart fold away
// behind one row that sums them up ("5-shot · max · random baseline ·
// 8–20B") and opens them in place; the task dropdown stays. The chart then
// starts on the first screen. Wider screens show every control, as before
// (style.css hides the row there).

/** Insert the settings row after the task dropdown; folded on a phone. */
function buildSettingsToggle() {
  const zone = document.querySelector(".chart-zone");
  const taskGroup = document.getElementById("task-select")?.closest(".control-group");
  if (!zone || !taskGroup || document.getElementById("settings-toggle")) return;
  taskGroup.classList.add("control-task");
  const button = document.createElement("button");
  button.type = "button";
  button.id = "settings-toggle";
  button.className = "settings-toggle";
  const name = document.createElement("span");
  name.className = "settings-toggle-name";
  name.textContent = "Settings";
  const summary = document.createElement("span");
  summary.className = "settings-summary";
  summary.id = "settings-summary";
  button.append(name, summary);
  taskGroup.after(button);
  const setOpen = (open) => {
    zone.classList.toggle("settings-folded", !open);
    button.setAttribute("aria-expanded", String(open));
  };
  setOpen(!window.matchMedia(PHONE_SCREEN).matches);
  button.addEventListener("click", () => setOpen(zone.classList.contains("settings-folded")));
  syncSettingsSummary();
}

/** The folded settings in one line: shots, prompt aggregation, rescaling,
 *  the metric of a single-task view, the size range and the open filter. */
function syncSettingsSummary() {
  const el = document.getElementById("settings-summary");
  if (!el) return;
  const chosen = (id) => {
    const select = document.getElementById(id);
    return select?.selectedOptions?.[0]?.textContent.trim() || "";
  };
  const metricShown = document.getElementById("metric-control")?.style.display !== "none";
  const items = [
    state.currentShot + "-shot",
    chosen("prompt-agg-select"),
    state.currentNormalization === "none" ? "no rescaling" : chosen("norm-select"),
    metricShown ? chosen("metric-select").replace(/ \(default\)$/, "") : "",
    sizeRangeText() || "all sizes",
    fullyOpenOnly ? "fully open" : "",
  ].filter(Boolean);
  // A line may break between the items, not inside one ("8–20B"), and
  // after a separator, not before it.
  el.replaceChildren(...items.flatMap((text, i) => {
    const span = document.createElement("span");
    span.className = "settings-summary-item";
    span.textContent = i < items.length - 1 ? text + "\u00a0·" : text;
    return i ? [" ", span] : [span];
  }));
}

// ─────────────────────────────────────────────────────────────
// Chart hover
// ─────────────────────────────────────────────────────────────

/** "max over 5 prompts", or "max over 4 of 5 prompts" when the model has
 *  fewer prompts than the most any model has on the task and shot. */
function promptPhrase(n, nMax) {
  const fewer = nMax !== undefined && n < nMax;
  return state.currentPromptAgg + " over " + (fewer ? n + " of " + nMax : n)
    + ((fewer ? nMax : n) === 1 ? " prompt" : " prompts");
}

function onChartHover(data) {
  if (!data.points || !data.points.length) return;
  const pt = data.points[0];
  const cd = pt.customdata;
  const obj = cd != null && typeof cd === "object" ? cd : null;
  // The bars grow from 0 on every render, so the plotted y of a bar hovered
  // mid-animation is a partial value — and Plotly re-emits hover only for
  // another bar, so it would stay in the tooltip. The renderers store the
  // final value in customdata.
  const value = obj?.value != null ? obj.value : pt.y;
  if (value == null) return;
  const fmt = scoreDecimals();
  const v = Number(value);
  const scoreStr = v.toFixed(fmt);
  const sel = state.currentTaskSelection;

  let ciStr = "";
  if (obj?.ci) {
    const lo = v - (obj.ci.loDist ?? 0), hi = v + (obj.ci.hiDist ?? 0);
    if ((obj.ci.loDist ?? 0) > 0 || (obj.ci.hiDist ?? 0) > 0) {
      ciStr = ` (95% CI: ${Number(lo).toFixed(fmt)} – ${Number(hi).toFixed(fmt)})`;
    }
  }

  let scoreBody;
  if (isAggregateSelection(sel)) {
    const count = obj ? obj.count : cd;
    // Flag an average over fewer than all selected tasks (no score on some).
    const partial = obj && obj.tasksTotal !== undefined && obj.tasksUsed < obj.tasksTotal
      ? obj.tasksUsed + " of " + obj.tasksTotal + " tasks" : "";
    const countStr = isMacroSelection()
      ? [count != null ? count + " categories" : "", partial].filter(Boolean).join("; ")
      : partial || (count != null ? count + " tasks" : "");
    const fewer = obj?.fewerPrompts || [];
    const promptNote = fewer.length === 1
      ? " · fewer prompts than other models on " + defaultTaskDisplayName(fewer[0].bench)
        + " (" + fewer[0].n + " of " + fewer[0].nMax + ")"
      : fewer.length > 1 ? " · fewer prompts than other models on " + fewer.length + " tasks" : "";
    scoreBody = "Average: " + scoreStr + ciStr + (countStr ? " (" + countStr + ")" : "") + promptNote;
  } else {
    scoreBody = "Score: " + scoreStr + ciStr
      + (obj?.nPrompts !== undefined ? " · " + promptPhrase(obj.nPrompts, obj.maxPrompts) : "");
  }

  // With a known model whose info carries a description, the tooltip becomes
  // a model card (name, meta line, description) with the score as footer.
  // Without one it is still titled with the model's name (pt.x is the bar's
  // position or the model's size).
  const modelDir = obj ? obj.modelDir : null;
  const info = modelDir ? state.DATA.model_info?.[modelDir] : null;
  const title = modelDir ? getModelLabel(modelDir) : String(pt.x);
  // Aggregate views list the model's average per task category below the
  // score, to show where its overall number comes from.
  const rows = isAggregateSelection(sel)
    ? (obj?.categories || []).map((c) => ({ label: capitalize(c.category), value: c.score.toFixed(fmt) }))
    : [];
  if (info?.description) {
    showTooltip(data.event, title, info.description, scoreBody, modelMetaLine(modelDir), rows);
  } else {
    showTooltip(data.event, title, scoreBody, "", "", rows);
  }
}

// ─────────────────────────────────────────────────────────────
// Chart rendering
// ─────────────────────────────────────────────────────────────

function renderChart() {
  const sel = state.currentTaskSelection;

  // Every change of the task, model, size or openness selection ends in a
  // render: the pickers under the chart follow here.
  syncPickers();

  // Metric selector
  if (isAggregateSelection(sel)) {
    hideMetricSelector();
  } else if (state.metricsSetup[sel]) {
    populateMetricSelector([sel]);
  }
  syncSettingsSummary();

  updateChartTitle();

  // Results in per-model files: when the view shows models whose results
  // aren't loaded yet, fetch them and render then. Only the latest render
  // request draws (an earlier one finishing loading later is dropped).
  const token = ++renderToken;
  const missing = getModelList().filter((m) => !Object.hasOwn(state.DATA.models, m));
  if (missing.length) {
    setChartLoading(true);
    ensureModelsLoaded(missing).then(() => { if (token === renderToken) renderChart(); });
    return;
  }
  setChartLoading(false);

  // When the user fully opens the size range, or more than CFG.maxBars
  // models are shown, the bar chart would squeeze them into illegible thin
  // bars; switch to a scatter plot with model size on a log x-axis so each
  // model becomes a distinct point.
  const useScatter = isFullSizeRange() || getModelList().length > CFG.maxBars;

  if (!getModelList().length) {
    renderEmptyState(noModelsMessage());
  } else if (isAggregateSelection(sel)) {
    if (!selectedTasks().length) renderEmptyState("No tasks selected – tick tasks below to compute the average");
    else if (useScatter) renderAggregateScatter();
    else renderAggregateBarChart();
  } else {
    if (useScatter) renderSingleBenchmarkScatter(sel);
    else renderSingleBenchmarkBarChart(sel);
  }

  urlState.save();
}

/** Why the chart has no model to show — none selected, or the size range
 *  or the fully-open filter leaves out all the selected ones. */
function noModelsMessage() {
  if (!checkedModels.size) return "No models selected – pick models below";
  const range = sizeRangeText();
  const what = fullyOpenOnly ? "fully-open model" : "model";
  return range
    ? `No selected ${what} in the size range (${range}) – widen it above`
    : `No selected ${what} – pick models below`;
}

/** True when the user has fully opened the size-range slider — one of the
 *  two cues (with more than CFG.maxBars models) for switching from
 *  per-model bars to a size-vs-score scatter plot. */
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

/** Log-scale x-axis of the scatter plot, fitted to the plotted model sizes
 *  (with room for the point glyphs at both ends) instead of a fixed
 *  1B–1T span that left much of the plot empty. */
function scatterXAxis(xs = []) {
  const sizes = xs.filter((x) => x > 0);
  const lo = sizes.length ? Math.min(...sizes) / 1.5 : 0.6;
  const hi = sizes.length ? Math.max(...sizes) * 1.5 : 1050;
  const tickvals = sizeTicks(lo, hi);
  return {
    type: "log",
    range: [Math.log10(lo), Math.log10(hi)],
    automargin: false,
    title: { text: "Model size (B parameters)", font: { size: 13, color: "#64748b" }, standoff: 12 },
    showgrid: true, gridcolor: "#d8dce3",
    tickvals,
    ticktext: tickvals.map(formatModelSize),
  };
}

/** Tick values (billions of parameters) inside [lo, hi]: the 1–3–10
 *  sequence, or 1–2–5, or every integer mantissa — the coarsest of these
 *  that still puts at least three ticks in a narrow range. */
function sizeTicks(lo, hi) {
  const decades = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) decades.push(10 ** e);
  let vals = [];
  for (const mantissas of [[1, 3], [1, 2, 5], [1, 2, 3, 4, 5, 6, 7, 8, 9]]) {
    vals = decades.flatMap((d) => mantissas.map((m) => +(m * d).toPrecision(6)))
      .filter((v) => v >= lo && v <= hi);
    if (vals.length >= 3) break;
  }
  return vals;
}

/** "230M", "8B", "1T" for a size in billions of parameters. */
function formatModelSize(b) {
  if (b >= 1000) return +(b / 1000).toPrecision(3) + "T";
  if (b < 1) return +(b * 1000).toPrecision(3) + "M";
  return +b.toPrecision(3) + "B";
}

// Margins of the bar chart; the bottom and left ones grow to fit long model
// names (barMargins).
const BAR_MARGIN = { l: 105, r: 4, t: 8, b: 100 };
const BAR_WIDTH = 0.85;   // of a model's slot
const TICK_FONT_SIZE = 13;

/** Rendered width (px) of each label in the chart's tick font. */
function measureLabels(labels, fontSize = TICK_FONT_SIZE) {
  try {
    const ctx = measureLabels.ctx || (measureLabels.ctx = document.createElement("canvas").getContext("2d"));
    ctx.font = `${fontSize}px 'Mona Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif`;
    return labels.map((l) => ctx.measureText(l).width);
  } catch (_) {
    return labels.map((l) => l.length * fontSize * 0.55);
  }
}

// Phones (PHONE_SCREEN, pickers.js): the bar chart runs horizontally — one
// row per model, its name on the left — so names stay readable and the
// chart grows downwards instead of squeezing the bars side by side; also a
// phone held sideways, which has no height for the desktop chart. Matches
// the phone block of style.css (full-width chart box).
const ROW_PX = 26;              // height of one model's row
const ROW_LABEL_FONT = 12;      // model names on the left axis
const ROW_VALUE_LABEL_PX = 40;  // room for a value label past a bar's end
const H_MARGIN = { t: 26, r: 10, b: 6 };

/** Value range of the horizontal bars: from 0 — or the lowest error-bar
 *  end, when a value is negative — to the highest error-bar end, widened
 *  on each side that has bars by the room their value labels need (in
 *  pixels of the `plotWidth`), so no label runs into the model names or
 *  off the chart. */
function rowValueRange(values, ciValues, plotWidth) {
  const ends = [];
  values.forEach((v, i) => {
    if (v == null) return;
    ends.push([v - (ciValues?.[i]?.loDist ?? 0), v + (ciValues?.[i]?.hiDist ?? 0)]);
  });
  const negative = values.some((v) => v != null && v < 0);
  const positive = !negative || values.some((v) => v != null && v >= 0);
  const lo = negative ? Math.min(0, ...ends.map((e) => e[0])) : 0;
  const hi = positive ? Math.max(0, ...ends.map((e) => e[1])) : 0;
  const share = Math.min(0.3, ROW_VALUE_LABEL_PX / plotWidth);   // of the plot's width
  const span = (hi - lo || 1) / (1 - (negative + positive) * share);
  return [negative ? lo - share * span : lo, positive ? hi + share * span : hi];
}

/** Whether the bars are drawn horizontally (a phone). */
function useHorizontalBars() {
  return window.matchMedia(PHONE_SCREEN).matches;
}

/** Whether the device has a touch screen. */
function isTouchScreen() {
  return navigator.maxTouchPoints > 0 || window.matchMedia("(any-pointer: coarse)").matches;
}

/** On a touch screen a swipe that starts on the chart must scroll the page:
 *  Plotly would zoom into the chart instead (its default drag), with no way
 *  back on a phone. Fixed axes and no drag mode keep the taps (tooltips). */
function touchSafe(layout) {
  if (!isTouchScreen()) return layout;
  layout.dragmode = false;
  layout.xaxis = { ...layout.xaxis, fixedrange: true };
  layout.yaxis = { ...layout.yaxis, fixedrange: true };
  return layout;
}

/** Model names for the left axis: those wider than `maxPx` are broken onto
 *  two lines at the space closest to their middle. */
function wrapRowLabels(labels, maxPx) {
  const widths = measureLabels(labels, ROW_LABEL_FONT);
  return labels.map((label, i) => {
    if (widths[i] <= maxPx || !label.includes(" ")) return label;
    const mid = label.length / 2;
    let at = -1;
    for (let j = label.indexOf(" "); j !== -1; j = label.indexOf(" ", j + 1)) {
      if (at === -1 || Math.abs(j - mid) < Math.abs(at - mid)) at = j;
    }
    return label.slice(0, at) + "<br>" + label.slice(at + 1);
  });
}

/** Redraw when the screen crosses the narrow-screen breakpoint (a phone
 *  turned sideways) and, in the horizontal layout — whose name wrapping and
 *  logo sizes follow the chart's width — when the width changes (not on the
 *  height-only resizes of a mobile browser's address bar). On touch
 *  screens a tooltip has no mouse to leave from, so a tap closes it. */
function bindNarrowScreenListeners() {
  window.matchMedia(PHONE_SCREEN).addEventListener("change", () => renderChart());
  let width = window.innerWidth, timer = null;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (window.innerWidth === width) return;
      width = window.innerWidth;
      if (useHorizontalBars()) renderChart();
    }, 200);
  });
  // A touch closes the tooltip wherever it lands (a tap on a bar reopens it
  // for that bar, through plotly_click); a mouse press only outside the chart.
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || !document.getElementById("chart")?.contains(e.target)) hideTooltip();
  });
  // A tap on a model's name, left of its horizontal bar, opens the bar's
  // tooltip too. (The names take no pointer events: the row is found from
  // the tap's height.)
  const chartEl = document.getElementById("chart");
  chartEl?.addEventListener("click", (e) => {
    const trace = chartEl.data?.[0], fl = chartEl._fullLayout;
    if (trace?.orientation !== "h" || !fl?.yaxis) return;
    const box = chartEl.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top - fl._size.t;
    if (x >= fl._size.l || y < 0 || y > fl._size.h) return;
    const i = Math.round(fl.yaxis.p2l(y));
    if (!trace.customdata?.[i]) return;
    onChartHover({ points: [{ customdata: trace.customdata[i], x: trace.x[i], y: i }], event: e });
  });
}

/** Set the chart box to `px` tall; null restores the stylesheet's height. */
function setChartHeight(px) {
  const el = document.getElementById("chart");
  if (el) el.style.height = px == null ? "" : px + "px";
}

/** Bar-chart margins that fit the model names at tick angle `angleDeg`
 *  (0, or negative: rotated labels end at their tick and hang down-left).
 *  The bottom margin covers the longest label's drop; the left one keeps
 *  the first labels — whose ticks sit (0.6 + i) slots of `slotPx` right of
 *  the plot's left edge — on the page, also when the chart box starts
 *  `offscreen` px left of the screen (it reaches into the page's left
 *  padding, which a tablet-width page doesn't have). `shift`: the labels'
 *  shift to the right (rotatedLabelShift). */
function barMargins(labels, angleDeg, slotPx, offscreen = 0, shift = 0) {
  const rad = Math.abs(angleDeg) * Math.PI / 180;
  const lineHeight = TICK_FONT_SIZE * 1.2;
  const widths = measureLabels(labels);
  const drop = Math.max(0, ...widths.map((w) => w * Math.sin(rad) + lineHeight * Math.cos(rad)));
  const reach = widths.map((w, i) => (rad === 0 ? w / 2 : w * Math.cos(rad) + lineHeight / 2 * Math.sin(rad))
    - (0.6 + i) * slotPx - shift);
  return {
    ...BAR_MARGIN,
    b: Math.max(BAR_MARGIN.b, Math.ceil(drop + 14)),
    l: Math.max(BAR_MARGIN.l, Math.ceil(Math.max(0, ...reach) + 8 + offscreen)),
  };
}

/** How far (px) to move rotated model names right of their bars' centres.
 *  Plotly ends a rotated name, at mid-height, exactly under its bar's
 *  centre, so a name at a shallow angle hangs mostly under the gap and the
 *  bar to its left. Shifting it right by a quarter of a bar times
 *  cos(angle) keeps vertical names centred and ends flatter ones up to
 *  three quarters across their bar (all the way to the right edge looked
 *  pushed too far). Flat names (angle 0) are centred by Plotly and stay
 *  put. */
function rotatedLabelShift(angleDeg, slotPx) {
  if (!angleDeg) return 0;
  return Math.round(BAR_WIDTH * slotPx / 4 * Math.cos(Math.abs(angleDeg) * Math.PI / 180));
}

/** Make the chart box `extra` px taller than the stylesheet's height (room
 *  for long model names below the bars, so the plot area keeps its size);
 *  0 restores the stylesheet's height. */
function setChartExtraHeight(extra) {
  const el = document.getElementById("chart");
  if (!el) return;
  el.style.height = "";
  if (extra > 0) el.style.height = el.clientHeight + extra + "px";
}

/** The bars ordered by performance: highest value first (every metric of
 *  the comparison pages is higher-is-better, and every rescaling keeps the
 *  order), models without a value last. Ties keep getModelList's order
 *  (organization, size, name). Returns [modelNames, opts] reordered. */
function orderByValue(modelNames, opts) {
  const { values } = opts;
  const valid = (v) => v != null && !Number.isNaN(v);
  const order = modelNames.map((_, i) => i).sort((a, b) => {
    if (!valid(values[a]) || !valid(values[b])) return valid(values[a]) ? -1 : valid(values[b]) ? 1 : 0;
    return values[b] - values[a];
  });
  const pick = (arr) => arr && order.map((i) => arr[i]);
  return [pick(modelNames), {
    ...opts, values: pick(values), ciValues: pick(opts.ciValues), customdata: pick(opts.customdata),
  }];
}

/** Render the standard one-bar-per-model chart used by the aggregate and
 *  single-benchmark views, best model first (orderByValue). `values` /
 *  `ciValues` / `customdata` are parallel to `modelNames`; `ciValues` is
 *  null when CIs are off. */
function renderModelBars(modelNames, opts) {
  [modelNames, opts] = orderByValue(modelNames, opts);
  if (useHorizontalBars()) {
    renderModelBarsHorizontal(modelNames, opts);
    return;
  }
  const { values, ciValues, customdata, yRange } = opts;
  clearScatterHooks();
  const labels = modelNames.map(getModelLabel);
  const xPositions = computeOrgXPositions(modelNames);
  const xRange = xPositions.length
    ? [xPositions[0] - 0.6, xPositions[xPositions.length - 1] + 0.5]
    : null;
  const fmt = scoreDecimals();
  const hiArr = ciValues ? ciValues.map((c) => c?.hiDist ?? 0) : null;
  const loArr = ciValues ? ciValues.map((c) => c?.loDist ?? 0) : null;
  // A negative value (below chance under random-baseline rescaling, or a
  // z-score) is labelled under its bar's lower error bar, others above.
  const below = values.map((v) => v != null && v < 0);
  const trace = {
    x: xPositions, y: values, type: "bar",
    width: BAR_WIDTH,
    marker: { color: modelNames.map(getModelColor), line: { width: 0 }, cornerradius: 6 },
    // The final value (for the tooltip — the plotted y animates) and the
    // model's name (for the JSON export) ride along in customdata.
    customdata: customdata.map((d, i) => ({ ...d, value: values[i], label: labels[i] })),
    hoverinfo: "none",
    ...(ciValues && { error_y: makeErrorY(ciValues) }),
  };
  const tickAngle = computeTickAngle(labels);
  const chartEl = document.getElementById("chart");
  const chartWidth = chartEl?.clientWidth || 1200;
  const offscreen = Math.max(0, -(chartEl?.getBoundingClientRect().left ?? 0));
  const slotPx = (chartWidth - BAR_MARGIN.l - BAR_MARGIN.r) / (labels.length + 0.1);
  const labelShift = rotatedLabelShift(tickAngle, slotPx);
  const margin = barMargins(labels, tickAngle, slotPx, offscreen, labelShift);
  setChartExtraHeight(margin.b - BAR_MARGIN.b);
  const layout = getPlotlyLayout({
    yaxis: makeYAxis(yRange),
    xaxis: { automargin: false,
      range: xRange,
      tickvals: xPositions, ticktext: labels,
      tickangle: tickAngle, ticklabelshift: labelShift, showgrid: false,
    },
    showlegend: false,
    margin,
    annotations: labels.map((label, i) => ({
      x: xPositions[i],
      y: below[i]
        ? values[i] - (loArr ? (loArr[i] || 0) : 0)
        : (values[i] || 0) + (hiArr ? (hiArr[i] || 0) : 0),
      text: values[i] != null ? values[i].toFixed(fmt) : "",
      showarrow: false, yshift: below[i] ? -10 : 10,
      xanchor: "center",
      font: { size: computeAnnotationFontSize(labels.length), color: "#000", weight: 500 },
    })),
    images: buildOrgImages(modelNames, xPositions, values, yRange),
  });
  layout._annAnim = labels.map((_, i) => ({
    score: values[i] || 0,
    se: below[i] ? -(loArr ? (loArr[i] || 0) : 0) : (hiArr ? (hiArr[i] || 0) : 0),
  }));
  plotChart([trace], touchSafe(layout), plotlyConfig, onChartHover, hideTooltip);
}

/** renderModelBars on a narrow screen: one row per model, best at the top,
 *  its name on the left (on two lines if long), the bar
 *  growing right from 0 (left for a negative value) with the organization's
 *  logo at its start and the value after its error bar; the value scale on
 *  top. The chart box grows to fit the rows. A tap anywhere on a row shows
 *  the model's tooltip (hovermode "y"). */
function renderModelBarsHorizontal(modelNames, { values, ciValues, customdata }) {
  clearScatterHooks();
  const labels = modelNames.map(getModelLabel);
  const rows = modelNames.map((_, i) => i);
  const width = document.getElementById("chart")?.clientWidth || 360;
  const ticktext = wrapRowLabels(labels, width * 0.36);
  const lineWidths = measureLabels(ticktext.flatMap((t) => t.split("<br>")), ROW_LABEL_FONT);
  const margin = {
    ...H_MARGIN,
    l: Math.min(Math.ceil(Math.max(0, ...lineWidths)) + 10, Math.round(width * 0.45)),
  };
  setChartHeight(margin.t + margin.b + rows.length * ROW_PX);
  const fmt = scoreDecimals();
  const hiArr = ciValues ? ciValues.map((c) => c?.hiDist ?? 0) : null;
  const loArr = ciValues ? ciValues.map((c) => c?.loDist ?? 0) : null;
  const below = values.map((v) => v != null && v < 0);
  const errorX = ciValues && { ...makeErrorY(ciValues), thickness: 1.6, width: 3 };
  const trace = {
    type: "bar", orientation: "h",
    x: values, y: rows, width: 0.72,
    marker: { color: modelNames.map(getModelColor), line: { width: 0 }, cornerradius: 4 },
    customdata: customdata.map((d, i) => ({ ...d, value: values[i], label: labels[i] })),
    hoverinfo: "none",
    ...(errorX && { error_x: errorX }),
  };
  const plotWidth = Math.max(1, width - margin.l - margin.r);
  const xRange = rowValueRange(values, ciValues, plotWidth);
  const layout = getPlotlyLayout({
    xaxis: { ...makeYAxis(xRange), side: "top", tickfont: { size: 11, color: "#64748b" } },
    yaxis: {
      range: [rows.length - 0.5, -0.5], tickvals: rows, ticktext,
      showgrid: false, automargin: false, ticks: "", ticklen: 0,
      tickfont: { size: ROW_LABEL_FONT, color: "#1e293b", weight: 500 },
    },
    hovermode: "y",
    showlegend: false,
    margin,
    annotations: values.map((v, i) => ({
      y: i,
      x: below[i] ? v - (loArr ? (loArr[i] || 0) : 0) : (v || 0) + (hiArr ? (hiArr[i] || 0) : 0),
      text: v != null ? v.toFixed(fmt) : "",
      showarrow: false,
      xanchor: below[i] ? "right" : "left", xshift: below[i] ? -4 : 4,
      font: { size: 11, color: "#000", weight: 500 },
    })),
    images: buildRowLogos(modelNames, values, xRange, plotWidth),
  });
  layout._annAnim = values.map((v, i) => ({
    score: v || 0,
    se: below[i] ? -(loArr ? (loArr[i] || 0) : 0) : (hiArr ? (hiArr[i] || 0) : 0),
  }));
  plotChart([trace], touchSafe(layout), plotlyConfig, onChartHover, hideTooltip);
}

/** Logos of the horizontal bars: one per row (a blank one without a logo,
 *  as in buildOrgImages), inside the bar just past the zero line, sized to
 *  the row height. */
function buildRowLogos(modelNames, values, xRange, plotWidth) {
  const [lo, hi] = xRange;
  const zero = lo < 0 && hi > lo ? Math.min(1, -lo / (hi - lo)) : 0;   // paper x of 0
  const pad = 4 / plotWidth;
  return modelNames.map((modelDir, i) => {
    const org = state.DATA.model_organizations?.[modelDir];
    const filename = org && ORG_LOGO[org];
    const scale = (org && ORG_LOGO_SCALE[org]) || 1;
    const side = ROW_PX * 0.56 * scale;   // px
    const negative = values[i] != null && values[i] < 0;
    // A bar too short for its logo (a score near 0, as z-scores have) gets
    // none: it would stick out over the error bar and the value.
    const barPx = Math.abs(values[i] || 0) / ((hi - lo) || 1) * plotWidth;
    const fits = barPx >= side + 8;
    return {
      source: filename && fits ? `../shared/logos/${filename}` : BLANK_IMAGE,
      xref: "paper", yref: "y",
      x: negative ? zero - pad : zero + pad, y: i,
      sizex: side / plotWidth, sizey: (side / ROW_PX),
      xanchor: negative ? "right" : "left", yanchor: "middle",
      sizing: "contain", layer: "above",
    };
  });
}

/** Forget the composite-scatter hooks a scatter render leaves on the chart
 *  element (which outlives renders), so the scatter hover can't act on a
 *  later bar chart (see chart.js attachScatterHoverHighlight). */
function clearScatterHooks() {
  const el = document.getElementById("chart");
  if (!el) return;
  el._scatterImageMap = null;
  el._scatterOnHover = null;
  el._scatterOnUnhover = null;
}

/** An empty chart with a centred note, instead of a row of "0.0" bars when
 *  no task is selected. */
function renderEmptyState(message) {
  clearScatterHooks();
  setChartExtraHeight(0);
  // A narrow screen gets the note on two lines (broken after its dash).
  const narrow = useHorizontalBars();
  const layout = getPlotlyLayout({
    xaxis: { visible: false },
    yaxis: { visible: false },
    showlegend: false,
    margin: narrow ? { l: 8, r: 8, t: 8, b: 8 } : { l: 105, r: 4, t: 8, b: 100 },
    annotations: [{
      text: narrow ? message.replace(/ – /, " –<br>") : message,
      xref: "paper", yref: "paper", x: 0.5, y: 0.5,
      showarrow: false, font: { size: 15, color: "#64748b" },
    }],
  });
  plotChart([], touchSafe(layout), plotlyConfig, null, hideTooltip);
}

function renderAggregateBarChart() {
  const modelNames = getModelList();
  const results = modelNames.map((m) => aggregateModelResult(m, modelNames));
  renderModelBars(modelNames, {
    // A model without a score on any selected task gets no bar (not a 0).
    values: results.map((r) => r ? r.score : null),
    ciValues: wantCI() ? results.map((r) => r ? r.ci : null) : null,
    customdata: results.map((r, i) => ({
      count: r ? r.count : 0, ci: r ? r.ci : null, modelDir: modelNames[i],
      tasksUsed: r?.tasksUsed, tasksTotal: r?.tasksTotal, fewerPrompts: r?.fewerPrompts,
      categories: r?.categories,
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
    customdata: modelNames.map((m, i) => ({
      ci: points[i]?.ci ?? null, modelDir: m,
      nPrompts: promptCount(m, benchmark, metric), maxPrompts: maxPromptCount(benchmark, metric),
    })),
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
  const { xs, ys, dirs, colors, cis, extras } = collectScatterPoints(
    modelNames, (m) => aggregateModelResult(m, modelNames));
  plotScatter(xs, ys, dirs, colors, cis, computeAggregateYRange(), extras);
}

function renderSingleBenchmarkScatter(benchmark) {
  if (!state.metricsSetup[benchmark]) return;
  const metric = getEffectiveMetric(benchmark);
  const modelNames = getModelList();
  const allRaw = (state.currentNormalization !== "none")
    ? allRawScores(modelNames, benchmark, metric)
    : null;
  const { xs, ys, dirs, colors, cis, extras } = collectScatterPoints(modelNames, (m) => {
    const p = modelScoreCI(m, benchmark, metric, allRaw);
    return p && { ...p, nPrompts: promptCount(m, benchmark, metric), maxPrompts: maxPromptCount(benchmark, metric) };
  });
  plotScatter(xs, ys, dirs, colors, cis, computeSingleYRange(benchmark, metric), extras);
}

/** Build a single-trace scatter chart: one marker per model, org logos
 *  overlaid via layout.images. Used by aggregate and single-benchmark
 *  scatter modes. */
function plotScatter(xs, ys, dirs, colors, cis, yRange, extras) {
  setChartExtraHeight(0);
  const paperYs = ys.map((y) => paperFraction(y, yRange));
  const customdata = dirs.map((m, i) => Object.assign(
    { modelDir: m, ci: cis[i], value: ys[i], label: getModelLabel(m) },
    (extras && extras[i]) || {}));
  // Invisible scatter markers handle hover; the visible glyphs (colored
  // disk + white logo) live in layout.images, interleaved per model so
  // overlapping points stack as units instead of all-disks-then-all-logos.
  const trace = {
    x: xs, y: ys, type: "scatter", mode: "markers",
    marker: { size: 32, color: "rgba(0,0,0,0)", line: { width: 0 } },
    customdata,
    hoverinfo: "none",
    // Not drawn (the logos are the glyphs) — carried so that "Export data as
    // JSON" includes each point's CI.
    ...(cis.some(Boolean) && { error_y: { ...makeErrorY(cis), visible: false } }),
  };

  // The chart box reaches into the page's left padding (style.css),
  // except on narrow screens, where it keeps to the column. A phone gets a
  // taller plot, to spread the points out, but one that fits its screen.
  const narrow = useHorizontalBars();
  if (narrow) setChartHeight(Math.round(Math.min(560, Math.max(300, window.innerHeight * 0.68))));
  const margin = { l: narrow ? 40 : 105, r: 20, t: 8, b: 60 };
  const xaxis = scatterXAxis(xs);
  const el = document.getElementById("chart");
  const composite = buildScatterCompositeImages(dirs, xs, paperYs, colors, {
    disk: narrow ? SCATTER_DISK_PX_NARROW : SCATTER_DISK_PX,
    plotW: Math.max(1, (el?.clientWidth || 1200) - margin.l - margin.r),
    plotH: Math.max(1, (el?.clientHeight || 500) - margin.t - margin.b),
    xSpan: xaxis.range[1] - xaxis.range[0],
  });
  const layout = getPlotlyLayout({
    yaxis: makeYAxis(yRange),
    xaxis,
    showlegend: false,
    margin,
    images: composite.images,
  });
  // Stash the image→model mapping so the scatter hover handler (in chart.js)
  // can scale only the hovered model's images, not nearby ones.
  document.getElementById("chart")._scatterImageMap = composite.imageToModel;

  plotChart([trace], touchSafe(layout), plotlyConfig, onChartHover, hideTooltip);
}

// ─────────────────────────────────────────────────────────────
// Y-range helpers
// ─────────────────────────────────────────────────────────────

/** Y-range for `points` ({score, ci} | null per model). As before, it runs
 *  from 0 to above the highest error-bar top (computeYRange), and an error
 *  bar reaching below 0 under a non-negative score is cut off at 0 (mostly
 *  the normal approximation of a CI near a score's floor of 0; the tooltip
 *  gives the full CI). When a score is negative (below chance under
 *  random-baseline rescaling: it would otherwise be drawn down over the
 *  model names, and Plotly drops a label outside the range), the range
 *  extends below 0 to the lowest error-bar end. Z-scores, centred on 0,
 *  are fitted to both error-bar ends. */
function barYRange(points) {
  const tops = [], bottoms = [];
  let negative = false;
  for (const p of points) {
    if (!p) continue;
    tops.push(p.score + (p.ci?.hiDist ?? 0));
    bottoms.push(p.score - (p.ci?.loDist ?? 0));
    if (p.score < 0) negative = true;
  }
  if (state.currentNormalization === "zscore") return computeYRange([...tops, ...bottoms]);
  const [lo, hi] = computeYRange(tops.map((v) => Math.max(v, 0)));
  if (!negative) return [lo, hi];
  const mn = Math.min(...bottoms);
  return [mn - Math.max((hi - mn) * 0.05, 0.5), hi];
}

function computeAggregateYRange() {
  const modelNames = getModelList();
  return barYRange(modelNames.map((m) => aggregateModelResult(m, modelNames)));
}

function computeSingleYRange(benchmark, metric) {
  const modelNames = getModelList();
  const raws = allRawScores(modelNames, benchmark, metric);
  return barYRange(modelNames.map((m) => modelScoreCI(m, benchmark, metric, raws)));
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
  if (sel === "__custom__" || sel === "__custom_macro__") return prefix + " across " + state.checkedTasks.size + " selected tasks (" + shot + ")";
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
  const custom = sel === "__custom__" || sel === "__custom_macro__";
  const count = custom ? state.checkedTasks.size : getBenchmarksForSelection(sel).filter((b) => state.checkedTasks.has(b)).length;
  const macro = isMacroSelection();
  const cats = new Set();
  for (const b of state.checkedTasks) {
    const info = state.metricsSetup[b];
    if (info) cats.add(info.category);
  }
  let scope = "";
  if (sel === "__all_macro__") {
    scope = "all " + count + " tasks (" + cats.size + " categories, category average)";
  } else if (sel === "__all__") scope = "all " + count + " tasks (task average)";
  else if (sel === "__custom_macro__") scope = count + " selected tasks (" + cats.size + " categories, category average)";
  else if (sel === "__custom__") scope = count + " selected tasks (task average)";
  else if (sel.startsWith("__cat__")) scope = count + " tasks in the \"" + sel.slice(7) + "\" category";
  else if (sel.startsWith("__eval__")) scope = count + " " + sel.slice(8) + " tasks";
  else if (sel === "__lang__nob") scope = count + " Bokmål tasks";
  else if (sel === "__lang__nno") scope = count + " Nynorsk tasks";
  else if (sel === "__lang__sme") scope = count + " Northern Sámi tasks";

  // First how each task score is rescaled, then how the task scores are
  // averaged (by category or over all tasks).
  const normDescs = {
    none: "Scores are shown on their native metric scales, without rescaling.",
    baseline: "Each task score is rescaled to a 0–100 scale where 0 = random baseline performance and 100 = perfect score. This accounts for different chance levels across tasks (e.g. 25% for 4-choice QA vs. 50% for binary classification).",
    minmax: "Each task score is rescaled to 0–100 using the minimum and maximum scores among the displayed models (those selected below and within the size and fully-open filters). This shows relative performance within that set, so a model's value changes when other models are shown or hidden.",
    zscore: "Each task score is converted to a z-score (number of standard deviations from the mean across the displayed models), which gives equal weight to all tasks regardless of score spread.",
    percentile: "Each task score is converted to a percentile rank among the displayed models (0 = worst, 100 = best).",
  };
  const normDesc = normDescs[state.currentNormalization] || "";
  const avgDesc = macro
    ? " The task scores are then averaged within each category, and the category averages are averaged, which gives equal weight to each category regardless of how many tasks it contains."
    : " The task scores are then averaged.";
  return "Aggregate score across " + scope + ". " + normDesc + avgDesc;
}
