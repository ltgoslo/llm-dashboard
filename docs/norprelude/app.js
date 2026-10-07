// NorPrelude training-progress dashboard: OpenEuroLLM Prelude 9B annealed
// on Scandinavian data mixtures, evaluated on NorEval 1.2.
//
// Same page as the Prelude dashboard (docs/prelude/app.js) minus the signal
// measures: the main line is the last Prelude checkpoints before the anneal
// and each anneal run is drawn as a side run forking off it, like the
// NorOLMo ablations. Run names and colors come from data.json
// (`run_display_names`, `run_colors`, set in build_data.py).

import { state } from "../shared/state.js";
import { isAggregateSelection } from "../shared/core.js";
import { makePlotlyConfig } from "../shared/chart.js";
import {
  buildTaskCheckboxes, bindModuleActionStopPropagation, attachControlTooltips, markAppReady,
  populateFormulationOptions, updateVariantControlVisibility, applyTaskTypeMask,
  VARIANT_CONTROL_TOOLTIPS,
} from "../shared/ui.js";
import { renderProgressChart, updateProgressTitle } from "../shared/progress.js";
import {
  setsEqual, getBenchmarksForSelection, autoSetNormalization, setSingleTaskNormalization,
  populateTaskDropdown, onTaskCheckboxChange, bindTaskControls,
  restoreCheckedTasksFromSelection, syncTaskControlsFromState,
} from "../shared/selection.js";
import { UrlState } from "../shared/url-state.js";

// Fallbacks, overridden from data.json (`tokens_per_step`, `shots`).
let tokensPerStep = 2048 * 4096;   // 8,388,608 tokens per training iteration
let allShots = ["5"];

const DEFAULT_SELECTION = "__all_macro__";
// Defaults of this instance's selectors (the URL only records departures).
const DEFAULTS = { classificationMetric: "prob_correct", promptAgg: "mean", formulation: "mean", accNorm: "max", normalization: "baseline" };
// The x-axis is measured from the last Prelude checkpoint (the fork of the
// anneals): tokens before it are negative. Set in init() from the data.
let originStep = 0;
const MAIN_COLOR = "#6b7280";                                          // grey
const RUN_COLORS = ["#dc2626", "#2563eb", "#f97316", "#9333ea", "#0d9488"];  // fallback when data.json names no color

const plotlyConfig = makePlotlyConfig("norprelude-chart", () => ({
  shot: state.currentShot + "-shot",
  task_selection: state.currentTaskSelection,
  task_type: state.taskTypeFilter,
  classification_metric: state.classificationMetric,
  decoding: state.currentDecoding,
  prompts: state.currentPromptAgg,
  formulation: state.currentFormulation,
  loglikelihood_normalization: state.currentAccNorm,
  normalization: state.currentNormalization,
  ...(state.currentMetric && { metric: state.currentMetric }),
  error_bands: state.showCIBands ? "shown" : "hidden",
}));

let urlState;

// ─────────────────────────────────────────────────────────────
// Trajectory builders
// ─────────────────────────────────────────────────────────────

function sortedSteps(data) {
  return Object.keys(data || {}).map(Number).sort((a, b) => a - b);
}

/** The main line first, then each side run (checkpoint dirs named
 *  `<run>_iter_<N>`). A side run is prepended with the last main-line
 *  checkpoint at or before its first iteration, so the fork is drawn as a
 *  connected line rather than a gap. */
function getTrajectories() {
  const progress = state.DATA.progress;
  const mainSteps = sortedSteps(progress);
  const trajectories = [{
    name: state.DATA.main_display_name || "Prelude 9B", key: "main", color: MAIN_COLOR,
    dataSource: progress, checkpoints: () => mainSteps, zorder: 1,
  }];
  const runs = state.DATA.runs || {};
  Object.keys(runs).sort().forEach((run, i) => {
    let data = runs[run];
    const first = sortedSteps(data)[0];
    if (first === undefined) return;
    const fork = mainSteps.filter((s) => s <= first).pop();
    if (fork !== undefined && !(fork in data)) data = { [fork]: progress[fork], ...data };
    const steps = sortedSteps(data);
    trajectories.push({
      name: state.DATA.run_display_names?.[run] || run,
      key: run,
      color: state.DATA.run_colors?.[run] || RUN_COLORS[i % RUN_COLORS.length],
      dataSource: data,
      checkpoints: () => steps,
    });
  });
  return trajectories;
}

/** "+20.1B", "−201B", "0" — signed, relative to the last Prelude checkpoint. */
function formatTokens(tokens) {
  const abs = Math.abs(tokens);
  if (abs < 5e7) return "0";
  const sign = tokens < 0 ? "−" : "+";
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + "T";
  if (abs >= 1e10) return sign + Math.round(abs / 1e9) + "B";
  return sign + (abs / 1e9).toFixed(1) + "B";
}

// ─────────────────────────────────────────────────────────────
// Chart config
// ─────────────────────────────────────────────────────────────

const chartConfig = {
  getTrajectories,
  xToTokens: (step) => (step - originStep) * tokensPerStep,
  xAxisLabel: "tokens relative to the last Prelude checkpoint",
  allShots,            // replaced in init() once data.json is loaded
  // Always fully zoomed: the y-axis fits the plotted points (and bands) of
  // the displayed shot on every render.
  yRangeFit: true,
  xRangeTight: true,
  plotlyConfig,
  hoverXFormat: (xTokens, traceName) => {
    const iteration = originStep + Math.round(xTokens / tokensPerStep);
    return `${traceName} — ${formatTokens(xTokens)} tokens (iteration ${iteration.toLocaleString()})`;
  },
  titlePrefix: "NorPrelude",
  // z-score / min-max reference the checkpoints of the main line and the
  // side runs together, so a run forked off the main line stays comparable.
  normAcrossTrajectories: true,
};

// ─────────────────────────────────────────────────────────────
// Variant controls (task type / classification metric / formulation / loglikelihood
// normalization), error bands, shots
// ─────────────────────────────────────────────────────────────

/** Keep only the shot buttons for which data.json has results. */
function updateShotButtons() {
  const buttons = [...document.querySelectorAll(".shot-btn")];
  for (const b of buttons) b.style.display = allShots.includes(b.dataset.shot) ? "" : "none";
  if (!allShots.includes(state.currentShot)) state.currentShot = allShots[0];
  for (const b of buttons) b.classList.toggle("active", b.dataset.shot === state.currentShot);
}

function bindVariantControls() {
  const bind = (id, apply) => {
    document.getElementById(id).addEventListener("change", (e) => {
      apply(e.target.value);
      render();
    });
  };
  bind("task-type-select", (v) => state.taskTypeFilter = v);
  bind("classification-metric-select", (v) => state.classificationMetric = v);
  bind("decoding-select", (v) => state.currentDecoding = v);
  bind("formulation-select", (v) => state.currentFormulation = v);
  bind("acc-norm-select", (v) => state.currentAccNorm = v);
  document.querySelectorAll(".ci-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelector(".ci-btn.active")?.classList.remove("active");
      btn.classList.add("active");
      state.showCIBands = btn.dataset.ci === "1";
      render();
    });
  });
}

/** Push the variant selectors' state into their controls (after a URL
 *  restore). An unknown value falls back to the control's default and is
 *  written back to the state. */
function syncVariantControlsFromState() {
  const setSelect = (id, value, fallback) => {
    const select = document.getElementById(id);
    select.value = value;
    if (select.value !== value) select.value = fallback;
    return select.value;
  };
  state.taskTypeFilter = setSelect("task-type-select", state.taskTypeFilter, "all");
  state.classificationMetric = setSelect("classification-metric-select", state.classificationMetric, DEFAULTS.classificationMetric);
  state.currentDecoding = setSelect("decoding-select", state.currentDecoding, "sampling");
  state.currentPromptAgg = setSelect("prompt-agg-select", state.currentPromptAgg, DEFAULTS.promptAgg);
  state.currentFormulation = setSelect("formulation-select", state.currentFormulation, DEFAULTS.formulation);
  state.currentAccNorm = setSelect("acc-norm-select", state.currentAccNorm, DEFAULTS.accNorm);
  state.currentNormalization = setSelect("norm-select", state.currentNormalization, DEFAULTS.normalization);
  document.querySelectorAll(".ci-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.ci === (state.showCIBands ? "1" : "0")));
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
// The former hard/soft "Metric type" selector (URL key `mmode`).
const LEGACY_METRIC_MODE = { hard: "acc", soft: "prob_correct" };

function setupUrlState() {
  urlState = new UrlState([
    { key: "shot", get: () => state.currentShot, set: (v) => state.currentShot = v, default: "5" },
    {
      key: "task",
      get: () => state.currentTaskSelection,
      // Unknown values fall back to the default aggregate view instead of
      // an empty chart; the former "aggregate by evaluation type" entries
      // became the task-type selector.
      set: (v) => {
        if (v.startsWith("__eval__")) {
          state.taskTypeFilter = v.slice(8);
          state.currentTaskSelection = DEFAULT_SELECTION;
          return;
        }
        state.currentTaskSelection = (v === "__custom__" || v === "__custom_macro__"
          || getBenchmarksForSelection(v).length > 0) ? v : DEFAULT_SELECTION;
      },
      default: DEFAULT_SELECTION,
    },
    { key: "ttype", get: () => state.taskTypeFilter, set: (v) => state.taskTypeFilter = v, default: "all" },
    { key: "mmode", get: () => "", set: (v) => { if (LEGACY_METRIC_MODE[v]) state.classificationMetric = LEGACY_METRIC_MODE[v]; }, default: "" },
    { key: "cmetric", get: () => state.classificationMetric, set: (v) => state.classificationMetric = v, default: DEFAULTS.classificationMetric },
    { key: "dec", get: () => state.currentDecoding, set: (v) => state.currentDecoding = v, default: "sampling" },
    { key: "prompt", get: () => state.currentPromptAgg, set: (v) => state.currentPromptAgg = LEGACY_PROMPT_AGG[v] || v, default: DEFAULTS.promptAgg },
    { key: "form", get: () => state.currentFormulation, set: (v) => state.currentFormulation = v, default: DEFAULTS.formulation },
    { key: "anorm", get: () => state.currentAccNorm, set: (v) => state.currentAccNorm = LEGACY_LL_NORM[v] || v, default: DEFAULTS.accNorm },
    { key: "ci", get: () => state.showCIBands ? "1" : "0", set: (v) => state.showCIBands = v !== "0", default: "0" },
    {
      key: "metric",
      get: () => state.currentMetric || "",
      set: (v) => state.currentMetric = v,
      default: "",
    },
    {
      key: "norm",
      get: () => state.currentNormalization,
      set: (v) => state.currentNormalization = v === "percentile" ? "baseline" : v,
      default: DEFAULTS.normalization,
    },
    {
      key: "tasks",
      get: () => {
        const auto = new Set(getBenchmarksForSelection(state.currentTaskSelection));
        return setsEqual(state.checkedTasks, auto) ? "" : [...state.checkedTasks].sort().join(",");
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
    tokensPerStep = state.DATA.tokens_per_step || tokensPerStep;
    originStep = Math.max(0, ...sortedSteps(state.DATA.progress));
    setSingleTaskNormalization(DEFAULTS.normalization);
    if (state.DATA.shots?.length) allShots = state.DATA.shots.map(String);
    chartConfig.allShots = allShots;
    state.currentTaskSelection = DEFAULT_SELECTION;
    state.currentPromptAgg = DEFAULTS.promptAgg;
    state.currentFormulation = DEFAULTS.formulation;
    state.formulationCombine = true;
    state.currentAccNorm = DEFAULTS.accNorm;
    state.llNormScope = "all";
    state.classificationMetric = DEFAULTS.classificationMetric;
    state.taskTypeFilter = "all";
    state.currentDecoding = "sampling";
    state.showCIBands = false;

    setupUrlState();
    const hasURL = urlState.load();
    restoreCheckedTasksFromSelection(urlState);

    populateTaskDropdown({ evalTypes: false });
    populateFormulationOptions();
    updateShotButtons();
    bindTaskControls(render, { selectAll: DEFAULT_SELECTION });
    bindVariantControls();
    buildTaskCheckboxes({
      filterSourceFn: () => state.checkedTasks,
      onChange: () => onTaskCheckboxChange(render),
    });
    bindModuleActionStopPropagation();
    attachControlTooltips(VARIANT_CONTROL_TOOLTIPS);

    // The `norm` URL field has a dynamic default ("baseline" for aggregate
    // selections, "none" otherwise) that is only applied on save; apply it
    // here when `norm` is absent so individual-task URLs don't inherit the
    // static state.js default.
    if (!urlState.has("norm")) autoSetNormalization();

    syncVariantControlsFromState();
    if (hasURL) {
      syncTaskControlsFromState();
      updateShotButtons();
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
