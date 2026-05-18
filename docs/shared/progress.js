// Shared "training progress" line-chart logic.
//
// Norolmo uses this for a single trajectory (NorOLMo) plus ablation lines,
// and multisynt uses it for multiple base models per language. Both look the
// same from the renderer's perspective: a list of trajectories, each with a
// name, color, and {x: scoreObj} data map.
//
// Each dashboard supplies:
//   - getTrajectories(): [{name, color, dataSource, checkpoints()}, ...]
//       dataSource — the {xKey: {bench: {shot: {metric: scoreObj}}}} map
//       checkpoints() — sorted numeric x values for this trajectory
//   - xToTokens(x): converts a checkpoint key to a token value for the x-axis
//                   (identity for multisynt where keys are already tokens-B;
//                    multiplies by TOKENS_PER_STEP for norolmo)
//   - xAxisLabel: "tokens (B)" or similar
//   - getXAxisTickFormat(x): formats a hover-title (optional)

import { state } from "./state.js";
import {
  METRIC_DISPLAY, METRIC_DESCRIPTIONS,
  getScore, getCombinedSE, scaleStderr, applyNorm, toDisplayScale,
  getBaseMetric, getNormYLabel, getMetricYLabel,
  aggregateScores, isAggregateSelection, isMacroSelection,
  getEffectiveMetric, isStderrCompatible,
} from "./core.js";
import {
  darkenColor, getPlotlyLayout, plotChart,
  makeBandTrace, computeYRange, computeYMax,
} from "./chart.js";
import {
  showTooltip, hideTooltip, attachTooltip,
  populateMetricSelector, hideMetricSelector,
} from "./ui.js";

const PROGRESS_LEGEND = {
  x: 0.98, y: 0.02, xanchor: "right", yanchor: "bottom",
  bgcolor: "rgba(255,255,255,0.7)", borderwidth: 0,
};
const TOP_LEFT_LEGEND = {
  x: 0.01, y: 0.99, xanchor: "left", yanchor: "top",
  bgcolor: "rgba(255,255,255,0.8)", bordercolor: "#e2e8f0", borderwidth: 1,
};

/** Render a progress chart for the current task selection.
 *  config = { getTrajectories, xToTokens, xAxisLabel, hoverXFormat, titlePrefix,
 *             groupBenchmarks (optional, for grouped/paired views),
 *             plotlyConfig, legendPosition: "bottom-right"|"top-left",
 *             onTooltipExtra: optional callback for additional tooltip enrichment } */
export function renderProgressChart(config) {
  const sel = state.currentTaskSelection;

  if (isAggregateSelection(sel)) {
    hideMetricSelector();
    renderAggregateProgress(config);
  } else if (config.groupBenchmarks && sel.startsWith("__group__")) {
    const g = config.groupBenchmarks(sel.slice(9));
    if (g) {
      populateMetricSelector(g.benchmarks);
      renderGroupedProgress(config, g);
    }
  } else if (state.metricsSetup[sel]) {
    populateMetricSelector([sel]);
    renderSingleProgress(config, sel);
  }
}

function legendFor(config) {
  return config.legendPosition === "top-left" ? TOP_LEFT_LEGEND : PROGRESS_LEGEND;
}

/** Resolve titlePrefix (string or function-returning-string). Returns "X – " or "". */
function resolveTitlePrefix(config) {
  const prefix = typeof config.titlePrefix === "function"
    ? config.titlePrefix()
    : config.titlePrefix;
  return prefix || "";
}

function makeHoverHandler(config) {
  return function onHover(data) {
    if (!data.points || !data.points.length) return;
    const pt = data.points[0];
    if (pt.y == null) return;
    const fmt = state.currentNormalization === "zscore" ? 2 : 1;
    const scoreStr = Number(pt.y).toFixed(fmt);
    const cd = pt.customdata;

    let seStr = "";
    if (state.showStderr && cd != null) {
      if (cd && typeof cd === "object" && cd.stderr != null && cd.stderr > 0) {
        seStr = " ± " + Number(cd.stderr).toFixed(fmt);
      } else if (typeof cd === "number" && cd > 0) {
        seStr = " ± " + Number(cd).toFixed(fmt);
      }
    }

    let body;
    if (isAggregateSelection(state.currentTaskSelection)) {
      const unit = isMacroSelection() ? "categories" : "tasks";
      const countStr = cd && typeof cd === "object" ? cd.count : null;
      body = "Average: " + scoreStr + seStr + (countStr != null ? " (" + countStr + " " + unit + ")" : "");
    } else if (state.currentTaskSelection.startsWith("__group__") && pt.data.name && config.groupBenchmarks) {
      body = pt.data.name + ": " + scoreStr + seStr;
    } else {
      body = "Score: " + scoreStr + seStr;
    }

    const title = config.hoverXFormat
      ? config.hoverXFormat(pt.x, pt.data.name)
      : `${pt.data.name || ""} — ${pt.x}${config.xAxisLabel ? " " + config.xAxisLabel.replace(/^\w/, "") : ""}`;

    showTooltip(data.event, title, body, "", "");
  };
}

// ─────────────────────────────────────────────────────────────
// Renderers
// ─────────────────────────────────────────────────────────────

function renderAggregateProgress(config) {
  const trajectories = config.getTrajectories();
  const macro = isMacroSelection();
  const wantSE = (state.showStderr || state.showPromptDeviation) && isStderrCompatible();
  const needAllRaw = ["minmax", "zscore", "percentile"].includes(state.currentNormalization);
  const traces = [];
  const allYValues = [];

  // Compute y-range across all shots for stable axes.
  for (const shot of config.allShots) {
    for (const traj of trajectories) {
      for (const x of traj.checkpoints()) {
        const xEntities = traj.checkpoints().map(String);
        const result = aggregateScores(state.checkedTasks, (bench) => {
          const raw = getScore(traj.dataSource, x, bench, shot);
          if (raw === undefined) return undefined;
          const allRaw = needAllRaw
            ? xEntities.map((s) => getScore(traj.dataSource, s, bench, shot)).filter((v) => v !== undefined)
            : null;
          return applyNorm(raw, bench, allRaw);
        }, macro);
        if (result) allYValues.push(result.score);
      }
    }
  }
  const yRange = computeYRange(allYValues);

  for (const traj of trajectories) {
    const xValues = traj.checkpoints();
    if (!xValues.length) continue;
    const xEntities = xValues.map(String);
    const xs = xValues.map(config.xToTokens);
    const aggResults = xValues.map((x) => {
      return aggregateScores(state.checkedTasks, (bench) => {
        const raw = getScore(traj.dataSource, x, bench, state.currentShot);
        if (raw === undefined) return undefined;
        const allRaw = needAllRaw
          ? xEntities.map((s) => getScore(traj.dataSource, s, bench, state.currentShot)).filter((v) => v !== undefined)
          : null;
        const score = applyNorm(raw, bench, allRaw);
        const se = wantSE
          ? scaleStderr(getCombinedSE(traj.dataSource, x, bench, state.currentShot), bench, undefined, allRaw)
          : undefined;
        return { score, stderr: se };
      }, macro);
    });
    const scores = aggResults.map((r) => r ? r.score : null);
    const seVals = aggResults.map((r) => r ? r.stderr : null);

    if (wantSE) {
      const band = makeBandTrace(xs, scores, seVals, traj.color, traj.name);
      if (band) traces.push(band);
    }
    traces.push({
      x: xs, y: scores, mode: "lines+markers", name: traj.name,
      legendgroup: traj.name,
      line: { color: traj.color, width: 2.5 }, marker: { size: 5 },
      customdata: aggResults.map((r) => r ? { count: r.count, stderr: r.stderr } : null),
      hoverinfo: "none",
    });
  }

  const layout = getPlotlyLayout({
    margin: { l: 105, r: 4, t: 8, b: 50 },
    xaxis: { automargin: false, title: config.xAxisLabel },
    yaxis: {
      title: "", range: yRange,
      showgrid: true, gridcolor: "#d4d8dd", automargin: false, ticks: "", ticklen: 0,
      zeroline: state.currentNormalization === "zscore",
    },
    showlegend: trajectories.length > 1,
    legend: legendFor(config),
  });
  plotChart(traces, layout, config.plotlyConfig, makeHoverHandler(config), hideTooltip);
}

function renderGroupedProgress(config, group) {
  const trajectories = config.getTrajectories();
  const metric = getEffectiveMetric(group.benchmarks[0]);
  const useNorm = state.currentNormalization !== "none";
  const needAllRaw = ["minmax", "zscore", "percentile"].includes(state.currentNormalization);
  const wantSE = (state.showStderr || state.showPromptDeviation) && isStderrCompatible();
  const traces = [];
  const allYVals = [];

  // Collect y-range across all shots.
  for (const shot of config.allShots) {
    for (const traj of trajectories) {
      for (const bench of group.benchmarks) {
        const xs = traj.checkpoints();
        const raws = xs.map((x) => getScore(traj.dataSource, x, bench, shot, metric)).filter((v) => v !== undefined);
        for (const raw of raws) {
          allYVals.push(useNorm
            ? applyNorm(raw, bench, needAllRaw ? raws : null, metric)
            : toDisplayScale(raw, bench, metric));
        }
      }
    }
  }
  const yRange = computeYRange(allYVals);

  for (const traj of trajectories) {
    const xValues = traj.checkpoints();
    const xs = xValues.map(config.xToTokens);
    group.benchmarks.forEach((bench, i) => {
      const allRaw = needAllRaw
        ? xValues.map((x) => getScore(traj.dataSource, x, bench, state.currentShot, metric)).filter((v) => v !== undefined)
        : null;
      const ys = xValues.map((x) => {
        const raw = getScore(traj.dataSource, x, bench, state.currentShot, metric);
        if (raw == null) return null;
        return useNorm ? applyNorm(raw, bench, allRaw, metric) : toDisplayScale(raw, bench, metric);
      });
      const ses = wantSE ? xValues.map((x) => {
        const se = getCombinedSE(traj.dataSource, x, bench, state.currentShot, metric);
        return scaleStderr(se, bench, metric, allRaw);
      }) : null;
      const lineColor = i === 0 ? traj.color : darkenColor(traj.color, 0.3);
      const traceName = (trajectories.length > 1 ? traj.name + " — " : "") + group.labels[i];
      if (wantSE && ses) {
        const band = makeBandTrace(xs, ys, ses, lineColor, traceName);
        if (band) traces.push(band);
      }
      traces.push({
        x: xs, y: ys, mode: "lines+markers",
        name: traceName,
        legendgroup: traceName,
        line: { color: lineColor, width: 2.5 }, marker: { size: 5 },
        customdata: ses || ys.map(() => null),
        hoverinfo: "none",
      });
    });
  }

  const yLabel = useNorm ? getNormYLabel() : getMetricYLabel(group.benchmarks[0], metric);
  const layout = getPlotlyLayout({
    margin: { l: 105, r: 4, t: 8, b: 50 },
    xaxis: { automargin: false, title: config.xAxisLabel },
    yaxis: {
      title: "", range: yRange,
      showgrid: true, gridcolor: "#d4d8dd", automargin: false, ticks: "", ticklen: 0,
      zeroline: state.currentNormalization === "zscore",
    },
    legend: legendFor(config),
  });
  plotChart(traces, layout, config.plotlyConfig, makeHoverHandler(config), hideTooltip);
}

function renderSingleProgress(config, benchmark) {
  const info = state.metricsSetup[benchmark];
  if (!info) return;
  const trajectories = config.getTrajectories();
  const metric = getEffectiveMetric(benchmark);
  const useNorm = state.currentNormalization !== "none";
  const wantSE = (state.showStderr || state.showPromptDeviation) && isStderrCompatible();
  const traces = [];
  const allYVals = [];

  for (const shot of config.allShots) {
    for (const traj of trajectories) {
      for (const x of traj.checkpoints()) {
        const raw = getScore(traj.dataSource, x, benchmark, shot, metric);
        if (raw != null) {
          allYVals.push(useNorm
            ? applyNorm(raw, benchmark, null, metric)
            : toDisplayScale(raw, benchmark, metric));
        }
      }
    }
  }
  const yRange = useNorm ? computeYRange(allYVals) : [0, computeYMax(allYVals)];

  for (const traj of trajectories) {
    const xValues = traj.checkpoints();
    if (!xValues.length) continue;
    const xs = xValues.map(config.xToTokens);
    const ys = xValues.map((x) => {
      const raw = getScore(traj.dataSource, x, benchmark, state.currentShot, metric);
      if (raw == null) return null;
      return useNorm ? applyNorm(raw, benchmark, null, metric) : toDisplayScale(raw, benchmark, metric);
    });
    const ses = wantSE ? xValues.map((x) => {
      const se = getCombinedSE(traj.dataSource, x, benchmark, state.currentShot, metric);
      return scaleStderr(se, benchmark, metric);
    }) : null;
    if (wantSE && ses) {
      const band = makeBandTrace(xs, ys, ses, traj.color, traj.name);
      if (band) traces.push(band);
    }
    traces.push({
      x: xs, y: ys, mode: "lines+markers", name: traj.name,
      legendgroup: traj.name,
      line: { color: traj.color, width: 2.5 }, marker: { size: 5 },
      customdata: ses || ys.map(() => null),
      hoverinfo: "none",
    });
  }

  const yLabel = state.currentPromptAgg === "stdev"
    ? getNormYLabel()
    : (useNorm ? getNormYLabel() : getMetricYLabel(benchmark, metric));
  const layout = getPlotlyLayout({
    margin: { l: 105, r: 4, t: 8, b: 50 },
    xaxis: { automargin: false, title: config.xAxisLabel },
    yaxis: {
      title: "", range: yRange,
      showgrid: true, gridcolor: "#d4d8dd", automargin: false, ticks: "", ticklen: 0,
      zeroline: state.currentNormalization === "zscore",
    },
    showlegend: trajectories.length > 1,
    legend: legendFor(config),
  });
  plotChart(traces, layout, config.plotlyConfig, makeHoverHandler(config), hideTooltip);
}

// ─────────────────────────────────────────────────────────────
// Chart title & hover description
// ─────────────────────────────────────────────────────────────

/** Natural-language chart title.
 *  config.titlePrefix may add a leading qualifier (e.g. language name for multisynt
 *  or "NorOLMo" for norolmo). Aggregate views start with "Category average" / "Task average". */
function getChartTitleText(config) {
  const sel = state.currentTaskSelection;
  const shot = state.currentShot + "-shot";
  const prefix = resolveTitlePrefix(config);
  const lead = prefix ? prefix + " — " : "";
  const avg = isMacroSelection() ? "category average" : "task average";

  if (sel === "__all_macro__" || sel === "__all__") return lead + avg + " across all tasks (" + shot + ")";
  if (sel === "__filtered__") return lead + avg + " across " + state.checkedTasks.size + " signal-filtered tasks (" + shot + ")";
  if (sel === "__custom__") return lead + avg + " across " + state.checkedTasks.size + " selected tasks (" + shot + ")";
  if (sel.startsWith("__cat__")) return lead + avg + " across " + sel.slice(7) + " tasks (" + shot + ")";
  if (sel.startsWith("__eval__")) return lead + avg + " across " + sel.slice(8) + " tasks (" + shot + ")";
  if (sel === "__lang__nob") return lead + avg + " across Bokmål tasks (" + shot + ")";
  if (sel === "__lang__nno") return lead + avg + " across Nynorsk tasks (" + shot + ")";
  if (sel === "__lang__sme") return lead + avg + " across Northern Sámi tasks (" + shot + ")";
  if (config.groupBenchmarks && sel.startsWith("__group__")) {
    const g = config.groupBenchmarks(sel.slice(9));
    if (g) return lead + g.name + " (" + shot + ")";
  }
  if (state.metricsSetup[sel]) return lead + state.metricsSetup[sel].pretty_name + " (" + shot + ")";
  return lead.replace(/ — $/, "");
}

/** Build the hover description for the chart title. */
function getChartTitleDescription(config) {
  const sel = state.currentTaskSelection;
  if (isAggregateSelection(sel)) {
    return { body: getProgressAggregateDescription(), footer: "" };
  }
  let body = "", url = "";
  if (config.groupBenchmarks && sel.startsWith("__group__")) {
    const g = config.groupBenchmarks(sel.slice(9));
    if (g) {
      const info = state.metricsSetup[g.benchmarks[0]];
      if (info) {
        body = info.description || "";
        url = info.url || "";
        const metric = getEffectiveMetric(g.benchmarks[0]);
        const metricName = METRIC_DISPLAY[metric] || metric;
        const baseMetric = getBaseMetric(metric);
        const metricDesc = METRIC_DESCRIPTIONS[baseMetric] || METRIC_DESCRIPTIONS[metric] || "";
        body = (body ? body + " " : "") + "Metric: " + metricName + ". " + metricDesc;
      }
    }
  } else if (state.metricsSetup[sel]) {
    const info = state.metricsSetup[sel];
    body = info.description || "";
    url = info.url || "";
    const metric = getEffectiveMetric(sel);
    const metricName = METRIC_DISPLAY[metric] || metric;
    const baseMetric = getBaseMetric(metric);
    const metricDesc = METRIC_DESCRIPTIONS[baseMetric] || METRIC_DESCRIPTIONS[metric] || "";
    body = (body ? body + " " : "") + "Metric: " + metricName + ". " + metricDesc;
  }
  const footer = url ? url.replace("https://huggingface.co/", "https://hf.co/") : "";
  return { body, footer };
}

/** Capitalize the first letter (so lowercase pretty_names lead with a capital). */
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/** Update the chart title and the inline description (shown when the user
 *  expands the <details> wrapping the title). */
export function updateProgressTitle(config) {
  const titleEl = document.getElementById("chart-title");
  if (titleEl) titleEl.textContent = capitalize(getChartTitleText(config));

  const descEl = document.getElementById("chart-description");
  if (!descEl) return;
  const { body, footer } = getChartTitleDescription(config);
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

function getProgressAggregateDescription() {
  const sel = state.currentTaskSelection;
  const count = sel === "__custom__" || sel === "__filtered__"
    ? state.checkedTasks.size
    : (state.checkedTasks.size > 0 ? state.checkedTasks.size : Object.keys(state.metricsSetup).length);
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
  else if (sel === "__filtered__") scope = count + " signal-filtered tasks (task average, HPLT-E criteria)";
  else if (sel === "__custom__") scope = count + " selected tasks (task average)";
  else if (sel.startsWith("__cat__")) scope = count + " tasks in the \"" + sel.slice(7) + "\" category";

  const avgDesc = macro
    ? "Scores are first averaged within each task category, then averaged across categories. This gives equal weight to each category regardless of how many tasks it contains. "
    : "";
  const normDescs = {
    none: "Scores are shown on their native metric scales without normalization, then averaged.",
    baseline: "Each task score is normalized to a 0–100 scale where 0 = random baseline performance and 100 = perfect score, then averaged across tasks. This accounts for different chance levels across tasks (e.g. 25% for 4-choice QA vs. 50% for binary classification).",
    minmax: "Each task score is normalized to 0–100 using the minimum and maximum scores observed across all entities for that task, then averaged.",
    zscore: "Each task score is converted to a z-score, then averaged.",
    percentile: "Each task score is converted to a percentile rank, then averaged.",
  };
  const normDesc = normDescs[state.currentNormalization] || "";
  return "Aggregate score across " + scope + ". " + avgDesc + normDesc;
}
