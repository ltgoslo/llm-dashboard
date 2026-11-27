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
  wantCI, normNeedsAllValues, scoreDecimals, taskBaseMetric, scoreScaleText, getMetricYLabel, isRawScaleMetric,
  toDisplayScale, METRIC_DISPLAY, TASK_NAME_DISPLAY, compareCategories,
} from "./core.js";
import {
  makePlotlyConfig, getPlotlyLayout, plotChart,
  computeTickAngle, computeAnnotationFontSize, computeYRange,
  makeYAxis, makeErrorY, Y_TICK_FONT, hexToRgb, holdBarAnimation, refreshBarHover,
} from "./chart.js";
import {
  showTooltip, hideTooltip, populateMetricSelector, hideMetricSelector,
  attachControlTooltips, markAppReady, setChartHeader, defaultTaskDisplayName,
} from "./ui.js";
import {
  setsEqual, getBenchmarksForSelection, autoSetNormalization, setAggregateNormalization,
  populateTaskDropdown, onTaskCheckboxChange, bindTaskControls,
  restoreCheckedTasksFromSelection, syncTaskControlsFromState,
} from "./selection.js";
import {
  PHONE_SCREEN, initModuleToggles, initChartJump, buildTaskPicker, syncTaskPicker, attachInfoCard,
  setGroupCheckbox, shortUrl,
} from "./pickers.js";
import { setBarPan, buttonFitsBeside, revealBar, refreshBarPan } from "./bar-pan.js";
import { UrlState } from "./url-state.js";
import { createModelDetail, DETAIL_DRAWER, detailMotion } from "./model-detail.js";
import { createTaskDetail } from "./task-detail.js";

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
// "Filter by model size": on, the chart shows the models in the size range
// as ranked bars; off, every size, as a size-vs-score scatter plot.
let sizeFilterOn = true;
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
 *  background, so moving the size slider over them needs no wait, and the
 *  scores the model details compare (loadBestScores). */
function prefetchDefaultModels() {
  if (!state.DATA.model_ids) return;
  const run = () => {
    ensureModelsLoaded((state.DATA.default_models || []).filter(isKnownModel));
    loadBestScores();
  };
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
    // The prompt aggregation shown (the page's select, if it has one; the
    // details show it too). A page without the select (/instruct: a task's
    // score is already a mean over random prompts) fixes it: its data
    // carries only that aggregate.
    promptAgg: "max",
    // The rescaling of the aggregate views and of the details' scores: the
    // random baseline. A page without the select (/instruct: every task is
    // graded 0–5 by the same judge) shows its scores as they are ("none").
    normalization: "baseline",
    // Decimal places of a score, and a perfect score as shown (/instruct's
    // scores are mean grades, from 0 to 5, shown with 2 places).
    decimals: 1,
    scoreTop: 100,
    // The order of the task categories (null: NorEval's, CATEGORY_ORDER).
    categoryOrder: null,
    // The model details open on its average over all tasks (with a shot
    // control where the page has shots); false: not (/instruct: the chart
    // shows it).
    detailAverage: true,
    // Unchecking tasks in the category-average view keeps averaging by
    // category (a hidden "__custom_macro__" selection, as on the prelude
    // pages), and "Select all" from there returns to the default view.
    // Off: such a subset is task-averaged, as before.
    keepCategoryAverage: false,
  }, config);
  plotlyConfig = makePlotlyConfig(CFG.filenamePrefix, exportMetadata);
  // Scopes the comparison pages' phone layout in style.css.
  document.body.classList.add("comparison-page");
  state.decimals = CFG.decimals;
  state.scoreTop = CFG.scoreTop;
  state.categoryOrder = CFG.categoryOrder;
  setAggregateNormalization(CFG.normalization);

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
    populateTaskDropdown({ compareCategories });
    bindEventListeners();
    buildTaskPicker({ onChange: () => onTaskCheckboxChange(renderChart) });
    buildModelPicker();
    initModuleToggles();
    initChartJump();
    buildSettingsToggle();
    attachControlTooltips();
    initModelDetail();

    // The `norm` URL field has a dynamic default ("baseline" for aggregate
    // selections, "none" otherwise). That default is only applied on save —
    // when `norm` is absent (or invalid) on load, `state.currentNormalization`
    // would otherwise stay at the static state.js default ("baseline"),
    // giving wrong values for individual-task URLs. Apply the dynamic default here.
    if (!urlNormApplied) autoSetNormalization();

    if (hasURL) syncControlsFromState();

    // The first chart is drawn under the loading overlay, with its results
    // and the font its names are measured in (a page with its results in
    // data.json, /instruct, would otherwise draw before the font has come,
    // and redraw differently later).
    await Promise.all([ensureModelsLoaded(getModelList()), rowFontLoaded()]);
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

/** Metadata of "Export data as JSON": the chart's title (drawn outside the
 *  Plotly figure, so the export can't read it from the layout), what its y
 *  (and, as a scatter, x) values are, and the settings that determine them
 *  (only those the page offers). */
function exportMetadata() {
  const sel = state.currentTaskSelection;
  const aggregate = isAggregateSelection(sel);
  const judged = !!state.DATA.instruct;
  // A single task's scores as they are: its metric (0–100 unless a raw one).
  const metric = aggregate ? null : getEffectiveMetric(sel);
  const asIs = !aggregate && state.currentNormalization === "none" && state.currentPromptAgg !== "stdev";
  return {
    // (A page without the title, /instruct: what it would say.)
    title: document.getElementById("chart-title")?.textContent.trim() || capitalize(getChartTitleText()),
    y_axis: judged ? "mean grade from the LLM judge (0–5)"
      : asIs ? getMetricYLabel(sel, metric) + (isRawScaleMetric(metric) ? "" : " (0–100)")
      : scoreScaleText(),
    // (With the size filter off the chart is a scatter by size.)
    ...(sizeFilterOn ? {} : { x_axis: "parameters (billions)" }),
    // Only the settings the page offers.
    ...(hasShots() ? { shot: state.currentShot + "-shot" } : {}),
    ...(document.getElementById("prompt-agg-select") ? { prompt_aggregation: state.currentPromptAgg } : {}),
    ...(document.getElementById("norm-select") ? { rescaling: state.currentNormalization } : {}),
    metric: aggregate ? "main metric of each task" : metric,
    tasks: aggregate ? selectedTasks().sort() : [sel],
    ...(hasSizeFilter() && sizeFilterOn ? { model_size_b: [currentSizeMin, currentSizeMax] } : {}),
    ...(hasOpenFilter() ? { fully_open_only: fullyOpenOnly } : {}),
    // An LLM-judged page's scores: the judge's.
    ...(judged ? { judge: state.DATA.instruct.judge?.display_name || state.DATA.instruct.judge?.name || "" } : {}),
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
  state.currentPromptAgg = CFG.promptAgg;
  state.currentMetric = null;
  state.currentNormalization = CFG.normalization;   // replaced by the dynamic default unless the URL sets one
  currentSizeMin = CFG.defaultSizeMin;
  currentSizeMax = CFG.defaultSizeMax;
  sizeFilterOn = true;
  fullyOpenOnly = false;
  checkedModels.clear();
  addDefaultModels();
  state.checkedTasks = new Set(Object.keys(state.metricsSetup));
  urlNormApplied = false;
  detailModel = null;
  detailTask = null;
  detailExample = 0;
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
  syncSizeFilterUI();
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

/** The shots the page offers (its shot buttons; a page without them has
 *  its default shot only: /instruct). */
function shotValues() {
  const shots = [...document.querySelectorAll(".shot-btn")].map((b) => b.dataset.shot);
  return shots.length ? shots : [CFG.defaultShot];
}

/** Whether the page offers shots (a page without has one setting, which
 *  titles don't name). */
function hasShots() {
  return !!document.querySelector(".shot-btn");
}

/** Whether the page offers the model-size filter / the fully-open filter
 *  (a page without shows every model: /instruct, for now). */
function hasSizeFilter() {
  return !!document.getElementById("size-slider-container");
}
function hasOpenFilter() {
  return !!document.getElementById("fully-open-toggle");
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
      default: CFG.promptAgg,
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
      default: () => isAggregateSelection(state.currentTaskSelection) ? CFG.normalization : "none",
    },
    {
      key: "size",
      get: () => currentSizeMin + "-" + currentSizeMax,
      set: (v) => {
        const parts = v.split("-");
        if (parts.length === 2 && hasSizeFilter()) {
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
      key: "sizefilter",
      get: () => sizeFilterOn ? "1" : "0",
      set: (v) => { if (hasSizeFilter()) sizeFilterOn = v !== "0"; },
      default: "1",
    },
    {
      key: "open",
      get: () => fullyOpenOnly ? "1" : "0",
      set: (v) => { if (hasOpenFilter()) fullyOpenOnly = v === "1"; },
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
      // The model whose details are open.
      key: "model",
      get: () => (detailModel ? modelAlias._toAlias[detailModel] || detailModel : ""),
      set: (v) => {
        const dir = modelAlias._toSel[v] || v;
        detailModel = isKnownModel(dir) ? dir : null;
      },
      default: "",
    },
    {
      // The task whose details are open over the model's.
      key: "detail",
      get: () => (detailModel && detailTask ? taskAlias._toAlias[detailTask] || detailTask : ""),
      set: (v) => {
        const task = taskAlias._toSel[v] || v;
        detailTask = Object.hasOwn(state.metricsSetup, task) ? task : null;
      },
      default: "",
    },
    {
      // The example a judged task's details show (/instruct), from 1.
      key: "example",
      get: () => (detailModel && detailTask && detailExample > 0 ? String(detailExample + 1) : ""),
      set: (v) => {
        const n = parseInt(v, 10);
        detailExample = n > 1 ? n - 1 : 0;
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
  const sfToggle = document.getElementById("size-filter-toggle");
  if (sfToggle) {
    sfToggle.addEventListener("change", (e) => {
      sizeFilterOn = e.target.checked;
      syncSizeFilterUI();
      renderChart();
    });
  }

  initRangeSlider();
  syncSizeFilterUI();
}

/** The size slider greys out (and takes no input) while the size filter is
 *  off; the toggle shows the filter's state. */
function syncSizeFilterUI() {
  const toggle = document.getElementById("size-filter-toggle");
  if (toggle) toggle.checked = sizeFilterOn;
  document.getElementById("size-slider-container")?.classList.toggle("size-filter-off", !sizeFilterOn);
  for (const id of ["thumb-min", "thumb-max"]) {
    const thumb = document.getElementById(id);
    if (!thumb) continue;
    thumb.tabIndex = sizeFilterOn ? 0 : -1;
    thumb.setAttribute("aria-disabled", String(!sizeFilterOn));
  }
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
  thumbMin.setAttribute("aria-valuemin", String(CFG.sizeRangeMin));
  thumbMin.setAttribute("aria-valuemax", String(currentSizeMax));
  thumbMin.setAttribute("aria-valuenow", String(currentSizeMin));
  thumbMin.setAttribute("aria-valuetext", currentSizeMin + "B");
  thumbMax.setAttribute("aria-valuemin", String(currentSizeMin));
  thumbMax.setAttribute("aria-valuemax", String(CFG.sizeRangeMax));
  thumbMax.setAttribute("aria-valuenow", String(currentSizeMax));
  thumbMax.setAttribute("aria-valuetext", currentSizeMax + "B");
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
  thumbMin.setAttribute("role", "slider");
  thumbMin.setAttribute("aria-label", "Minimum model size");
  thumbMax.setAttribute("role", "slider");
  thumbMax.setAttribute("aria-label", "Maximum model size");

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
    if (!sizeFilterOn) return;
    e.preventDefault();
    activeThumb = thumb;
    thumb.classList.add("active");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onEnd);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
  }
  function onThumbKeydown(thumb, e) {
    if (!sizeFilterOn) return;
    const isMin = thumb === thumbMin;
    const cur = isMin ? currentSizeMin : currentSizeMax;
    const lo = isMin ? CFG.sizeRangeMin : currentSizeMin;
    const hi = isMin ? currentSizeMax : CFG.sizeRangeMax;
    const bigStep = Math.max(5, Math.round(cur * 0.25));
    let next = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = cur - (e.shiftKey ? bigStep : 1);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = cur + (e.shiftKey ? bigStep : 1);
    else if (e.key === "PageDown") next = cur - bigStep;
    else if (e.key === "PageUp") next = cur + bigStep;
    else if (e.key === "Home") next = lo;
    else if (e.key === "End") next = hi;
    else return;
    e.preventDefault();
    next = Math.max(lo, Math.min(hi, next));
    if (next === cur) return;
    if (isMin) currentSizeMin = next;
    else currentSizeMax = next;
    updateRangeSliderUI();
    renderChart();
  }
  thumbMin.addEventListener("mousedown", (e) => onStart(thumbMin, e));
  thumbMin.addEventListener("touchstart", (e) => onStart(thumbMin, e), { passive: false });
  thumbMin.addEventListener("keydown", (e) => onThumbKeydown(thumbMin, e));
  thumbMax.addEventListener("mousedown", (e) => onStart(thumbMax, e));
  thumbMax.addEventListener("touchstart", (e) => onStart(thumbMax, e), { passive: false });
  thumbMax.addEventListener("keydown", (e) => onThumbKeydown(thumbMax, e));
  slider.addEventListener("mousedown", (e) => {
    if (!sizeFilterOn || e.target === thumbMin || e.target === thumbMax) return;
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

/** Aggregate {score, count, ci} for one model across state.checkedTasks,
 *  under the current macro/micro mode and normalization. */
function aggregateModelResult(m, modelNames) {
  const needAll = normNeedsAllValues();
  const useCI = wantCI();
  return aggregateScores(state.checkedTasks, (bench) => {
    const raw = getScore(state.DATA.models, m, bench, state.currentShot);
    if (raw === undefined) return undefined;
    const allRaw = needAll ? allRawScores(modelNames, bench) : null;
    const score = normScore(raw, bench, allRaw);
    const ci = useCI
      ? normCI(getCombinedCI(state.DATA.models, m, bench, state.currentShot), bench, undefined, allRaw)
      : undefined;
    return { score, ci };
  }, isMacroSelection());
}

function isModelInSizeRange(modelDir) {
  const size = state.DATA.model_parameters?.[modelDir];
  if (sizeFilterOn && size !== undefined && size !== 0) {
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
  if (!sizeFilterOn) return "";
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
  const lo = sizeFilterOn && currentSizeMin > CFG.sizeRangeMin;
  const hi = sizeFilterOn && currentSizeMax < CFG.sizeRangeMax;
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
  if (sizeFilterOn && size && (size < lo || size > hi)) reasons.push(`outside the size range (${sizeRangeText()})`);
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

/** Insert the settings row after the task dropdown; folded on a phone. A
 *  page with nothing else to fold gets none (/instruct, for now: its only
 *  other control is the metric's, which its one-metric tasks never show). */
function buildSettingsToggle() {
  const zone = document.querySelector(".chart-zone");
  const taskGroup = document.getElementById("task-select")?.closest(".control-group");
  if (!zone || !taskGroup || document.getElementById("settings-toggle")) return;
  taskGroup.classList.add("control-task");
  if (![...zone.querySelectorAll(".control-group")].some((g) => g !== taskGroup && g.id !== "metric-control")) return;
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
    hasShots() ? state.currentShot + "-shot" : "",
    chosen("prompt-agg-select"),
    !document.getElementById("norm-select") ? "" : state.currentNormalization === "none" ? "no rescaling" : chosen("norm-select"),
    metricShown ? chosen("metric-select").replace(/ \(default\)$/, "") : "",
    !hasSizeFilter() ? "" : sizeFilterOn ? sizeRangeText() || "all sizes" : "all sizes (scatter)",
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

/** A tap on a touch screen is followed by the mouse events a browser
 *  makes of it; Plotly answers its mousedown with a second click, carrying
 *  the bar hovered before (which would show that bar's tooltip, or open
 *  that model, again). */
let lastTouchAt = -Infinity;
document.addEventListener("touchstart", () => { lastTouchAt = performance.now(); }, { capture: true, passive: true });
function touchEcho(ev) {
  return ev?.type === "mousedown" && performance.now() - lastTouchAt < 1000;
}
/** Whether the page is used by touch: the last pointer pressed on it was a
 *  finger, and no mouse has moved since. A tap on a bar (or a point, or a
 *  bar's name) opens the model's details and shows nothing else: no tooltip
 *  (the details name the model, as does the button to them). */
let touchInput = false;
document.addEventListener("pointerdown", (e) => { touchInput = e.pointerType === "touch"; }, { capture: true, passive: true });
document.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") touchInput = false; }, { capture: true, passive: true });

/** Whether the chart is columns hovered with a mouse: then the bar drawn
 *  under the pointer (chart.js: magnified and shifted by the hover) is the
 *  one the tooltip names and a click opens (chartEl._onBarUnder,
 *  chartEl._barColumnAt), not the one Plotly's hit-test finds — it knows
 *  only where the bars rest, so near a magnified bar's edge it found
 *  nothing (no tooltip, a click lost), or a neighbour. */
function drawnBarHits(chartEl) {
  const t = chartEl?.data?.[0];
  return !!t && t.type === "bar" && t.orientation !== "h" && FINE_POINTER.matches && !touchInput
    && typeof chartEl._barColumnAt === "function";
}

/** The chart's tooltip, short: the model, its score with its 95% interval
 *  (where the chart has them), and what a click does (the model's details
 *  have the rest). */
function onChartHover(data) {
  if (!data.points || !data.points.length || touchEcho(data.event) || touchInput) return;
  if (!data.drawn && drawnBarHits(document.getElementById("chart"))) return;   // (Plotly's: see drawnBarHits)
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
  // The interval as the error bar draws it: from the score down by loDist,
  // up by hiDist (not always symmetric).
  const ci = obj?.ci;
  let interval = "";
  if (ci && (ci.loDist > 0 || ci.hiDist > 0)) {
    const lo = Number(value) - (ci.loDist ?? 0), hi = Number(value) + (ci.hiDist ?? 0);
    interval = ` (95% CI ${lo.toFixed(fmt)}${lo < 0 ? " to " : "–"}${hi.toFixed(fmt)})`;
  }
  const score = (isAggregateSelection(state.currentTaskSelection) ? "Average: " : "Score: ")
    + Number(value).toFixed(fmt) + interval;
  // Titled with the model's name (without a model: pt.x, the bar's position
  // or the model's size).
  const modelDir = obj ? obj.modelDir : null;
  chartTip = {
    event: data.event, modelDir, title: modelDir ? getModelLabel(modelDir) : String(pt.x), body: score,
    mark: pt.data?.type === "bar" ? "bar" : "point",
  };
  showChartTip();
}

/** The chart's tooltip while it shows ({event, modelDir, title, body,
 *  mark}), or null. Its last line, a hint in plain text, says what a click
 *  on the hovered bar or point does: with a mouse, one on the open model's
 *  closes its details (openFromChart). It names the bar: the tooltip itself
 *  is no control. */
let chartTip = null;
function showChartTip() {
  const { event, modelDir, title, body, mark } = chartTip;
  const hint = !modelDir ? ""
    : modelDir === detailModel ? `Click the ${mark} to close the details` : `Click the ${mark} for details`;
  showTooltip(event, title, body, "", "", hint);
}
/** The details opened or closed (a click, ← / →, Esc) under a showing
 *  tooltip: its last line follows. */
function refreshChartTip() {
  if (chartTip && document.getElementById("custom-tooltip").classList.contains("visible")) showChartTip();
}
function onChartUnhover(data) {
  if (data?.points && drawnBarHits(document.getElementById("chart"))) return;   // (Plotly's: see drawnBarHits)
  chartTip = null;
  hideTooltip();
}

// ─────────────────────────────────────────────────────────────
// Model details (model-detail.js)
// ─────────────────────────────────────────────────────────────
// A click on a model's bar (or row, or scatter point) opens its details: on
// a wide screen in a drawer over the page's right end, otherwise in a panel
// under the chart. With a mouse, a click on the open model's bar closes them
// again; a tap on a touch screen opens them and nothing else (no tooltip:
// touchInput) and leaves the page where it is, with a button to the panel.
// The details' × or Esc closes them; ← / → step to the neighbouring bar. A link
// with the model in it (URL `model`) opens them. What they show doesn't
// follow the chart's settings, and compares the model with every model of
// the dashboard, shown or not (modelDetailData).
//
// The open model's bar is marked: a band of its colour behind it (which
// widens and moves with the bar under the mouse: chart.js _barFollowers),
// its name in bold. The band fades in and out and glides to the next model.
//
// The drawer leaves the page's layout as it is: the page slides left only as
// far as the controls need to clear it (placeDrawer), and the chart runs on
// under it — a panning bar chart pans to the bars it covers (bar-pan.js);
// another chart is laid out again to end at its edge. The motion — the
// drawer's slide, the page's shift, the band — runs together on Web
// Animations, with the heavy work (building the drawer, the page's layout,
// the band's relayout) done before it starts and any relayout of the chart
// after it. The bar hover follows the mouse through all this (rehover).

let detailModel = null;        // the model whose details are open, or null
let detailView = null;         // model-detail.js's drawer / panel
let detailShot = null;         // the shot the details show (null: the page's default)
let detailCache = null;        // {key, data}: the details' last content
let detailTask = null;         // the task whose details are open over the model's, or null
let detailExample = 0;         // the example a judged task's details show (/instruct), from 0
let taskView = null;           // task-detail.js's view
let bandModel = null;          // the model whose band the chart shows
let bandFadingOut = false;     // …still, while the band fades out
let drawerMove = null;         // the drawer's opening or closing under way (a token)
let lastPointer = null;        // the mouse's last place on the page, {x, y}
const SELECTED_MARK = "selected model";   // names the open model's band
const BAND_ALPHA = 0.12;
const FINE_POINTER = window.matchMedia("(hover: hover) and (pointer: fine)");
const DRAWER_SCREEN = window.matchMedia(DETAIL_DRAWER);
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function initModelDetail() {
  const chart = document.getElementById("chart");
  const zone = chart?.closest(".chart-zone");
  if (!zone) return;
  const onShot = (shot) => { detailShot = shot; refreshModelDetail(); };
  detailView = createModelDetail(zone, {
    onClose: () => selectModelDetail(null),
    onShot,
    onTask: openTaskDetail,
    onTaskIntent: loadTaskData,
  });
  taskView = createTaskDetail({ onClose: () => closeTaskDetail(), onShot, onModel: openTaskModel });
  chart._barFollowers = bandFollowers;
  // Across the breakpoint the drawer and the panel swap.
  DRAWER_SCREEN.addEventListener("change", () => {
    if (!detailModel) return;
    holdBarAnimation();
    renderChart();
  });
  // A click outside the open drawer closes it: anywhere on the page but on
  // something that acts itself (a control, a link; a bar, point or name
  // that picks a model: openFromChart), and not at the end of a drag (a
  // pan, a selection). Only the drawer: the panel under the chart is the
  // page's.
  let pressed = null;
  document.addEventListener("pointerdown", (e) => { pressed = { x: e.clientX, y: e.clientY }; }, true);
  document.addEventListener("click", (e) => {
    const p = pressed;
    pressed = null;
    if (!detailModel || !drawerSettled() || performance.now() - pickedAt < 500) return;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) return;
    const t = e.target;
    if (!(t instanceof Element) || t.closest(".model-detail, .task-view, " + ACTS_ITSELF)) return;
    selectModelDetail(null);
  });
  // The drawer's place follows the page's width and the controls' (a view
  // with more of them, a task's longer name).
  const replace = () => { if (drawerSettled()) placeDrawerAgain(); };
  window.addEventListener("resize", replace);
  if ("ResizeObserver" in window) new ResizeObserver(replace).observe(zone);
  // The mouse leaving the chart ends its hover. A browser misses the
  // leaving when the element under a still mouse was redrawn (a chart laid
  // out again): then the mouse's next move off the chart tells it.
  let mouseInChart = false;
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    lastPointer = { x: e.clientX, y: e.clientY };
    const inside = chart.contains(e.target);
    if (mouseInChart && !inside && !e.target.classList?.contains("dragcover")) {
      chart.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: e.target }));
    }
    mouseInChart = inside;
  }, { passive: true });
  document.documentElement.addEventListener("mouseleave", () => { lastPointer = null; });
  chart.addEventListener("mouseleave", (e) => {
    if (!FINE_POINTER.matches || e.relatedTarget?.classList?.contains("dragcover")) return;
    Plotly.Fx?.unhover(chart);
    hideTooltip();
  });
  document.addEventListener("keydown", (e) => {
    if (!detailModel || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // Over the model's details, the task's: Esc closes them (only).
    if (detailTask) {
      if (e.key === "Escape") { e.preventDefault(); closeTaskDetail(); }
      return;
    }
    if (e.key === "Escape") { selectModelDetail(null); return; }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    // Not from a control that takes the arrow keys itself (a slider's
    // thumb, the pan buttons, a dropdown, the model search).
    const t = e.target;
    if (t !== document.body && !t.closest?.(".model-detail")) return;
    if (t.matches?.("input, select, textarea")) return;
    const order = barOrder();
    const i = order.indexOf(detailModel), j = i + (e.key === "ArrowLeft" ? -1 : 1);
    if (i < 0 || j < 0 || j >= order.length) return;
    e.preventDefault();
    selectModelDetail(order[j]);
    revealBar(j);
  });
}

/** The models in the bar chart's order (its ranking; top to bottom in
 *  rows), or [] for another chart. */
function barOrder() {
  const gd = document.getElementById("chart");
  return gd?.data?.[0]?.type === "bar" && gd._barModels ? gd._barModels : [];
}

/** After a chart's newPlot: a click on a model's bar or point opens it (a
 *  bar pops as it does: chart.js); with a mouse, the pointer says the bars
 *  can be clicked. */
function bindModelDetailClicks(chartEl) {
  if (!chartEl) return;
  chartEl.on("plotly_click", (data) => {
    if (touchEcho(data.event) || drawnBarHits(chartEl)) return;   // (a mouse on columns: below)
    const pt = data.points?.[0];
    // (Columns only: a row's length is its score.)
    if (pt?.data?.type === "bar" && pt.data.orientation !== "h") chartEl._barPop?.(pt.pointNumber);
    openFromChart(pt?.customdata?.modelDir);
  });
  const drag = () => chartEl.querySelector(".nsewdrag");
  chartEl.on("plotly_hover", () => { if (FINE_POINTER.matches && !drawnBarHits(chartEl)) drag()?.classList.add("bar-clickable"); });
  chartEl.on("plotly_unhover", () => { if (!drawnBarHits(chartEl)) drag()?.classList.remove("bar-clickable"); });
  // A mouse on columns: the bar drawn under the pointer is hovered (the
  // tooltip, the pointer cursor) …
  chartEl._onBarUnder = (col, ev) => {
    if (!drawnBarHits(chartEl)) return;
    const trace = chartEl.data[0];
    if (col < 0 || !trace.customdata?.[col]) {
      drag()?.classList.remove("bar-clickable");
      onChartUnhover();
      return;
    }
    drag()?.classList.add("bar-clickable");
    if (ev) onChartHover({ points: [{ customdata: trace.customdata[col], x: trace.x[col], y: trace.y[col], data: trace }], event: ev, drawn: true });
  };
  // … and clicked: a press and release on the chart without a drag (Plotly's
  // threshold, 8px: more pans a panning chart). (Bound once: the chart's
  // element outlives its plots.)
  if (chartEl._drawnClicks) return;
  chartEl._drawnClicks = true;
  let press = null;
  chartEl.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.(".modebar")) { press = null; return; }
    press = e.pointerType === "mouse" && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  }, true);
  // (On the document: the release lands on Plotly's cover over the page.)
  document.addEventListener("pointerup", (e) => {
    const p = press;
    press = null;
    if (!p || e.pointerType !== "mouse" || !drawnBarHits(chartEl)) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) return;
    const col = chartEl._barColumnAt(e.clientX, e.clientY);
    const m = col >= 0 ? chartEl.data[0].customdata?.[col]?.modelDir : null;
    if (!m) return;
    chartEl._barPop?.(col);
    openFromChart(m);
  }, true);
}

/** What a click on acts on itself (it doesn't close the drawer). */
const ACTS_ITSELF = "a[href], button, input, select, textarea, label, summary, [role=button], [role=option], "
  + "[role=listbox], .ui-select, .ui-select-options, .modebar, .range-slider";

/** When the chart last picked a model (a click on a bar, a row, a point, a
 *  name): the click doesn't also close the drawer. */
let pickedAt = -Infinity;

/** A click (or tap) on model `m` in the chart. */
function openFromChart(m) {
  if (!m) return;
  pickedAt = performance.now();
  if (FINE_POINTER.matches) selectModelDetail(m === detailModel ? null : m);
  else selectModelDetail(m, { tap: true });
}

/** Open model `m`'s details (null: close them). The panel comes into
 *  sight: scrolled to after a click, a button to it after a tap. */
function selectModelDetail(m, { tap = false } = {}) {
  if (m === detailModel) {
    if (m && tap) detailView?.reveal("button");
    return;
  }
  const was = detailModel;
  if (!m) closeTaskDetail({ animate: false });
  detailModel = m;
  urlState.save();
  refreshChartTip();
  if (DRAWER_SCREEN.matches && !was !== !m) {
    if (m) openDrawer(); else closeDrawer(was);
    return;
  }
  if (m) {
    detailView.show(modelDetailData(m), { reveal: tap ? "button" : "scroll" });
    loadDetailScores();
  } else {
    detailView.hide({ animate: true });
  }
  moveBand(m)?.play?.();
}

/** The drawer slides in, the page shifting with it if the controls need
 *  room, the band fading in. All the heavy work comes first, before
 *  anything moves: the drawer's content (laid out off the window), the
 *  page's layout for it, the band's relayout. Once in, a chart that
 *  doesn't pan is laid out again to end at the drawer's edge, and the
 *  chart pans to the open model's bar if the drawer covers it. */
async function openDrawer() {
  const move = drawerMove = {};
  const cl = document.body.classList;
  const shift = placeDrawer();
  cl.add("detail-layout");
  detailView.show(modelDetailData(detailModel), { offWindow: true });
  loadDetailScores();
  const band = moveBand(detailModel, { wait: true });
  await nextFrame();
  await nextFrame();   // (laid out and painted, nothing moved yet)
  if (move !== drawerMove) return;
  const motion = [detailView.slide(true), ...shiftPage(0, -shift), band?.()].filter(Boolean);
  await Promise.all(motion.map((a) => a.finished.catch(() => {})));
  if (move !== drawerMove) return;
  cl.add("detail-open", "detail-cover");   // (the page's shift held by style.css now)
  for (const a of motion) a.cancel();
  drawerMove = null;
  const chart = document.getElementById("chart");
  if (chartCovered() > 0 && !chart.classList.contains("bar-pan")) {
    holdBarAnimation();
    renderChart();
  } else {
    refreshBarPan();
    refreshBarHover(chart);   // (the bars moved with the page)
    refreshModelDetail();     // (results that came in while it moved)
  }
  revealBar(barOrder().indexOf(detailModel));
  rehover();
}

/** The drawer slides off, the page shifting back, the band fading out. A
 *  chart laid out to end at the drawer is first drawn whole again (under
 *  it, before anything moves). */
async function closeDrawer(was) {
  const move = drawerMove = {};
  const cl = document.body.classList;
  const shift = cl.contains("detail-open") ? pageShift() : 0;
  cl.remove("detail-cover");
  bandModel = was;
  if (chartCut() > 0) {
    setChartCut(0);
    holdBarAnimation();
    renderChart();
    await nextFrame();
    await nextFrame();
    if (move !== drawerMove) return;
  } else {
    refreshBarPan();   // (› back outside the plot, under the drawer still)
  }
  cl.remove("detail-open");   // (the shift's motion takes over from here)
  const motion = [detailView.slide(false), ...shiftPage(-shift, 0), moveBand(null)].filter(Boolean);
  await Promise.all(motion.map((a) => a.finished.catch(() => {})));
  if (move !== drawerMove) return;
  cl.remove("detail-layout");
  for (const a of motion) a.cancel();
  drawerMove = null;
  const chart = document.getElementById("chart");
  refreshBarPan();
  refreshBarHover(chart);   // (the bars moved back with the page)
  rehover();
}

/** The page (its columns, and the flag line's flag) slides from `from` to
 *  `to` px: the Animations, held at `to` when done. */
function shiftPage(from, to) {
  if (Math.abs(from - to) < 0.5) return [];
  const frames = [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }];
  const motion = [...document.querySelectorAll(".band-inner")].map((e) => e.animate(frames, detailMotion({ fill: "forwards" })));
  const flag = document.querySelector(".flag-line");
  if (flag) motion.push(flag.animate(frames, detailMotion({ fill: "forwards", pseudoElement: "::before" })));
  return motion;
}

/** Whether the drawer is open beside the chart, settled. */
function drawerSettled() {
  return DRAWER_SCREEN.matches && document.body.classList.contains("detail-open") && !drawerMove;
}

/** Whether the drawer covers the page's right end (renders keep to its
 *  edge or run under it). */
function drawerBeside() {
  return DRAWER_SCREEN.matches && document.body.classList.contains("detail-cover");
}

const bodyPx = (name) => parseFloat(document.body.style.getPropertyValue(name)) || 0;
/** The page's shift for the open drawer (px, leftwards). */
function pageShift() { return document.body.classList.contains("detail-open") ? bodyPx("--page-shift") : 0; }
/** The drawer's left edge on the screen. */
function drawerEdge() { return document.documentElement.clientWidth - (bodyPx("--drawer-w") || DRAWER_MAX_PX); }
/** The px of the chart's box the drawer would cover (the box as without a cut). */
function chartCovered() {
  const f = closedChartFrame();
  return Math.max(0, f.left + f.width - pageShift() - drawerEdge());
}
function chartCut() { return bodyPx("--chart-cut"); }
function setChartCut(px) { document.body.style.setProperty("--chart-cut", Math.max(0, Math.ceil(px)) + "px"); }

/** The chart's width and left edge on the screen without the drawer: from
 *  the layout (the page's shift is a transform; a cut left out). */
function closedChartFrame() {
  const chart = document.getElementById("chart");
  const zone = chart.closest(".chart-zone");
  const reach = -parseFloat(getComputedStyle(chart).marginLeft) || 0;   // into the page's padding
  return { width: zone.offsetWidth + reach, left: layoutLeft(zone) - reach };
}

/** An element's left edge in the page's layout (transforms left out). */
function layoutLeft(el) {
  let x = 0;
  for (let e = el; e; e = e.offsetParent) x += e.offsetLeft;
  return x - window.scrollX;
}

const DRAWER_MAX_PX = 420, DRAWER_MIN_PX = 360;
const DRAWER_GAP_PX = 12;     // between the controls (or the sections below) and the drawer
const PAGE_KEEP_LEFT_PX = 60; // the page slides left no further: ‹ stays outside the plot

/** The drawer's place, the page's layout kept (style.css body.detail-*):
 *  the page slides left (--page-shift) just far enough for the controls'
 *  right end to clear the drawer, keeping room for ‹ on the left; failing
 *  that, the drawer narrows (--drawer-w, to DRAWER_MIN_PX), and failing
 *  that too, the controls wrap (--controls-inset). The sections below the
 *  chart clear it (--page-inset). Returns the shift. */
function placeDrawer() {
  const body = document.body, chart = document.getElementById("chart");
  const zone = chart?.closest(".chart-zone");
  if (!zone) return 0;
  const W = document.documentElement.clientWidth;
  body.style.setProperty("--controls-inset", "0px");   // (measured unwrapped)
  const zoneLeft = layoutLeft(zone), zoneRight = zoneLeft + zone.offsetWidth;
  const zr = zone.getBoundingClientRect();
  const controlsRight = zoneLeft + Math.max(0, ...[...zone.querySelectorAll(".controls-bar .control-group")]
    .filter((g) => g.offsetParent).map((g) => g.getBoundingClientRect().right - zr.left));
  const maxShift = Math.max(0, zoneLeft - PAGE_KEEP_LEFT_PX);
  const need = (w) => controlsRight + DRAWER_GAP_PX - (W - w);
  let width = DRAWER_MAX_PX;
  const shift = Math.round(Math.min(maxShift, Math.max(0, need(width))));
  if (need(width) > maxShift) width = Math.max(DRAWER_MIN_PX, W - (controlsRight - shift) - DRAWER_GAP_PX);
  const edge = W - width;
  body.style.setProperty("--drawer-w", width + "px");
  body.style.setProperty("--page-shift", shift + "px");
  body.style.setProperty("--controls-inset", Math.max(0, Math.ceil(controlsRight - shift + DRAWER_GAP_PX - edge)) + "px");
  body.style.setProperty("--page-inset", Math.max(0, Math.ceil(zoneRight - shift + 24 - edge)) + "px");
  return shift;
}

/** placeDrawer with the drawer open: a changed shift glides. */
function placeDrawerAgain() {
  const was = pageShift();
  const shift = placeDrawer();
  if (shift !== was) {
    shiftPage(-was, -shift).forEach((a) => a.finished.then(() => a.cancel(), () => {}));
    refreshBarPan();
  }
}

/** Before a render: with no opening or closing under way, the page as the
 *  details want it — a drawer open or not (a link opening one; across the
 *  breakpoint) — and the band. */
function syncModelDetail() {
  if (!drawerMove) {
    const cl = document.body.classList;
    if (detailModel && DRAWER_SCREEN.matches) {
      if (cl.contains("detail-open")) placeDrawerAgain();
      else { placeDrawer(); cl.add("detail-layout", "detail-open", "detail-cover"); }
    } else {
      cl.remove("detail-layout", "detail-open", "detail-cover");
      setChartCut(0);
    }
  }
  if (!bandFadingOut) bandModel = detailModel;
}

/** After a render: the details show the open model (their content doesn't
 *  follow the chart; it changes with the details' shot, or as the models'
 *  results come in — a link opening the details loads the compared models
 *  here). */
function refreshModelDetail() {
  if (!detailView || drawerMove) return;
  if (detailModel) {
    detailView.show(modelDetailData(detailModel));
    loadDetailScores();
  } else {
    detailView.hide();
  }
  syncTaskDetail();
}

/** After a redraw under the mouse: replayPointer, now and (a new chart
 *  is finished asynchronously, its logos loading) once Plotly's drag layer
 *  is there. */
function rehover() {
  replayPointer();
  replayPointerSoon();
}

/** replayPointer at the next frame (once, however often asked: a pan);
 *  while the mouse is over the plot and its drag layer isn't drawn yet, a
 *  few frames later. */
let replayFrame = null;
function replayPointerSoon(tries = 30) {
  if (replayFrame !== null) return;
  replayFrame = requestAnimationFrame(() => {
    replayFrame = null;
    if (replayPointer() === "wait" && tries > 1) replayPointerSoon(tries - 1);
  });
}

/** Hover the chart where the mouse is (after a redraw or a relayout that
 *  moved things under a still mouse): the bar's magnification, its bold
 *  name and its tooltip follow the mouse, not where it was. */
function replayPointer() {
  if (!lastPointer || !FINE_POINTER.matches) return;
  const { x, y } = lastPointer;
  const chart = document.getElementById("chart");
  const el = document.elementFromPoint(x, y);
  if (!chart || !el || !chart.contains(el)) return;
  // Over the plot, to Plotly's drag layer (its hover listens there; the
  // event bubbles on to the chart's own hover); elsewhere on the chart, to
  // the element there.
  const fl = chart._fullLayout, c = chart.getBoundingClientRect();
  const overPlot = !!fl?._size && x >= c.left + fl._size.l && x <= c.left + fl._size.l + fl._size.w
    && y >= c.top + fl._size.t && y <= c.top + fl._size.t + fl._size.h;
  const drag = chart.querySelector(".nsewdrag");
  if (overPlot && !drag) return "wait";
  (overPlot ? drag : el).dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window }));
}

/** The band's colour for model `m`, [r, g, b, alpha]. */
function bandColor(m, alpha) {
  const c = getModelColor(m);
  return [...(/^#[0-9a-f]{6}$/i.test(c) ? hexToRgb(c) : [99, 102, 241]), alpha];
}
const rgbaText = ([r, g, b, a]) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`;
const rgbText = ([r, g, b]) => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;

/** The band shape behind bar (row: `horizontal`) `pos`. A row's band is the
 *  row across the whole chart, its name too (rowBandPath). */
function bandShape(pos, color, horizontal) {
  if (horizontal) {
    return { type: "path", name: SELECTED_MARK, layer: "below", xref: "paper", yref: "y",
      path: rowBandPath(pos), fillcolor: rgbaText(color), line: { width: 0 } };
  }
  return { type: "rect", name: SELECTED_MARK, layer: "below", xref: "x", yref: "paper",
    x0: pos - 0.5, x1: pos + 0.5, y0: 0, y1: 1, fillcolor: rgbaText(color), line: { width: 0 } };
}

/** Row `pos`'s band on the phone's chart: a rounded rectangle the row's
 *  height from the chart's left edge (under the name) to its right, in
 *  paper units across (from the plot's margins: rowBandSpan) and rows down. */
let rowBandSpan = { x0: 0, x1: 1, rx: 0 };
function rowBandPath(pos) {
  const { x0, x1, rx } = rowBandSpan, ry = ROW_BAND_RADIUS_PX / ROW_PX;
  const y0 = pos - 0.5, y1 = pos + 0.5;
  return `M${x0 + rx},${y0} L${x1 - rx},${y0} Q${x1},${y0} ${x1},${y0 + ry} L${x1},${y1 - ry} Q${x1},${y1} ${x1 - rx},${y1}`
    + ` L${x0 + rx},${y1} Q${x0},${y1} ${x0},${y1 - ry} L${x0},${y0 + ry} Q${x0},${y0} ${x0 + rx},${y0} Z`;
}

/** The bar names with the open model's in bold (a row's name may run over
 *  two lines). */
function boldLabels(labels, i) {
  return labels.map((l, j) => (j === i ? l.split("<br>").map((part) => "<b>" + part + "</b>").join("<br>") : l));
}

/** The open model's band and bold name, for a bar chart's layout. */
function selectionMark(modelNames, labels, horizontal = false) {
  const i = bandModel ? modelNames.indexOf(bandModel) : -1;
  return {
    shapes: i < 0 ? [] : [bandShape(i, bandColor(bandModel, BAND_ALPHA), horizontal)],
    ticktext: boldLabels(labels, detailModel ? modelNames.indexOf(detailModel) : -1),
  };
}

/** The band's path in the bar chart as drawn. */
function bandPath(gd) {
  const k = (gd.layout.shapes || []).findIndex((sh) => sh.name === SELECTED_MARK);
  return k < 0 ? null : gd.querySelector(`.shapelayer path[data-index="${k}"]`);
}

/** The band and the bold name as bandModel and detailModel want them, in
 *  one relayout of the bar chart as drawn. */
function setBand(gd, horizontal, order) {
  const shapes = (gd.layout.shapes || []).filter((sh) => sh.name !== SELECTED_MARK);
  const i = bandModel ? order.indexOf(bandModel) : -1;
  if (i >= 0) shapes.push(bandShape(i, bandColor(bandModel, BAND_ALPHA), horizontal));
  Plotly.relayout(gd, {
    shapes, [horizontal ? "yaxis.ticktext" : "xaxis.ticktext"]: boldLabels(gd._barLabels, detailModel ? order.indexOf(detailModel) : -1),
  });
}

/** The band to model `to`'s bar on the bar chart as drawn (null: away),
 *  and its motion on the new path: fading in, gliding from the old bar
 *  (taking the new colour), or fading out (then gone, in one relayout).
 *  Returns the motion's Animation, started; with `wait`, a function that
 *  starts it (the band unseen till then). The relayout comes first, the
 *  motion runs on the path alone (no relayouts while it moves). */
function moveBand(to, { wait = false } = {}) {
  const gd = document.getElementById("chart");
  const order = barOrder();
  const from = bandModel;
  if (!order.length) { bandModel = to; bandFadingOut = false; return null; }
  const horizontal = gd.data[0].orientation === "h";
  const ax = horizontal ? gd._fullLayout.yaxis : gd._fullLayout.xaxis;
  const iFrom = from ? order.indexOf(from) : -1, iTo = to ? order.indexOf(to) : -1;
  let path, frames, fill;
  if (iTo < 0) {
    path = bandPath(gd);
    const gone = () => {
      if (!bandFadingOut) return;
      bandFadingOut = false;
      bandModel = detailModel;
      setBand(gd, horizontal, barOrder());
    };
    bandFadingOut = true;
    if (!path) { gone(); return null; }
    frames = [{ opacity: 1 }, { opacity: 0 }];
    fill = "forwards";
    const start = () => {
      const a = path.animate(frames, detailMotion({ fill }));
      a.finished.then(gone, () => {});
      return a;
    };
    return wait ? start : start();
  }
  bandFadingOut = false;
  bandModel = to;
  setBand(gd, horizontal, order);
  path = bandPath(gd);
  if (!path || iFrom === iTo) return null;
  if (iFrom < 0) frames = [{ opacity: 0 }, { opacity: 1 }];
  else {
    const d = ax.l2p(iFrom) - ax.l2p(iTo);
    frames = [{ transform: horizontal ? `translateY(${d}px)` : `translateX(${d}px)`, fill: rgbText(bandColor(from, 1)) },
      { transform: "none", fill: rgbText(bandColor(to, 1)) }];
  }
  if (wait) path.style.opacity = "0";
  const start = () => {
    path.style.opacity = "";
    return path.animate(frames, detailMotion());
  };
  return wait ? start : start();
}

/** chart.js's bar hover: the band, with its bar's index (it widens and
 *  moves with the bar). */
function bandFollowers() {
  const gd = document.getElementById("chart");
  const i = bandModel ? barOrder().indexOf(bandModel) : -1;
  if (i < 0 || gd.data[0].orientation === "h") return [];
  const el = bandPath(gd);
  if (!el) return [];
  el.style.transformBox = "fill-box";
  el.style.transformOrigin = "50% 50%";
  return [{ el, modelIdx: i }];
}

/** The variant a task's name doesn't say (its written standard). */
function taskVariant(bench, name) {
  if (/[→↔]|Bokmål|Nynorsk|English|Sámi/.test(name)) return "";
  return bench.endsWith("_nob") ? "Bokmål" : bench.endsWith("_nno") ? "Nynorsk" : "";
}

/** Run `fn` with state's fields patched (restored after). */
function withState(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = state[k]; state[k] = patch[k]; }
  try { return fn(); } finally { Object.assign(state, saved); }
}

/** The details' shot: the one picked in them, else the page's default. */
function detailShotNow() {
  const shots = shotValues();
  if (shots.includes(detailShot)) return detailShot;
  return shots.includes(CFG.defaultShot) ? CFG.defaultShot : shots[shots.length - 1];
}

/** The models the details compare: all of the dashboard's, shown on the
 *  chart or not, that have results in `source` (detailResults). */
function detailModels(source) {
  return allModelIds().filter((x) => isKnownModel(x) && Object.hasOwn(source, x));
}

// Every model's best-prompt score on each task's main metric at each shot
// (details/best.json, build_data.py write_task_details), for a page whose
// results are in per-model files: the details compare all models without
// loading each one's results. As results: {model: {task: {shot: {metric:
// {max}}}}}, or {} if the file can't be loaded.
let bestScores = null;
let bestScoresLoad = null;

/** Load the best scores (once; on a page with every model's results in
 *  data.json there is nothing to load). */
function loadBestScores() {
  if (!state.DATA.model_ids) return Promise.resolve();
  if (!bestScoresLoad) {
    const url = "details/best.json" + (state.DATA.details_version ? "?v=" + state.DATA.details_version : "");
    bestScoresLoad = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(r.status + " " + r.statusText + " (" + url + ")"); return r.json(); })
      .then((b) => {
        const out = {};
        b.models.forEach((m, i) => {
          const results = out[m] = {};
          b.tasks.forEach((t, j) => {
            const metric = state.metricsSetup[t]?.main_metric;
            if (!metric) return;
            for (const [shot, rows] of Object.entries(b.shots)) {
              const v = rows[i]?.[j];
              if (v != null) (results[t] ||= {})[shot] = { [metric]: { max: v } };
            }
          });
        });
        bestScores = out;
      })
      .catch((err) => { console.error("Could not load the models' best scores:", err); bestScores = {}; });
  }
  return bestScoresLoad;
}

/** The results the details read: every model's best scores, else (on a
 *  page with every model's results, or before the best scores are in, or
 *  if they can't be) the results loaded. */
function detailResults() {
  return bestScores && Object.keys(bestScores).length ? bestScores : state.DATA.models;
}

/** Load the details' best scores if they aren't in yet (the details follow). */
function loadDetailScores() {
  if (bestScores || !state.DATA.model_ids) return;
  loadBestScores().then(() => { if (detailModel) refreshModelDetail(); });
}

/** The details' content for model `m`, whatever the chart shows: with the
 *  best prompt and random-baseline rescaling, over all tasks — its card
 *  (facts: lines of items); its category average at each shot; and its
 *  profile at the details' shot: per category, each task's score with
 *  every compared model's (detailModels) score on the same scale. */
function modelDetailData(m) {
  const shot = detailShotNow();
  const source = detailResults();
  const models = detailModels(source);
  if (!models.includes(m)) models.push(m);
  const signature = [shot, models.join(","), source === bestScores ? "best" : "loaded"].join("|");
  const key = m + "|" + signature;
  if (detailCache?.key === key) return detailCache.data;
  const tasks = Object.keys(state.metricsSetup);
  const fixed = {
    currentShot: shot, currentPromptAgg: CFG.promptAgg, currentNormalization: CFG.normalization, currentMetric: null,
    currentTaskSelection: DEFAULT_SELECTION, checkedTasks: new Set(tasks), showCIBands: false,
    DATA: { ...state.DATA, models: source },
  };
  const data = withState(fixed, () => {
    const idx = models.indexOf(m);
    const fmt = scoreDecimals();
    const ok = (v) => v != null && !Number.isNaN(v);
    const text = (v) => (ok(v) ? v.toFixed(fmt) : "–");
    const mine = (vals) => ({ value: ok(vals[idx]) ? vals[idx] : null, text: text(vals[idx]) });
    // The category average over all tasks at each shot count (the shot
    // shown in the details is one of them: the label says no shot).
    const headline = CFG.detailAverage ? { label: capitalize(getChartTitleText().replace(` (${shot}-shot)`, "")) } : null;
    const shots = shotValues().map((s) => ({
      shot: s, current: s === shot, text: text(withState({ currentShot: s }, () => aggregateModelResult(m, models)?.score)),
    }));
    const byCat = new Map();
    for (const b of tasks) {
      const all = models.map((mm) => {
        const raw = getScore(state.DATA.models, mm, b, shot);
        return raw === undefined ? null : normScore(raw, b, null);
      });
      const info = state.metricsSetup[b];
      const name = info.pretty_name || b;
      const cat = info.category || "other";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push({ key: b, name, variant: taskVariant(b, name), ...mine(all), all });
    }
    // The categories in CATEGORY_ORDER, each its tasks' heading.
    const groups = [...byCat].sort(([a], [b]) => compareCategories(a, b)).map(([cat, rows]) => {
      rows.sort((a, b) => a.name.localeCompare(b.name) || a.variant.localeCompare(b.variant));
      return { key: "__cat__" + cat, name: capitalize(cat), rows };
    });
    // One scale for every row, from the lowest to the highest value shown.
    const values = groups.flatMap((g) => g.rows.flatMap((r) => r.all)).filter(ok);
    if (!values.length) values.push(0);
    let lo = Math.min(...values), hi = Math.max(...values);
    if (!(hi > lo)) { lo -= state.scoreTop / 100; hi += state.scoreTop / 100; }
    const pad = (hi - lo) * 0.03;
    return { headline, shots, groups, domain: [lo - pad, hi + pad] };
  });
  const info = state.DATA.model_info?.[m];
  const url = info?.huggingface_url;
  const color = getModelColor(m);
  const params = state.DATA.model_parameters?.[m];
  Object.assign(data, {
    model: m, title: getModelLabel(m), color, signature, others: models.length - 1,
    badge: () => orgBadge(modelOrg(m), color),
    facts: [
      [modelOrg(m), params ? formatModelSize(params) + " parameters" : ""].filter(Boolean),
      [info?.license ? "License: " + info.license : "", getModelOpenLabel(m)].filter(Boolean),
    ].filter((line) => line.length),
    description: info?.description || "",
    link: url ? { href: url, text: shortUrl(url) } : null,
  });
  detailCache = { key, data };
  return data;
}

// ─────────────────────────────────────────────────────────────
// Task details (task-detail.js)
// ─────────────────────────────────────────────────────────────
// A click on a task's row in the model's details opens the task's details
// over them, grown out of the row: the task, and the model's results on it,
// from the task's file (details/tasks/<task>.json), which starts loading
// when the pointer comes over the row. They follow the details' model and
// shot (a shot picked in them is the details'). × or Esc closes them,
// shrinking back into the row; closing the model's details closes them
// too. A link with the task in it (URL `detail`, with `model`) opens them.

const taskFiles = new Map();   // task → {promise, data (undefined until loaded; null if it can't be)}
let taskOpening = null;        // a token while a task's details wait for its file
let taskDetailCache = null;    // {key, data}: the task details' last content

/** Load task `task`'s file (once): a promise of its content, null if it
 *  can't be loaded. */
function loadTaskFile(task) {
  if (!Object.hasOwn(state.metricsSetup, task)) return Promise.resolve(null);
  let entry = taskFiles.get(task);
  if (!entry) {
    const url = "details/tasks/" + encodeURIComponent(task) + ".json"
      + (state.DATA.details_version ? "?v=" + state.DATA.details_version : "");
    entry = { data: undefined };
    entry.promise = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(r.status + " " + r.statusText + " (" + url + ")"); return r.json(); })
      .catch((err) => { console.error(`Could not load the details of ${task}:`, err); return null; })
      .then((data) => (entry.data = data));
    taskFiles.set(task, entry);
  }
  return entry.promise;
}

/** Start loading what task `task`'s details show: its file, and on a
 *  judged page the open model's responses to its examples. */
function loadTaskData(task) {
  if (state.DATA.instruct && detailModel && Object.hasOwn(state.metricsSetup, task)) loadResponses(detailModel, task);
  return loadTaskFile(task);
}

/** Open task `task`'s details from its row in the model's details (once
 *  its file is in). */
async function openTaskDetail(task, row) {
  if (!detailModel) return;
  const token = taskOpening = {};
  detailTask = task;
  detailExample = 0;
  urlState.save();
  await loadTaskData(task);
  if (taskOpening !== token || detailTask !== task || !detailModel) return;
  taskOpening = null;
  hideTooltip();
  const from = row?.isConnected ? row.getBoundingClientRect() : null;
  taskView.show(taskDetailData(detailModel, task), { from, refocusTo: row });
}

/** Show model `m`'s details of the open task, in place (a click on its row
 *  in the task's list of models): the model's details under the view, and
 *  the chart's band, follow it. */
function openTaskModel(m) {
  if (!m || m === detailModel || !detailTask || !isKnownModel(m) || !detailView) return;
  detailModel = m;
  urlState.save();
  refreshChartTip();
  detailView.show(modelDetailData(m));
  loadDetailScores();
  moveBand(m)?.play?.();
  syncTaskDetail();
}

/** Close the task's details: shrunk back into its row (`animate`), else
 *  at once. */
function closeTaskDetail({ animate = true } = {}) {
  const task = detailTask;
  detailTask = null;
  detailExample = 0;
  taskOpening = null;
  urlState.save();
  if (!taskView?.isOpen()) return;
  const row = task && detailView?.taskRow(task);
  taskView.hide({ to: animate && row ? row.getBoundingClientRect() : null, focus: row });
}

/** The task's details as the state wants them: shown for the open model
 *  and shot (opened at once, from a link: once the task's file is in), or
 *  closed. */
function syncTaskDetail() {
  if (!taskView || taskOpening) return;
  if (!detailModel || !detailTask) {
    if (taskView.isOpen()) taskView.hide();
    return;
  }
  const entry = taskFiles.get(detailTask);
  if (entry && entry.data !== undefined) {
    taskView.show(taskDetailData(detailModel, detailTask));
    return;
  }
  const token = taskOpening = {};
  loadTaskFile(detailTask).then(() => {
    if (taskOpening !== token) return;
    taskOpening = null;
    syncTaskDetail();
  });
}

/** A task's name as a title: capitalized, its dataset's name cased as a
 *  proper noun ("Reading comprehension (Belebele)"). */
function taskTitle(name) {
  const m = name.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (!m) return capitalize(name);
  const inner = TASK_NAME_DISPLAY[m[2].toLowerCase()] || m[2];
  return capitalize(m[1]) + " (" + inner + ")";
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five"];

/** How the task's answers are scored (the prompts' note), for `shot`. */
function scoringNote(about, prompts, shot) {
  const out = [];
  if (about.output === "multiple_choice") {
    out.push(prompts.every((p) => !p.text && !p.instruction)
      ? "No prompt: each answer option is scored on its own, and the one the model finds most likely is its answer."
      : "The answer option the model finds most likely is its answer.");
  } else if (about.output === "generate_until") {
    const until = about.until || [];
    const stop = until.includes("\n") ? " until a line break" : until.includes("\n\n") ? " until an empty line" : "";
    const most = about.max_tokens ? ` (at most ${about.max_tokens} tokens)` : "";
    out.push(`The model writes its answer${about.sampling ? "" : " greedily"}${stop}${most}, scored against the reference.`);
  }
  const k = +shot;
  if (k > 0) {
    const n = NUMBER_WORDS[k] || String(k);
    out.push(`At ${shot}-shot, ${n} solved example${k === 1 ? " comes" : "s come"} first, in the same format.`);
  }
  return out.join(" ");
}

/** The task details' content for model `m` on task `task`, at the
 *  details' shot (task-detail.js): best prompt, random-baseline rescaling,
 *  every model of the dashboard that has results for the task. */
function taskDetailData(m, task) {
  if (state.DATA.instruct) return judgedTaskDetailData(m, task);
  const info = state.metricsSetup[task];
  const file = taskFiles.get(task)?.data || null;
  const shot = detailShotNow();
  const key = [m, task, shot, !!file].join("|");
  if (taskDetailCache?.key === key) return taskDetailCache.data;
  const name = info.pretty_name || task;
  const color = getModelColor(m);
  const metric = METRIC_DISPLAY[info.main_metric] || info.main_metric;
  const about = file?.about || {};
  const prompts = file?.prompts || [];
  const ids = file ? file.models : [];
  const mi = ids.indexOf(m);
  const known = ids.map((id) => isKnownModel(id));
  const url = info.url || (about.dataset ? "https://huggingface.co/datasets/" + about.dataset : "");
  const fixed = { currentShot: shot, currentPromptAgg: "max", currentNormalization: CFG.normalization, currentMetric: null };
  const data = withState(fixed, () => {
    const fmt = scoreDecimals();
    const norm = (v) => (v == null || Number.isNaN(v) ? null : normScore(v, task, null));
    const text = (v) => (v == null ? "–" : v.toFixed(fmt));
    const best = (vals) => {
      const ok = (vals || []).filter((v) => v != null);
      return ok.length ? Math.max(...ok) : null;
    };
    const ci = (pair) => (pair ? [norm(pair[0]), norm(pair[1])] : null);
    const block = file?.shots?.[shot];
    // The model's best score at each shot.
    const shots = shotValues().map((s) => {
      const v = norm(best(file?.shots?.[s]?.prompts[mi]));
      return { shot: s, current: s === shot, text: text(v) };
    });
    // A row of every model's scores at this shot: `pick(row of a model)`.
    const scoreRow = (key, label, pick, pickCI) => {
      const all = ids.map((id, j) => (known[j] && block?.[key]?.[j] ? norm(pick(block[key][j])) : null));
      const value = mi >= 0 ? all[mi] : null;
      return { name: label, value, text: text(value), all, ci: mi >= 0 && pickCI ? ci(pickCI(mi)) : null };
    };
    const mine = mi >= 0 ? block?.prompts[mi] || [] : [];
    const top = mine.length > 1 ? mine.indexOf(best(mine)) : -1;
    const promptRows = prompts.map((p, i) => ({
      ...scoreRow("prompts", `Prompt ${i + 1}`, (r) => r[i], (j) => block?.prompt_ci?.[j]?.[i]),
      key: "p" + i, best: i === top, template: p,
    }));
    const partRows = file?.parts?.length
      ? file.parts.map((code, i) => ({
          ...scoreRow("parts", info.subtasks?.[code]?.pretty_name || code, (r) => r[i], (j) => block?.part_ci?.[j]?.[i]),
          key: code, note: info.subtasks?.[code]?.description || "",
        }))
      : null;
    // Every model's best score, in order.
    const ranked = ids.map((id, j) => (known[j] && block ? { id, name: getModelLabel(id), value: norm(best(block.prompts[j])), me: j === mi } : null))
      .filter((r) => r && r.value != null)
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    for (const r of ranked) r.text = text(r.value);
    const bestCI = mi >= 0 ? ci(block?.best_ci?.[mi]) : null;
    // The strips' scale: from the lowest to the highest value shown; the
    // bars' from 0.
    const shown = [
      ...promptRows.flatMap((r) => (promptRows.length > 1 ? [...r.all, ...(r.ci || [])] : [])),
      ...(partRows || []).flatMap((r) => [...r.all, ...(r.ci || [])]),
    ].filter((v) => v != null);
    let lo = shown.length ? Math.min(...shown) : 0, hi = shown.length ? Math.max(...shown) : 1;
    if (!(hi > lo)) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.03;
    const barValues = [0, ...ranked.map((r) => r.value), ...(bestCI || [])];
    const barLo = Math.min(...barValues), barHi = Math.max(...barValues);
    const others = ranked.filter((r) => !r.me).length;
    const several = prompts.length > 1;
    const rescaled = info.random_baseline > 0 ? ", rescaled from random guessing (0) to a perfect score (100)" : "";
    return {
      task, shot,
      model: { id: m, title: getModelLabel(m), color, badge: () => orgBadge(modelOrg(m), color) },
      title: taskTitle(name), variant: taskVariant(task, name),
      link: url ? { href: url, text: shortUrl(url) } : null,
      description: info.description || "",
      headline: { label: capitalize(metric) + (several ? " with its best prompt" : "") + rescaled },
      shots, others,
      note: file ? scoringNote(about, prompts, shot) : "The task's prompts and scores could not be loaded.",
      prompts: promptRows, parts: partRows,
      domain: [lo - pad, hi + pad],
      ranking: {
        title: ranked.length + " models",
        note: `${shot}-shot${several ? ", each with its best prompt" : ""}.`,
        rows: ranked, ci: bestCI, domain: [barLo, barHi + (barHi - barLo) * 0.02],
      },
    };
  });
  taskDetailCache = { key, data };
  return data;
}

// ─────────────────────────────────────────────────────────────
// Judged tasks (/instruct)
// ─────────────────────────────────────────────────────────────
// On an LLM-judged page a task's score is the judge's mean grade of the
// model's responses, from 0 to 5 points, over the task's draws, each draw
// an item and a prompt variant picked at random
// (the same for every model). Its view (task-detail.js) shows that score
// and how the grades fell, every model's score, and the examples: the
// first draws, each with the model's response and the judge's grade and
// assessment, and every other model's grade, which unfolds into its
// response (details/responses/<model>/<task>.json, loaded when shown).

const Z95 = 1.959963984540054;   // a 95% interval: ± this many standard errors

const responseFiles = new Map();   // "model/task" → promise of the file (null if it can't be loaded)

/** Load model `m`'s responses to task `task`'s examples (once): a promise
 *  of the file, null if it can't be loaded. */
function loadResponses(m, task) {
  const key = m + "/" + task;
  if (!responseFiles.has(key)) {
    const url = "details/responses/" + encodeURIComponent(m) + "/" + encodeURIComponent(task) + ".json"
      + (state.DATA.details_version ? "?v=" + state.DATA.details_version : "");
    responseFiles.set(key, fetch(url)
      .then((r) => { if (!r.ok) throw new Error(r.status + " " + r.statusText + " (" + url + ")"); return r.json(); })
      .catch((err) => { console.error(`Could not load the responses of ${m} to ${task}:`, err); return null; }));
  }
  return responseFiles.get(key);
}

/** The task details' content for model `m` on judged task `task` (every
 *  model of the dashboard that has results for the task), from its file.
 *  Scores as the page shows them (CFG.normalization: as they are). */
function judgedTaskDetailData(m, task) {
  const info = state.metricsSetup[task];
  const file = taskFiles.get(task)?.data || null;
  const key = [m, task, !!file].join("|");
  if (taskDetailCache?.key === key) return taskDetailCache.data;
  const name = info.pretty_name || task;
  const ids = file ? file.models : [];
  const mi = ids.indexOf(m);
  const known = ids.map((id) => isKnownModel(id));
  const fixed = { currentShot: CFG.defaultShot, currentPromptAgg: CFG.promptAgg, currentNormalization: CFG.normalization, currentMetric: null };
  const data = withState(fixed, () => {
    const fmt = scoreDecimals();
    const norm = (v) => (v == null || Number.isNaN(v) ? null : normScore(v, task, null));
    const text = (v) => (v == null ? "–" : v.toFixed(fmt));
    // A [score, standard error] pair's 95% interval.
    const ci = (p) => (p ? [norm(Math.max(0, p[0] - Z95 * p[1])), norm(Math.min(state.scoreTop, p[0] + Z95 * p[1]))] : null);
    const own = mi >= 0 ? file.score[mi] : null;
    const interval = ci(own);
    // Every model's score, in order.
    const ranked = ids.map((id, j) => (known[j] && file.score[j] ? { id, name: getModelLabel(id), value: norm(file.score[j][0]), me: j === mi } : null))
      .filter((r) => r && r.value != null)
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    for (const r of ranked) r.text = text(r.value);
    // The ranking's bars: from 0.
    const barValues = [0, ...ranked.map((r) => r.value), ...(interval || [])];
    const barLo = Math.min(...barValues), barHi = Math.max(...barValues);
    // The examples, and the other models that answered them (in the order
    // of their scores on the task).
    const answered = (j) => known[j] && Array.isArray(file.example_points?.[j]);
    const others = ids.map((id, j) => (j !== mi && answered(j)
      ? { id, name: getModelLabel(id), color: getModelColor(id), score: file.score[j]?.[0] ?? -Infinity, points: file.example_points[j],
          maxTokens: state.DATA.model_info?.[id]?.max_tokens || null }
      : null)).filter(Boolean)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const examples = (file?.examples || []).map((e, i) => ({
      index: i, prompt: e.prompt, reference: e.reference,
      points: mi >= 0 && answered(mi) ? file.example_points[mi][i] : null,
    }));
    const color = getModelColor(m);
    return {
      judged: true, task,
      model: { id: m, title: getModelLabel(m), color, maxTokens: state.DATA.model_info?.[m]?.max_tokens || null,
        badge: () => orgBadge(modelOrg(m), color) },
      title: taskTitle(name), variant: taskVariant(task, name),
      link: info.url ? { href: info.url, text: shortUrl(info.url) } : null,
      description: info.description || "",
      headline: {
        value: text(own ? norm(own[0]) : null),
        // (The 95% interval's half-width: the mean ± it.)
        margin: own ? text(normCI({ loDist: Z95 * own[1], hiDist: Z95 * own[1] }, task, undefined, null)?.hiDist) : "",
      },
      grades: mi >= 0 && file.points?.[mi] ? { counts: file.points[mi] } : null,
      note: file ? "" : "The task's examples and scores could not be loaded.",
      ranking: {
        title: ranked.length + " models",
        note: "",
        rows: ranked, ci: interval, domain: [barLo, barHi + (barHi - barLo) * 0.02],
      },
      examples: examples.length ? {
        list: examples, others,
        load: (id) => loadResponses(id, task),
        index: () => Math.min(detailExample, examples.length - 1),
        pick: (i) => { if (detailExample !== i) { detailExample = i; urlState.save(); } },
      } : null,
    };
  });
  taskDetailCache = { key, data };
  return data;
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
  syncModelDetail();

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

  // The size filter off shows every model by size: a scatter plot with size
  // on a log x-axis. On, ranked bars (panning when they don't all fit,
  // renderModelBars); the pan controls are off for every other chart.
  const useScatter = !sizeFilterOn;
  setBarPan(document.getElementById("chart"), null);
  if (drawerBeside()) setChartCut(0);   // (the renderers cut the chart for the drawer where they need)

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
  refreshModelDetail();
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

// Margins of the bar chart; the bottom one grows to fit long model names
// (barMargins), the left one keeps the plot at the column's edge (barView).
// The bars carry their values, so the chart has no y-axis labels: its plot
// starts at the column's edge (the chart box reaches 5.5rem = 88px into the
// page's padding, style.css), where the title starts.
const BAR_MARGIN = { l: 88, r: 4, t: 8, b: 100 };
const BAR_WIDTH = 0.85;   // of a model's slot
// Bars that would get narrower than BAR_SLOT_MIN_PX each don't all fit: the
// chart then shows as many as fit at about BAR_SLOT_PX, plus BAR_PEEK of the
// next one at the edge, and pans sideways (bar-pan.js). The view's first
// bar (fractional while panning) is kept across renders.
const BAR_SLOT_PX = 52;
const BAR_SLOT_MIN_PX = 48;
const BAR_PEEK = 0.4;
let barViewStart = -Infinity;   // the panning view's first bar; -Infinity: the start
// The y-axis's numbers stand in a column left of the first bar, inside the
// plot, so they pan away with the bars (Plotly's own tick labels would stay
// at the plot's edge): shape labels, over a white band that hides the
// gridlines behind them (renderModelBars).
const Y_LABEL_GAP_PX = 8;   // between the numbers and the gridlines
const AXIS_LABELS = "y-axis numbers";   // names those shapes (an image export drops them)
let barYLabelPx = 0;        // the column's width, as last drawn
// On a narrow page the bars go without their names (showBarNames), and the
// plot needs only this much room below it.
const BAR_BARE_MARGIN_B = 16;
let barNamesShown = true;   // as last drawn (a resize may change it)
const TICK_FONT_SIZE = 13;

/** Rendered width (px) of each label in the chart's tick font. */
function measureLabels(labels, fontSize = TICK_FONT_SIZE, weight = 400) {
  try {
    const ctx = measureLabels.ctx || (measureLabels.ctx = document.createElement("canvas").getContext("2d"));
    ctx.font = `${weight} ${fontSize}px 'Mona Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif`;
    return labels.map((l) => ctx.measureText(l).width);
  } catch (_) {
    return labels.map((l) => l.length * fontSize * 0.55);
  }
}

// Phones (PHONE_SCREEN, pickers.js): the bar chart runs horizontally — one
// row per model, its name on the left — so names stay readable and the
// chart grows downwards instead of squeezing the bars side by side; also a
// phone held sideways, which has no height for the desktop chart. Matches
// the phone block of style.css (full-width chart box). The rows are all as
// tall as a name on two lines needs (wrapRowLabels), so a long name keeps
// clear of its neighbours and the bars keep one rhythm.
const ROW_PX = 32;              // height of one model's row
const ROW_BAR_PX = 22;          // a bar's thickness
const ROW_LABEL_FONT = 12;      // model names on the left axis
const ROW_LABEL_WEIGHT = 500;
const ROW_LABEL_GAP_PX = 8;     // between a name and its bar
const ROW_VALUE_LABEL_PX = 40;  // room for a value label past a bar's end
const ROW_GRID_COLOR = "#e9ecf0";   // the value axis's gridlines: lighter than a wide chart's,
const ROW_ZERO_COLOR = "#a0a8b4";   // and its zero line (z-scores) less stark
const ROW_NAMES_SHARE = 0.4;    // of the chart's width: a name wider than that wraps
const ROW_BAND_RADIUS_PX = 6;   // the open model's band: its corners,
const ROW_BAND_BLEED_PX = 8;    // and how far it reaches past the chart's sides
const ROW_FONT = `${ROW_LABEL_WEIGHT} ${ROW_LABEL_FONT}px 'Mona Sans'`;
const H_MARGIN = { t: 22, r: 10, b: 6 };

/** The bars (a phone's rows) are laid out from their names' widths, so in
 *  the page's font: the first chart waits for it a while (rowFontLoaded),
 *  and one drawn in a fallback font all the same is drawn again once it has
 *  come. */
function rowFontLoaded(ms = 1500) {
  if (!document.fonts?.load) return Promise.resolve();
  return Promise.race([document.fonts.load(ROW_FONT).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
}
let rowFontAwaited = false;
function redrawWhenRowFontLoads() {
  if (rowFontAwaited || !document.fonts?.check || document.fonts.check(ROW_FONT)) return;
  rowFontAwaited = true;
  document.fonts.load(ROW_FONT).then(() => {
    if (!sizeFilterOn || !document.fonts.check(ROW_FONT)) return;
    holdBarAnimation();
    renderChart();
  }, () => {});
}

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
  const widths = measureLabels(labels, ROW_LABEL_FONT, ROW_LABEL_WEIGHT);
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
      if (useHorizontalBars() || barPanChanges() || barNamesChange() || drawerBeside()) renderChart();
    }, 200);
  });
  // A touch closes the tooltip wherever it lands (a tap shows none:
  // touchInput); a mouse press only outside the chart.
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || !document.getElementById("chart")?.contains(e.target)) hideTooltip();
  });
  // A click or tap on a model's name, left of its horizontal bar, does what
  // one on the bar does. (The names take no pointer events: the row is found
  // from the tap's height.)
  const chartEl = document.getElementById("chart");
  chartEl?.addEventListener("click", (e) => {
    const trace = chartEl.data?.[0], fl = chartEl._fullLayout;
    if (trace?.orientation !== "h" || !fl?.yaxis) return;
    const box = chartEl.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top - fl._size.t;
    if (x >= fl._size.l || y < 0 || y > fl._size.h) return;
    const i = Math.round(fl.yaxis.p2l(y));
    if (!trace.customdata?.[i]) return;
    onChartHover({ points: [{ customdata: trace.customdata[i], x: trace.x[i], y: i, data: trace }], event: e });
    openFromChart(trace.customdata[i].modelDir);
  });
}

/** Set the chart box to `px` tall; null restores the stylesheet's height. */
/** Whether a resize changes how the bars pan: a chart that pans may now fit
 *  (or show more or fewer bars), and one that fits may now have to pan. */
function barPanChanges() {
  const chart = document.getElementById("chart");
  if (!chart || !sizeFilterOn) return false;
  if (chart.classList.contains("bar-pan")) return true;
  return getModelList().length * BAR_SLOT_MIN_PX > chart.clientWidth - BAR_MARGIN.l - BAR_MARGIN.r - barYLabelPx;
}

function setChartHeight(px) {
  const el = document.getElementById("chart");
  if (el) el.style.height = px == null ? "" : px + "px";
}

/** Bar-chart margins that fit the model names at tick angle `angleDeg`
 *  (0, or negative: rotated labels end at their tick and hang down-left).
 *  The bottom margin covers the longest label's drop; the left one keeps
 *  the first labels — whose ticks sit (0.6 + i) slots of `slotPx` right of
 *  the plot's left edge — inside the figure (an image export: on the page
 *  the plot keeps to the column's edge, barView). `shift`: the labels'
 *  shift to the right (rotatedLabelShift). */
function barMargins(labels, angleDeg, slotPx, shift = 0) {
  const rad = Math.abs(angleDeg) * Math.PI / 180;
  const lineHeight = TICK_FONT_SIZE * 1.2;
  const widths = measureLabels(labels);
  const drop = Math.max(0, ...widths.map((w) => w * Math.sin(rad) + lineHeight * Math.cos(rad)));
  const reach = widths.map((w, i) => (rad === 0 ? w / 2 : w * Math.cos(rad) + lineHeight / 2 * Math.sin(rad))
    - (0.6 + i) * slotPx - shift);
  return {
    ...BAR_MARGIN,
    b: Math.max(BAR_MARGIN.b, Math.ceil(drop + 14)),
    l: Math.max(BAR_MARGIN.l, Math.ceil(Math.max(0, ...reach) + 8)),
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
 *  for long model names below the bars) or, negative, shorter (bars without
 *  names), so the plot area keeps its size; 0 restores the stylesheet's
 *  height. */
function setChartExtraHeight(extra) {
  const el = document.getElementById("chart");
  if (!el) return;
  el.style.height = "";
  if (extra) el.style.height = el.clientHeight + extra + "px";
}

/** Whether the bars carry their names under them: not on a narrow page (a
 *  tablet, a window under about 1260px), whose side padding can't hold the
 *  first names — nor the pan buttons (bar-pan.js buttonFitsBeside). There
 *  the plot spans the column, as on a wide page, instead of leaving room
 *  for the names, and a bar's tooltip (a tap or hover) names it. `left`:
 *  the chart's left edge on the screen (with the drawer open, where it is
 *  without the drawer). */
function showBarNames(chartEl, left = chartEl.getBoundingClientRect().left) {
  return buttonFitsBeside(left + BAR_MARGIN.l);
}

/** Whether a resize crosses that width: the bars gain or lose their names. */
function barNamesChange() {
  const chart = document.getElementById("chart");
  return !!chart && sizeFilterOn && !useHorizontalBars()
    && showBarNames(chart, drawerBeside() ? closedChartFrame().left : undefined) !== barNamesShown;
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
  redrawWhenRowFontLoads();
  const labels = modelNames.map(getModelLabel);
  const xPositions = computeOrgXPositions(modelNames);
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
  const chartEl = document.getElementById("chart");
  // With the drawer open, the bars as wide and named as without it, so
  // opening and closing it moves none: a chart that pans runs on under the
  // drawer (bar-pan.js pans to the bars it covers); one whose bars all fit
  // ends at the drawer's edge, panning to those it would cover.
  const closed = drawerBeside() ? closedChartFrame() : null;
  barNamesShown = chartEl ? showBarNames(chartEl, closed?.left) : true;
  // The y-axis's ticks, as Plotly would place them on the plot's height
  // (which stays the stylesheet's chart height less the default margins,
  // whatever the names need: setChartExtraHeight), and their column.
  setChartExtraHeight(0);
  const yTicks = barYTicks(yRange, (chartEl?.clientHeight || 500) - BAR_MARGIN.t - BAR_MARGIN.b);
  barYLabelPx = Math.ceil(Math.max(0, ...measureLabels(yTicks.map((tk) => tk.text), Y_TICK_FONT.size, Y_TICK_FONT.weight))) + Y_LABEL_GAP_PX;
  const asClosed = closed ? barView(labels, closed.width, barNamesShown, barYLabelPx) : null;
  if (closed) setChartCut(asClosed.panning ? 0 : chartCovered());
  const cut = closed ? chartCut() > 0 : false;
  const chartWidth = chartEl?.clientWidth || 1200;
  const view = barView(labels, chartWidth, barNamesShown, barYLabelPx, cut ? asClosed.slotPx : null);
  const { tickAngle, labelShift, margin, lead } = view;
  setChartExtraHeight(margin.b - BAR_MARGIN.b);
  // (At the start, barViewStart stays -Infinity: the start of this layout,
  // whose lead may differ from the last one's.)
  const viewStart = view.panning ? Math.min(Math.max(-lead, barViewStart), labels.length - view.visible) : -Infinity;
  if (view.panning) barViewStart = viewStart > -lead + 1e-6 ? viewStart : -Infinity;
  const last = xPositions[xPositions.length - 1];
  // The numbers, right-aligned a gap short of the gridlines, which start
  // 0.1 slot before the first bar (as Plotly's plot did, before the column):
  // labels of empty shapes over the band, both in the layer between the
  // gridlines and the bars — under the bars (one widened by the hover can
  // reach them) and cut at the plot's edge with them. One on the plot's
  // bottom or top edge sits just inside it. (Shape labels keep ~3px from
  // their shape's edge.)
  const numbersEnd = -0.6;
  const plotHeight = (chartEl?.clientHeight || 500) - margin.t - margin.b;
  const edgePx = (v) => (v - yRange[0]) / (yRange[1] - yRange[0]) * plotHeight;
  const yNumbers = [
    { type: "rect", layer: "between", name: AXIS_LABELS, xref: "x", yref: "y",
      x0: -0.5 - lead, x1: numbersEnd, y0: yRange[0], y1: yRange[1], fillcolor: "#fff", line: { width: 0 } },
    ...yTicks.map((tk) => ({
      type: "rect", layer: "between", name: AXIS_LABELS, xref: "x", yref: "y",
      x0: -0.5 - lead, x1: numbersEnd - (Y_LABEL_GAP_PX - 3) / view.slotPx, y0: tk.v, y1: tk.v,
      fillcolor: "rgba(0,0,0,0)", line: { width: 0 },
      label: {
        text: tk.text, font: { ...Y_TICK_FONT }, padding: 0,
        textposition: edgePx(tk.v) < Y_TICK_FONT.size * 0.6 ? "bottom right"
          : plotHeight - edgePx(tk.v) < Y_TICK_FONT.size * 0.6 ? "top right" : "middle right",
      },
    })),
  ];
  const layout = getPlotlyLayout({
    yaxis: { ...makeYAxis(yRange), tickvals: yTicks.map((tk) => tk.v), showticklabels: false },
    xaxis: { automargin: false,
      range: view.panning ? [viewStart - 0.5, viewStart - 0.5 + view.visible]
        : view.fixed ? [-0.5 - lead, -0.5 - lead + view.visible] : [-0.5 - lead, last + 0.5],
      tickvals: xPositions, ticktext: labels, showticklabels: barNamesShown,
      tickangle: tickAngle, ticklabelshift: labelShift, showgrid: false,
    },
    showlegend: false,
    margin,
    shapes: yNumbers,
    annotations: labels.map((label, i) => ({
      x: xPositions[i],
      y: below[i]
        ? values[i] - (loArr ? (loArr[i] || 0) : 0)
        : (values[i] || 0) + (hiArr ? (hiArr[i] || 0) : 0),
      text: values[i] != null ? values[i].toFixed(fmt) : "",
      showarrow: false, yshift: below[i] ? -10 : 10,
      xanchor: "center",
      font: { size: computeAnnotationFontSize(barsInView(asClosed || view, labels.length)), color: "#000", weight: 500 },
    })),
    images: buildOrgImages(modelNames, xPositions, values, yRange),
  });
  layout._annAnim = labels.map((_, i) => ({
    score: values[i] || 0,
    se: below[i] ? -(loArr ? (loArr[i] || 0) : 0) : (hiArr ? (hiArr[i] || 0) : 0),
  }));
  if (view.panning) {
    // The chart moves only by panning: no drag-zoom. A bar panned to the
    // left edge keeps its label, running into the page's padding (or off
    // the screen), not dropped (Plotly's default for a label running past
    // the chart).
    layout.dragmode = false;
    layout.xaxis.fixedrange = true;
    layout.yaxis.fixedrange = true;
    layout.xaxis.ticklabeloverflow = "allow";
  }
  const mark = selectionMark(modelNames, labels);
  layout.shapes.push(...mark.shapes);
  layout.xaxis.ticktext = mark.ticktext;
  plotChart([trace], touchSafe(layout), plotlyConfig, onChartHover, onChartUnhover);
  if (chartEl) {
    chartEl._barModels = modelNames;
    chartEl._barLabels = labels;
    bindModelDetailClicks(chartEl);
  }
  if (view.panning) {
    setBarPan(chartEl, {
      total: labels.length, visible: view.visible, start: viewStart, lead, slotPx: view.slotPx,
      onChange: (s) => {
        barViewStart = s <= -lead + 1e-6 ? -Infinity : s;
        replayPointerSoon();   // (the bars slid under a still mouse)
      },
    });
  } else {
    barViewStart = -Infinity;
  }
}

/** The y-axis's ticks on `range`, as Plotly places them (its auto ticks) on
 *  an axis `lengthPx` long: 5–10 of them, about 40px apart or more, a step
 *  of 2, 5 or 10 × a power of ten; with their labels, as Plotly writes
 *  them. */
function barYTicks([lo, hi], lengthPx) {
  const nt = Math.min(9, Math.max(4, lengthPx / 40)) + 1;
  const rough = (hi - lo) / nt;
  const base = 10 ** Math.floor(Math.log10(rough));
  const step = base * [2, 5, 10].find((m) => m >= rough / base - 1e-9);
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const ticks = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9; k++) {
    const v = +(k * step).toFixed(decimals + 2);
    ticks.push({ v, text: (v < 0 ? "\u2212" : "") + String(+Math.abs(v).toFixed(decimals)) });
  }
  return ticks;
}

/** The bars' geometry: all of them across the plot when each gets at least
 *  BAR_SLOT_MIN_PX (as before); else as many as fit at about BAR_SLOT_PX,
 *  plus a peek of the next, and the chart pans (bar-pan.js; its ‹ › buttons
 *  sit outside the plot, or on top of its edges). The y-axis's numbers take
 *  the first `numbersPx` of the plot, then 0.1 slot, then the first bar;
 *  panned, they go with it. Returns {panning, visible (slots in view, the
 *  peek included), slotPx, lead (the slots before the first bar's: the
 *  numbers' column and the 0.1), tickAngle, labelShift, margin}. The plot
 *  starts at the page column's edge, under the title, whatever the names:
 *  the first ones hang into the page's side padding (one too long even for
 *  that is cut at the window's edge), and the bottom margin fits their
 *  drop. A panning plot also reaches the column's right edge. Without
 *  `names` (showBarNames) the plot needs little room below. */
function barView(labels, chartWidth, names, numbersPx, fixedSlotPx = null) {
  if (fixedSlotPx) return fixedBarView(labels, chartWidth, names, numbersPx, fixedSlotPx);
  const fitWidth = chartWidth - BAR_MARGIN.l - BAR_MARGIN.r - numbersPx;
  const panning = labels.length * BAR_SLOT_MIN_PX > fitWidth;
  const r = panning ? 0 : BAR_MARGIN.r;
  let slotPx, visible;
  if (panning) {
    // From the start: the numbers, 0.1 slot, as many bars as fit at about
    // BAR_SLOT_PX, and BAR_PEEK of the next.
    const room = chartWidth - BAR_MARGIN.l - numbersPx;
    slotPx = room / (Math.max(4, Math.floor(room / BAR_SLOT_PX)) + 0.1 + BAR_PEEK);
    visible = (chartWidth - BAR_MARGIN.l) / slotPx;
  } else {
    slotPx = fitWidth / (labels.length + 0.1);
    visible = labels.length;
  }
  const lead = numbersPx / slotPx + 0.1;
  if (!names) {
    return { panning, visible, slotPx, lead, tickAngle: 0, labelShift: 0, margin: { ...BAR_MARGIN, r, b: BAR_BARE_MARGIN_B } };
  }
  const tickAngle = computeTickAngle(labels, slotPx);
  const labelShift = rotatedLabelShift(tickAngle, slotPx);
  const { b } = barMargins(labels, tickAngle, slotPx, labelShift);
  return { panning, visible, slotPx, lead, tickAngle, labelShift, margin: { ...BAR_MARGIN, r, b } };
}

/** barView with the drawer open: the bars `slotPx` wide, as without the
 *  drawer, from the plot's left edge on; the plot reaches the drawer, and
 *  pans when they run under it. (`fixed`: the view isn't fitted to the
 *  bars.) */
function fixedBarView(labels, chartWidth, names, numbersPx, slotPx) {
  const visible = (chartWidth - BAR_MARGIN.l) / slotPx;
  const lead = numbersPx / slotPx + 0.1;
  const panning = lead + labels.length > visible + 1e-6;
  const margin = { ...BAR_MARGIN, r: 0 };
  if (!names) return { panning, fixed: true, visible, slotPx, lead, tickAngle: 0, labelShift: 0, margin: { ...margin, b: BAR_BARE_MARGIN_B } };
  const tickAngle = computeTickAngle(labels, slotPx);
  const labelShift = rotatedLabelShift(tickAngle, slotPx);
  return { panning, fixed: true, visible, slotPx, lead, tickAngle, labelShift, margin: { ...margin, b: barMargins(labels, tickAngle, slotPx, labelShift).b } };
}

/** The bars a view shows at once (the scores' font follows it). */
function barsInView(view, total) {
  return view.panning ? Math.floor(view.visible) : total;
}

/** renderModelBars on a narrow screen: one row per model, best at the top,
 *  its name on the left (on two lines if long), the bar
 *  growing right from 0 (left for a negative value) with the organization's
 *  logo at its start and the value after its error bar; the value scale on
 *  top. The chart box grows to fit the rows. A tap anywhere on a row opens
 *  the model's details (hovermode "y"). */
function renderModelBarsHorizontal(modelNames, { values, ciValues, customdata }) {
  clearScatterHooks();
  const labels = modelNames.map(getModelLabel);
  const rows = modelNames.map((_, i) => i);
  const width = document.getElementById("chart")?.clientWidth || 360;
  const ticktext = wrapRowLabels(labels, width * ROW_NAMES_SHARE);
  const lineWidths = measureLabels(ticktext.flatMap((t) => t.split("<br>")), ROW_LABEL_FONT, ROW_LABEL_WEIGHT);
  const margin = {
    ...H_MARGIN,
    l: Math.min(Math.ceil(Math.max(0, ...lineWidths)) + ROW_LABEL_GAP_PX + 2, Math.round(width * 0.45)),
  };
  setChartHeight(margin.t + margin.b + rows.length * ROW_PX);
  redrawWhenRowFontLoads();
  const fmt = scoreDecimals();
  const hiArr = ciValues ? ciValues.map((c) => c?.hiDist ?? 0) : null;
  const loArr = ciValues ? ciValues.map((c) => c?.loDist ?? 0) : null;
  const below = values.map((v) => v != null && v < 0);
  const errorX = ciValues && { ...makeErrorY(ciValues), thickness: 1.6, width: 3 };
  const trace = {
    type: "bar", orientation: "h",
    x: values, y: rows, width: ROW_BAR_PX / ROW_PX,
    marker: { color: modelNames.map(getModelColor), line: { width: 0 }, cornerradius: 5 },
    customdata: customdata.map((d, i) => ({ ...d, value: values[i], label: labels[i] })),
    hoverinfo: "none",
    ...(errorX && { error_x: errorX }),
  };
  const plotWidth = Math.max(1, width - margin.l - margin.r);
  const xRange = rowValueRange(values, ciValues, plotWidth);
  const layout = getPlotlyLayout({
    xaxis: { ...makeYAxis(xRange), gridcolor: ROW_GRID_COLOR, zerolinecolor: ROW_ZERO_COLOR, side: "top", tickfont: { size: 11, color: "#64748b" } },
    yaxis: {
      range: [rows.length - 0.5, -0.5], tickvals: rows, ticktext,
      showgrid: false, automargin: false, ticks: "", ticklen: 0, ticklabelstandoff: ROW_LABEL_GAP_PX - 2,
      tickfont: { size: ROW_LABEL_FONT, color: "#1e293b", weight: ROW_LABEL_WEIGHT },
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
      font: { size: ROW_LABEL_FONT, color: "#000", weight: 500 },
    })),
    images: buildRowLogos(modelNames, values, xRange, plotWidth),
  });
  layout._annAnim = values.map((v, i) => ({
    score: v || 0,
    se: below[i] ? -(loArr ? (loArr[i] || 0) : 0) : (hiArr ? (hiArr[i] || 0) : 0),
  }));
  rowBandSpan = {
    x0: -(margin.l + ROW_BAND_BLEED_PX) / plotWidth,
    x1: 1 + (margin.r + ROW_BAND_BLEED_PX) / plotWidth,
    rx: ROW_BAND_RADIUS_PX / plotWidth,
  };
  const mark = selectionMark(modelNames, ticktext, true);
  layout.shapes = mark.shapes;
  layout.yaxis.ticktext = mark.ticktext;
  plotChart([trace], touchSafe(layout), plotlyConfig, onChartHover, onChartUnhover);
  const chartEl = document.getElementById("chart");
  if (!chartEl) return;
  chartEl._barModels = modelNames;
  chartEl._barLabels = ticktext;
  bindModelDetailClicks(chartEl);
}

/** Logos of the horizontal bars: one per row (a blank one without a logo,
 *  as in buildOrgImages), inside the bar just past the zero line, sized to
 *  the bar's thickness. */
function buildRowLogos(modelNames, values, xRange, plotWidth) {
  const [lo, hi] = xRange;
  const zero = lo < 0 && hi > lo ? Math.min(1, -lo / (hi - lo)) : 0;   // paper x of 0
  const pad = 5 / plotWidth;
  return modelNames.map((modelDir, i) => {
    const org = state.DATA.model_organizations?.[modelDir];
    const filename = org && ORG_LOGO[org];
    const scale = (org && ORG_LOGO_SCALE[org]) || 1;
    const side = ROW_BAR_PX * 0.72 * scale;   // px
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
  const { xs, ys, dirs, colors, cis, extras } = collectScatterPoints(
    modelNames, (m) => modelScoreCI(m, benchmark, metric, allRaw));
  plotScatter(xs, ys, dirs, colors, cis, computeSingleYRange(benchmark, metric), extras);
}

/** Build a single-trace scatter chart: one marker per model, org logos
 *  overlaid via layout.images. Used by aggregate and single-benchmark
 *  scatter modes. */
function plotScatter(xs, ys, dirs, colors, cis, yRange, extras) {
  setChartExtraHeight(0);
  if (drawerBeside()) setChartCut(chartCovered());   // (ends at the drawer's edge)
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
  const yaxis = makeYAxis(yRange);
  if (narrow) {   // (light lines, as the phone's bars have)
    xaxis.gridcolor = yaxis.gridcolor = ROW_GRID_COLOR;
    yaxis.zerolinecolor = ROW_ZERO_COLOR;
  }
  const el = document.getElementById("chart");
  const composite = buildScatterCompositeImages(dirs, xs, paperYs, colors, {
    disk: narrow ? SCATTER_DISK_PX_NARROW : SCATTER_DISK_PX,
    plotW: Math.max(1, (el?.clientWidth || 1200) - margin.l - margin.r),
    plotH: Math.max(1, (el?.clientHeight || 500) - margin.t - margin.b),
    xSpan: xaxis.range[1] - xaxis.range[0],
  });
  const layout = getPlotlyLayout({
    yaxis,
    xaxis,
    showlegend: false,
    margin,
    images: composite.images,
  });
  // Stash the image→model mapping so the scatter hover handler (in chart.js)
  // can scale only the hovered model's images, not nearby ones.
  document.getElementById("chart")._scatterImageMap = composite.imageToModel;

  plotChart([trace], touchSafe(layout), plotlyConfig, onChartHover, onChartUnhover);
  bindModelDetailClicks(el);
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
  return [mn - Math.max((hi - mn) * 0.05, state.scoreTop * 0.005), hi];
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
  // (A page without shots names none: /instruct.)
  const shot = hasShots() ? state.currentShot + "-shot" : "";
  const tail = shot ? " (" + shot + ")" : "";
  const prefix = isMacroSelection() ? "Category average" : "Task average";

  if (sel === "__all_macro__" || sel === "__all__") {
    return prefix + " across all NorEval tasks" + tail;
  }
  if (sel === "__custom__" || sel === "__custom_macro__") return prefix + " across " + state.checkedTasks.size + " selected tasks" + tail;
  if (sel.startsWith("__cat__")) return prefix + " across " + sel.slice(7) + " tasks" + tail;
  if (sel.startsWith("__eval__")) return prefix + " across " + sel.slice(8) + " tasks" + tail;
  if (sel === "__lang__nob") return prefix + " across Bokmål tasks" + tail;
  if (sel === "__lang__nno") return prefix + " across Nynorsk tasks" + tail;
  if (sel === "__lang__sme") return prefix + " across Northern Sámi tasks" + tail;
  if (state.metricsSetup[sel]) return formatTitleWithShot(defaultTaskDisplayName(sel), shot);
  return "";
}

/** Build the hover description shown when the user hovers the chart title.
 *  Returns { body, footer }. Body is plain text; footer is an optional URL. */
function getChartTitleDescription() {
  const sel = state.currentTaskSelection;
  if (isAggregateSelection(sel)) {
    return { body: getAggregateDescription(), footer: "" };
  }
  if (state.metricsSetup[sel]) {
    return taskTitleDescription(sel);
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
    ? " The task scores are then averaged within each category, and the category averages are then further averaged, which gives equal weight to each category regardless of how many tasks it contains."
    : " The task scores are then averaged.";
  return "Aggregate score across " + scope + ". " + normDesc + avgDesc;
}
