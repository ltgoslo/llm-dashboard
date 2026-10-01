// OpenEuroLLM Prelude training-progress dashboard (NorEval 1.2).
//
// Renders the Prelude 9B main-line trajectory — plus any side runs found in
// data.json (`runs`, e.g. an anneal forked off the main line) — on the
// NorEval 1.2 benchmark. Most chart logic lives in shared/progress.js. This
// file handles the dashboard-specific wiring: task dropdown, checkboxes,
// event listeners, URL state, the trajectory list, and the NorEval-1.2
// variant controls shared with multisynt (task type, hard/soft metric,
// prompts, formulation, loglikelihood normalization — see resolvePoint in
// core.js and the variant-control helpers in ui.js).

import { state } from "../shared/state.js";
import { isAggregateSelection } from "../shared/core.js";
import { makePlotlyConfig } from "../shared/chart.js";
import {
  buildTaskCheckboxes, bindModuleActionStopPropagation, attachControlTooltips, markAppReady,
  populateFormulationOptions, updateVariantControlVisibility, applyTaskTypeMask,
  VARIANT_CONTROL_TOOLTIPS,
} from "../shared/ui.js";
import { renderProgressChart, updateProgressTitle } from "../shared/progress.js";
import { computeSignals, renderSignals } from "../shared/signals.js";
import {
  setsEqual, getBenchmarksForSelection, autoSetNormalization,
  populateTaskDropdown, onTaskCheckboxChange, bindTaskControls,
  restoreCheckedTasksFromSelection, syncTaskControlsFromState,
} from "../shared/selection.js";
import { UrlState } from "../shared/url-state.js";

// Fallbacks, overridden from data.json (`tokens_per_step`, `shots`).
let tokensPerStep = 2048 * 4096;   // 8,388,608 tokens per training iteration
let allShots = ["5"];

const DEFAULT_SELECTION = "__all_macro__";
const MAIN_COLOR = "#2563eb";                                          // blue
const RUN_COLORS = ["#dc2626", "#f97316", "#9333ea", "#0d9488", "#b45309"];

const plotlyConfig = makePlotlyConfig("prelude-chart", () => ({
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

let urlState;
let lastSignals = null;

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
    name: "Prelude 9B", key: "main", color: MAIN_COLOR,
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
      color: RUN_COLORS[i % RUN_COLORS.length],
      dataSource: data,
      checkpoints: () => steps,
    });
  });
  return trajectories;
}

/** "20.1B", "201B", "1.05T". */
function formatTokens(tokens) {
  if (tokens >= 1e12) return (tokens / 1e12).toFixed(2) + "T";
  if (tokens >= 1e10) return Math.round(tokens / 1e9) + "B";
  return (tokens / 1e9).toFixed(1) + "B";
}

// ─────────────────────────────────────────────────────────────
// Chart config
// ─────────────────────────────────────────────────────────────

const chartConfig = {
  getTrajectories,
  xToTokens: (step) => step * tokensPerStep,
  xAxisLabel: "tokens",
  allShots,            // replaced in init() once data.json is loaded
  // Always fully zoomed: the y-axis fits the plotted points (and bands) of
  // the displayed shot on every render.
  yRangeFit: true,
  xRangeTight: true,
  plotlyConfig,
  hoverXFormat: (xTokens, traceName) => {
    const iteration = Math.round(xTokens / tokensPerStep);
    return `${traceName} — ${formatTokens(xTokens)} tokens (iteration ${iteration.toLocaleString()})`;
  },
  titlePrefix: "Prelude progress",
  // z-score / min-max reference the checkpoints of the main line and the
  // side runs together, so a run forked off the main line stays comparable.
  normAcrossTrajectories: true,
  // FineWeb2 signal measures of exactly what is plotted, shown under the
  // title. Ranking consistency needs several runs, so it is blank until a
  // side run is drawn next to the main line.
  onSeries: (series) => {
    lastSignals = computeSignals(series);
    renderSignals(document.getElementById("chart-signals"), lastSignals);
  },
};

// ─────────────────────────────────────────────────────────────
// Variant controls (task type / metric type / formulation / loglikelihood
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
  bind("metric-mode-select", (v) => state.metricMode = v);
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
  state.metricMode = setSelect("metric-mode-select", state.metricMode, "hard");
  state.currentDecoding = setSelect("decoding-select", state.currentDecoding, "sampling");
  state.currentPromptAgg = setSelect("prompt-agg-select", state.currentPromptAgg, "max");
  state.currentFormulation = setSelect("formulation-select", state.currentFormulation, "max");
  state.currentAccNorm = setSelect("acc-norm-select", state.currentAccNorm, "max");
  state.currentNormalization = setSelect("norm-select", state.currentNormalization, "baseline");
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
    { key: "mmode", get: () => state.metricMode, set: (v) => state.metricMode = v, default: "hard" },
    { key: "dec", get: () => state.currentDecoding, set: (v) => state.currentDecoding = v, default: "sampling" },
    { key: "prompt", get: () => state.currentPromptAgg, set: (v) => state.currentPromptAgg = LEGACY_PROMPT_AGG[v] || v, default: "max" },
    { key: "form", get: () => state.currentFormulation, set: (v) => state.currentFormulation = v, default: "max" },
    { key: "anorm", get: () => state.currentAccNorm, set: (v) => state.currentAccNorm = LEGACY_LL_NORM[v] || v, default: "max" },
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
      default: () => isAggregateSelection(state.currentTaskSelection) ? "baseline" : "none",
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
    if (state.DATA.shots?.length) allShots = state.DATA.shots.map(String);
    chartConfig.allShots = allShots;
    state.currentTaskSelection = DEFAULT_SELECTION;
    state.currentFormulation = "max";
    state.formulationCombine = true;
    state.currentAccNorm = "max";
    state.llNormScope = "all";
    state.metricMode = "hard";
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
