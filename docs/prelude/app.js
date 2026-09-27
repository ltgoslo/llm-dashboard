// OpenEuroLLM Prelude training-progress dashboard (NorEval 1.2).
//
// Renders the Prelude 9B main-line trajectory — plus any side runs found in
// data.json (`runs`, e.g. an anneal forked off the main line) — on the
// NorEval 1.2 benchmark. Most chart logic lives in shared/progress.js. This
// file handles the dashboard-specific wiring: task dropdown, checkboxes,
// event listeners, URL state, the trajectory list, and the NorEval-1.2
// formulation / accuracy-norm selectors (see resolveScoreObj in core.js).

import { state } from "../shared/state.js";
import { isAggregateSelection, ACC_NORM_VARIANTS } from "../shared/core.js";
import { makePlotlyConfig } from "../shared/chart.js";
import {
  buildTaskCheckboxes, bindModuleActionStopPropagation, attachControlTooltips, markAppReady,
} from "../shared/ui.js";
import { renderProgressChart, updateProgressTitle } from "../shared/progress.js";
import {
  setsEqual, getBenchmarksForSelection, autoSetNormalization,
  populateTaskDropdown, onTaskCheckboxChange, bindTaskControls,
  restoreCheckedTasksFromSelection, syncTaskControlsFromState,
} from "../shared/selection.js";
import { UrlState } from "../shared/url-state.js";

// Fallbacks, overridden from data.json (`tokens_per_step`, `shots`).
let tokensPerStep = 2048 * 4096;   // 8,388,608 tokens per training iteration
let allShots = ["5"];

const MAIN_COLOR = "#2563eb";                                          // blue
const RUN_COLORS = ["#dc2626", "#f97316", "#9333ea", "#0d9488", "#b45309"];

const plotlyConfig = makePlotlyConfig("prelude-chart", () => ({
  shot: state.currentShot + "-shot",
  task_selection: state.currentTaskSelection,
  prompt_aggregation: state.currentPromptAgg,
  formulation: state.currentFormulation,
  accuracy_norm: state.currentAccNorm,
  normalization: state.currentNormalization,
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
  yRangeSkipFirst: true,
  xRangeTight: true,
  plotlyConfig,
  hoverXFormat: (xTokens, traceName) => {
    const iteration = Math.round(xTokens / tokensPerStep);
    return `${traceName} — ${formatTokens(xTokens)} tokens (iteration ${iteration.toLocaleString()})`;
  },
  titlePrefix: "Prelude progress",
};

// ─────────────────────────────────────────────────────────────
// NorEval-1.2 variant controls (formulation / accuracy norm) + shots
// ─────────────────────────────────────────────────────────────

const FORMULATION_LABELS = { cf: "CF", mcf: "MCF", hybrid: "Hybrid" };

/** Show the formulation and accuracy-norm selectors only when the data
 *  carries the corresponding variants, and rebuild the formulation options
 *  from the formulations actually present. Both selectors act only on tasks
 *  that have the variants — see resolveScoreObj in core.js. */
function updateVariantControls() {
  const ms = state.metricsSetup;
  const forms = new Set();
  let hasAccVariants = false;
  for (const info of Object.values(ms)) {
    for (const f of info.formulations || []) forms.add(f);
    if (info.main_metric === "acc"
        && ACC_NORM_VARIANTS.every((m) => (info.available_metrics || []).includes(m))) {
      hasAccVariants = true;
    }
  }

  const formSelect = document.getElementById("formulation-select");
  document.getElementById("formulation-control").style.display = forms.size ? "" : "none";
  formSelect.innerHTML = "";
  const options = ["max", ...Object.keys(FORMULATION_LABELS).filter((f) => forms.has(f))];
  for (const f of options) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = FORMULATION_LABELS[f] || f;
    formSelect.appendChild(opt);
  }
  if (!options.includes(state.currentFormulation)) state.currentFormulation = "max";
  formSelect.value = state.currentFormulation;

  document.getElementById("acc-norm-control").style.display = hasAccVariants ? "" : "none";
  document.getElementById("acc-norm-select").value = state.currentAccNorm;
}

/** Keep only the shot buttons for which data.json has results. */
function updateShotButtons() {
  const buttons = [...document.querySelectorAll(".shot-btn")];
  for (const b of buttons) b.style.display = allShots.includes(b.dataset.shot) ? "" : "none";
  if (!allShots.includes(state.currentShot)) state.currentShot = allShots[0];
  for (const b of buttons) b.classList.toggle("active", b.dataset.shot === state.currentShot);
}

function bindVariantControls() {
  document.getElementById("formulation-select").addEventListener("change", (e) => {
    state.currentFormulation = e.target.value;
    render();
  });
  document.getElementById("acc-norm-select").addEventListener("change", (e) => {
    state.currentAccNorm = e.target.value;
    render();
  });
  document.querySelectorAll(".ci-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelector(".ci-btn.active")?.classList.remove("active");
      btn.classList.add("active");
      state.showCIBands = btn.dataset.ci === "1";
      render();
    });
  });
}

function syncVariantControlsFromState() {
  document.getElementById("formulation-select").value = state.currentFormulation;
  document.getElementById("acc-norm-select").value = state.currentAccNorm;
  document.querySelectorAll(".ci-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.ci === (state.showCIBands ? "1" : "0")));
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
    {
      key: "task",
      get: () => state.currentTaskSelection,
      // Unknown values fall back to the default aggregate view instead of
      // an empty chart.
      set: (v) => {
        state.currentTaskSelection = (v === "__custom__" || getBenchmarksForSelection(v).length > 0)
          ? v : "__all_macro__";
      },
      default: "__all_macro__",
    },
    { key: "prompt", get: () => state.currentPromptAgg, set: (v) => state.currentPromptAgg = v, default: "max" },
    { key: "form", get: () => state.currentFormulation, set: (v) => state.currentFormulation = v, default: "max" },
    { key: "anorm", get: () => state.currentAccNorm, set: (v) => state.currentAccNorm = v, default: "max" },
    { key: "ci", get: () => state.showCIBands ? "1" : "0", set: (v) => state.showCIBands = v !== "0", default: "1" },
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
    state.currentFormulation = "max";
    state.currentAccNorm = "max";

    setupUrlState();
    const hasURL = urlState.load();
    restoreCheckedTasksFromSelection(urlState);

    populateTaskDropdown();
    updateVariantControls();
    updateShotButtons();
    bindTaskControls(render);
    bindVariantControls();
    buildTaskCheckboxes({
      filterSourceFn: () => state.checkedTasks,
      onChange: () => onTaskCheckboxChange(render),
    });
    bindModuleActionStopPropagation();
    attachControlTooltips();

    // The `norm` URL field has a dynamic default ("baseline" for aggregate
    // selections, "none" otherwise) that is only applied on save; apply it
    // here when `norm` is absent so individual-task URLs don't inherit the
    // static state.js default.
    if (!urlState.has("norm")) autoSetNormalization();

    if (hasURL) {
      syncTaskControlsFromState();
      syncVariantControlsFromState();
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
