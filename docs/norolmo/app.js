// NorOLMo training-progress dashboard.
// Renders NorOLMo + ablation trajectories on the NorEval benchmark.
//
// Most chart logic lives in shared/progress.js. This file handles the
// dashboard-specific wiring: task dropdown, checkboxes, event listeners,
// URL state, and the construction of the "trajectories" list (main + ablations).

import { state } from "../shared/state.js";
import { isAggregateSelection } from "../shared/core.js";
import { makePlotlyConfig } from "../shared/chart.js";
import { buildTaskCheckboxes, bindModuleActionStopPropagation, attachControlTooltips, markAppReady } from "../shared/ui.js";
import { renderProgressChart, updateProgressTitle } from "../shared/progress.js";
import {
  setsEqual, getBenchmarksForSelection, autoSetNormalization,
  populateTaskDropdown, onTaskCheckboxChange, bindTaskControls,
  restoreCheckedTasksFromSelection, syncTaskControlsFromState,
} from "../shared/selection.js";
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

function getAblationDisplayName(ablName) {
  return state.DATA.ablation_display_names?.[ablName] || ablName;
}

// Run colors. The three final-model runs share one blue; the original run's
// stage-2/stage-3 continuation is brown; the remaining ablations get distinct
// orange/red shades. Keyed by run id (main segments + ablation names).
const FINAL_COLOR = "#2563eb";   // blue
const RUN_COLOR = {
  "main-stage1": FINAL_COLOR,
  "stage2-no-len-ext-stage2-data-half-decay": FINAL_COLOR,
  "stage3-mainline": FINAL_COLOR,
  "main-stage2": "#7c2d12",                                // original run (brown)
  "main-stage3": "#7c2d12",                                // original run (brown)
  "stage2-ablation-no-len-ext-stage1-data": "#f97316",     // orange
  "stage2-no-len-ext-stage1-data-half-decay": "#dc2626",   // red
  "stage2-newmix": "#9333ea",                              // violet
  "stage3-no-rope-scaling": "#fb923c",                     // light orange
  "stage3-rope-scaling": "#b45309",                        // amber
};

function colorFor(key) {
  return RUN_COLOR[key] || "#999999";
}

// Each ablation forked off a parent run; prepending the parent's checkpoint
// at the fork connects the lines visually instead of leaving a gap.
// Stage 2 ablations forked from the main run at step 24,000 (201.3B tokens);
// the older stage 3 ablations continue the last "stage 1 data, full decay"
// checkpoint, and stage3-mainline continues "stage 2 data, ½ decay".
const STAGE2_FORK_STEP = 24000;

function lastStep(data) {
  return Math.max(...Object.keys(data || {}).map(Number));
}

function getForkPoint(ablName) {
  const abl = state.DATA.ablations || {};
  if (ablName.startsWith("stage2")) {
    return { data: state.DATA.progress, step: STAGE2_FORK_STEP };
  }
  const parentName = ablName === "stage3-mainline"
    ? "stage2-no-len-ext-stage2-data-half-decay"
    : "stage2-ablation-no-len-ext-stage1-data";
  const parent = abl[parentName];
  return parent ? { data: parent, step: lastStep(parent) } : null;
}

// The three runs that compose the released NorOLMo model — one per stage.
// They're marked with star markers, drawn thicker, colored blue, ordered
// first in their column, and painted on top. The stage-1 segment of the
// original run IS the final model's pretraining; stage 2 and stage 3 are
// two specific ablations.
const FINAL_MODEL_RUNS = new Set([
  "main-stage1",                                // stage 1 (pretraining)
  "stage2-no-len-ext-stage2-data-half-decay",   // stage 2 (midtraining, 1→½)
  "stage3-mainline",                            // stage 3 (RoPE scaling, ½→0)
]);

// Last step a stage-2 run reached (= the step the stage-3 runs fork from).
function stage3ForkStep() {
  const abl = state.DATA.ablations || {};
  const stage2 = Object.keys(abl).filter((k) => k.startsWith("stage2"));
  return stage2.length ? Math.max(...stage2.map((k) => lastStep(abl[k]))) : STAGE2_FORK_STEP;
}

function getTrajectories() {
  const progress = state.DATA.progress;
  const mainSteps = getMainCheckpoints();
  const s1End = STAGE2_FORK_STEP;     // stage 1 → 2 boundary (24k / 201.3B)
  const s2End = stage3ForkStep();     // stage 2 → 3 boundary (30k)

  // The original NorOLMo run, split into its three stage segments so each
  // sits in its own legend column. Segments overlap by one checkpoint at the
  // stage boundaries so the line stays visually continuous across columns.
  const mainSegments = [
    { name: "pretraining data, 1→1 decay",
      key: "main-stage1", legendColumn: 0,
      steps: mainSteps.filter((s) => s <= s1End) },
    { name: "midtraining data, RoPE scaling, 1→0 decay",
      key: "main-stage2", legendColumn: 1,
      steps: mainSteps.filter((s) => s >= s1End && s <= s2End) },
    { name: "midtraining data, RoPE scaling, 1→0 decay",
      key: "main-stage3", legendColumn: 2,
      steps: mainSteps.filter((s) => s >= s2End) },
  ];
  const trajectories = mainSegments.map((seg) => ({
    name: seg.name,
    key: seg.key,
    color: colorFor(seg.key),
    dataSource: progress,
    checkpoints: () => seg.steps,
    legendColumn: seg.legendColumn,
  }));

  for (const ablName of Object.keys(state.DATA.ablations || {})) {
    let data = state.DATA.ablations[ablName];
    const fork = getForkPoint(ablName);
    if (fork && fork.data[fork.step]) {
      data = { [fork.step]: fork.data[fork.step], ...data };
    }
    const steps = Object.keys(data).map(Number).sort((a, b) => a - b);
    trajectories.push({
      name: getAblationDisplayName(ablName),
      // Stable unique id for Plotly legendgroups — display names may
      // repeat across runs (e.g. mainline vs the rope-scaling ablation).
      key: ablName,
      color: colorFor(ablName),
      dataSource: data,
      checkpoints: () => steps,
      legendColumn: ablName.startsWith("stage3") ? 2 : 1,
    });
  }

  // Flag the three final-model runs: thicker line, star markers, painted on
  // top via zorder (color + "first in column" ordering handled elsewhere).
  for (const traj of trajectories) {
    if (FINAL_MODEL_RUNS.has(traj.key)) {
      traj.emphasized = true;
      traj.zorder = 1;
    }
  }
  // Within each legend column, list the final-model run first. Stable sort
  // keeps the column grouping and the relative order of the rest.
  trajectories.sort((a, b) =>
    (a.legendColumn - b.legendColumn)
    || ((b.emphasized ? 1 : 0) - (a.emphasized ? 1 : 0)));
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
  yRangeSkipFirst: true,
  yMaxHeadroom: 0.25,   // extra top space (× data span) so the legend fits
  xRangeTight: true,
  legendColumns: [
    { title: "Stage 1", x: 0.01 },
    { title: "Stage 2", x: 0.22 },
    { title: "Stage 3", x: 0.5 },
  ],
  plotlyConfig,
  hoverXFormat: (xTokens, traceName) => {
    const step = Math.round(xTokens / TOKENS_PER_STEP);
    const tokensB = (xTokens / 1e9).toFixed(1);
    return `${traceName} — ${tokensB}B tokens (step ${step.toLocaleString()})`;
  },
  titlePrefix: "NorOLMo progress",
};

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
      // Unknown values (e.g. "__group__…" pair selections from old URLs)
      // fall back to the default aggregate view instead of an empty chart.
      set: (v) => {
        state.currentTaskSelection = (v === "__custom__" || getBenchmarksForSelection(v).length > 0)
          ? v : "__all_macro__";
      },
      default: "__all_macro__",
    },
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

    setupUrlState();
    const hasURL = urlState.load();
    restoreCheckedTasksFromSelection(urlState);

    populateTaskDropdown();
    bindTaskControls(render);
    buildTaskCheckboxes({
      filterSourceFn: () => state.checkedTasks,
      onChange: () => onTaskCheckboxChange(render),
    });
    bindModuleActionStopPropagation();
    attachControlTooltips();

    // The `norm` URL field has a dynamic default ("baseline" for aggregate
    // selections, "none" otherwise). That default is only applied on save —
    // when `norm` is absent on load, `state.currentNormalization` would
    // otherwise stay at the static state.js default ("baseline"), giving
    // wrong values for individual-task URLs. Apply the dynamic default here.
    if (!urlState.has("norm")) autoSetNormalization();

    if (hasURL) syncTaskControlsFromState();

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
