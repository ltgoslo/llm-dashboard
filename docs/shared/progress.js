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
  getScore, getCombinedCI, scaleCIDistances, applyNorm, toDisplayScale,
  getBaseMetric, getNormYLabel, getMetricYLabel,
  aggregateScores, isAggregateSelection, isMacroSelection,
  getEffectiveMetric, isStderrCompatible, formatTitleWithShot,
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

// Line/marker sizing — base values used when building traces, hover values
// applied to the whole hovered run via setTraceEmphasis().
const LINE_WIDTH = 2.5, LINE_WIDTH_HOVER = 4.5;
const MARKER_SIZE = 5, MARKER_SIZE_HOVER = 8;

/** Emphasize the hovered run: thicken its line and enlarge its markers.
 *  Pass null to clear. One Plotly.restyle call swaps the previous and new
 *  emphasis together; a same-trace no-op guard keeps mousemoves along a
 *  line from re-restyling. Bands are hoverinfo:"skip", so curve numbers
 *  here always refer to line traces. */
function setTraceEmphasis(curve) {
  const chartEl = document.getElementById("chart");
  if (!chartEl || !chartEl.data) return;
  const prev = chartEl._emphasizedTrace ?? null;
  if (prev === curve) return;
  chartEl._emphasizedTrace = curve;
  const indices = [], widths = [], sizes = [];
  if (prev != null && prev < chartEl.data.length) {
    indices.push(prev); widths.push(LINE_WIDTH); sizes.push(MARKER_SIZE);
  }
  if (curve != null && curve < chartEl.data.length) {
    indices.push(curve); widths.push(LINE_WIDTH_HOVER); sizes.push(MARKER_SIZE_HOVER);
  }
  if (indices.length) {
    Plotly.restyle(chartEl, { "line.width": widths, "marker.size": sizes }, indices);
  }
}

/** Map a legend entry's <g class="traces"> element to its trace index in
 *  chartEl.data. Primary: the d3-bound datum (legend items carry their full
 *  trace, whose .index is the position in gd.data). Fallback: match the
 *  legend label against line-trace names (bands carry no name). */
function legendItemTraceIndex(chartEl, item) {
  const d = item.__data__;
  const tr = d && d[0] && d[0].trace;
  if (tr && typeof tr.index === "number") return tr.index;
  const label = item.querySelector(".legendtext")?.textContent;
  if (!label) return null;
  const idx = (chartEl.data || []).findIndex((t) => t.name === label && t.fill !== "toself");
  return idx >= 0 ? idx : null;
}

/** Hovering a legend entry emphasizes its line just like hovering the line
 *  itself. Delegated on the chart container (bound once — the container
 *  div and its listeners survive Plotly re-renders), so it keeps working
 *  after every redraw. Tracks legend-driven emphasis separately so it
 *  never clears an emphasis set by plotly_hover on the lines. */
function attachLegendHoverEmphasis(chartEl) {
  if (chartEl._legendHoverBound) return;
  chartEl._legendHoverBound = true;
  chartEl.addEventListener("mouseover", (ev) => {
    const item = ev.target.closest(".infolayer .traces");
    if (item) {
      const idx = legendItemTraceIndex(chartEl, item);
      if (idx != null) {
        chartEl._legendEmphasis = idx;
        setTraceEmphasis(idx);
      }
    } else if (chartEl._legendEmphasis != null) {
      chartEl._legendEmphasis = null;
      setTraceEmphasis(null);
    }
  });
  chartEl.addEventListener("mouseleave", () => {
    if (chartEl._legendEmphasis != null) {
      chartEl._legendEmphasis = null;
      setTraceEmphasis(null);
    }
  });
}

/** Render a progress chart for the current task selection.
 *  config = { getTrajectories, xToTokens, xAxisLabel, hoverXFormat, titlePrefix,
 *             groupBenchmarks (optional, for grouped/paired views),
 *             plotlyConfig, legendPosition: "bottom-right"|"top-left",
 *             onTooltipExtra: optional callback for additional tooltip enrichment } */
export function renderProgressChart(config) {
  // Re-renders rebuild all traces at base width/size; drop any stale
  // emphasis index so it can't restyle the wrong trace later.
  const chartEl = document.getElementById("chart");
  if (chartEl) {
    chartEl._emphasizedTrace = null;
    chartEl._legendEmphasis = null;
    attachLegendHoverEmphasis(chartEl);
  }
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

/** Layout fragment for the legend(s). With config.legendColumns
 *  ([{title, x, y?}, …]) the chart gets one titled Plotly legend per
 *  column ("legend", "legend2", …), anchored top-left side by side;
 *  trajectories opt into a column via their `legendColumn` index.
 *  Without it, the single positional legend is used. */
function legendLayout(config) {
  if (!config.legendColumns) return { legend: legendFor(config) };
  const out = {};
  config.legendColumns.forEach((col, i) => {
    out[i === 0 ? "legend" : "legend" + (i + 1)] = {
      x: col.x ?? 0.01, y: col.y ?? 0.99, xanchor: "left", yanchor: "top",
      bgcolor: "rgba(255,255,255,0.7)", borderwidth: 0,
      // Title-to-entries spacing is handled in style.css (the legend
      // `.groups` translateY rule) -- Plotly has no padding option, and
      // a <br> in the title adds a full line-height, which is too much.
      title: { text: "<b>" + col.title + "</b>" },
    };
  });
  return out;
}

/** Plotly legend reference ("legend", "legend2", …) for a trajectory's
 *  legendColumn, or undefined when multi-column legends aren't configured. */
function legendRefFor(config, traj) {
  if (!config.legendColumns || traj.legendColumn == null) return undefined;
  return traj.legendColumn === 0 ? "legend" : "legend" + (traj.legendColumn + 1);
}

/** Resolve titlePrefix (string or function-returning-string). Returns "X – " or "". */
function resolveTitlePrefix(config) {
  const prefix = typeof config.titlePrefix === "function"
    ? config.titlePrefix()
    : config.titlePrefix;
  return prefix || "";
}

function formatCIStr(value, ci, fmt) {
  if (!ci || !state.showStderr) return "";
  const lo = value - (ci.loDist ?? 0);
  const hi = value + (ci.hiDist ?? 0);
  if (!(ci.loDist > 0 || ci.hiDist > 0)) return "";
  return ` (95% CI: ${Number(lo).toFixed(fmt)} – ${Number(hi).toFixed(fmt)})`;
}

function onProgressUnhover() {
  setTraceEmphasis(null);
  hideTooltip();
}

function makeHoverHandler(config) {
  return function onHover(data) {
    if (!data.points || !data.points.length) return;
    const pt = data.points[0];
    if (pt.y == null) return;
    setTraceEmphasis(pt.curveNumber);
    const fmt = state.currentNormalization === "zscore" ? 2 : 1;
    const scoreStr = Number(pt.y).toFixed(fmt);
    const cd = pt.customdata;
    const ci = (cd && typeof cd === "object" && cd.ci) ? cd.ci : null;
    const ciStr = formatCIStr(Number(pt.y), ci, fmt);

    let body;
    if (isAggregateSelection(state.currentTaskSelection)) {
      const unit = isMacroSelection() ? "categories" : "tasks";
      const countStr = cd && typeof cd === "object" ? cd.count : null;
      body = "Average: " + scoreStr + ciStr + (countStr != null ? " (" + countStr + " " + unit + ")" : "");
    } else if (state.currentTaskSelection.startsWith("__group__") && pt.data.name && config.groupBenchmarks) {
      body = pt.data.name + ": " + scoreStr + ciStr;
    } else {
      body = "Score: " + scoreStr + ciStr;
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

  // Compute y-range. Default: across all shots, for stable axes when
  // switching shots. With yRangeSkipFirst the range instead tracks only
  // the displayed shot, and each trajectory's first checkpoint is excluded
  // (still plotted — early-training outliers just shouldn't compress the
  // rest of the chart; the plot-area clip handles the spill).
  const rangeShots = config.yRangeSkipFirst ? [state.currentShot] : config.allShots;
  for (const shot of rangeShots) {
    for (const traj of trajectories) {
      const checkpoints = traj.checkpoints();
      const xEntities = checkpoints.map(String);
      const rangeXs = config.yRangeSkipFirst ? checkpoints.slice(1) : checkpoints;
      for (const x of rangeXs) {
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
  const yRange = computeYRange(allYValues, !!config.yRangeSkipFirst);

  // Build bands and lines in separate passes so every band paints below
  // every line — otherwise traj-N's band would occlude traj-(N-1)'s line.
  const lineTraces = [];
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
        const ci = wantSE
          ? scaleCIDistances(getCombinedCI(traj.dataSource, x, bench, state.currentShot), bench, undefined, allRaw)
          : undefined;
        return { score, ci };
      }, macro);
    });
    const scores = aggResults.map((r) => r ? r.score : null);
    const ciVals = aggResults.map((r) => r ? r.ci : null);
    const lref = legendRefFor(config, traj);

    if (wantSE) {
      const band = makeBandTrace(xs, scores, ciVals, traj.color, traj.name);
      if (band) {
        if (lref) band.legend = lref;
        traces.push(band);
      }
    }
    lineTraces.push({
      x: xs, y: scores, mode: "lines+markers", name: traj.name,
      legendgroup: traj.name,
      ...(lref && { legend: lref }),
      ...(traj.zorder != null && { zorder: traj.zorder }),
      line: { color: traj.color, width: LINE_WIDTH }, marker: { size: MARKER_SIZE },
      customdata: aggResults.map((r) => r ? { count: r.count, ci: r.ci } : null),
      hoverinfo: "none",
    });
  }
  traces.push(...lineTraces);

  const layout = getPlotlyLayout({
    margin: { l: 105, r: 4, t: 8, b: 50 },
    xaxis: { automargin: false, title: config.xAxisLabel },
    yaxis: {
      title: "", range: yRange,
      showgrid: true, gridcolor: "#d4d8dd", automargin: false, ticks: "", ticklen: 0,
      zeroline: state.currentNormalization === "zscore",
    },
    showlegend: trajectories.length > 1,
    ...legendLayout(config),
  });
  plotChart(traces, layout, config.plotlyConfig, makeHoverHandler(config), onProgressUnhover);
}

function renderGroupedProgress(config, group) {
  const trajectories = config.getTrajectories();
  const metric = getEffectiveMetric(group.benchmarks[0]);
  const useNorm = state.currentNormalization !== "none";
  const needAllRaw = ["minmax", "zscore", "percentile"].includes(state.currentNormalization);
  const wantSE = (state.showStderr || state.showPromptDeviation) && isStderrCompatible();
  const traces = [];
  const allYVals = [];

  // Collect y-range (see renderAggregateProgress for the yRangeSkipFirst
  // semantics: displayed shot only, first checkpoint excluded; the
  // normalization basis `raws` keeps all checkpoints to match the
  // plotting loop below).
  const rangeShots = config.yRangeSkipFirst ? [state.currentShot] : config.allShots;
  for (const shot of rangeShots) {
    for (const traj of trajectories) {
      for (const bench of group.benchmarks) {
        const xs = traj.checkpoints();
        const rangeXs = config.yRangeSkipFirst ? xs.slice(1) : xs;
        const raws = xs.map((x) => getScore(traj.dataSource, x, bench, shot, metric)).filter((v) => v !== undefined);
        for (const x of rangeXs) {
          const raw = getScore(traj.dataSource, x, bench, shot, metric);
          if (raw === undefined) continue;
          allYVals.push(useNorm
            ? applyNorm(raw, bench, needAllRaw ? raws : null, metric)
            : toDisplayScale(raw, bench, metric));
        }
      }
    }
  }
  const yRange = computeYRange(allYVals, !!config.yRangeSkipFirst);

  // Bands and lines in separate passes so every band paints below every line.
  const lineTraces = [];
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
      const cis = wantSE ? xValues.map((x) => {
        const ci = getCombinedCI(traj.dataSource, x, bench, state.currentShot, metric);
        return scaleCIDistances(ci, bench, metric, allRaw);
      }) : null;
      const lineColor = i === 0 ? traj.color : darkenColor(traj.color, 0.3);
      const traceName = (trajectories.length > 1 ? traj.name + " — " : "") + group.labels[i];
      const lref = legendRefFor(config, traj);
      if (wantSE && cis) {
        const band = makeBandTrace(xs, ys, cis, lineColor, traceName);
        if (band) {
          if (lref) band.legend = lref;
          traces.push(band);
        }
      }
      lineTraces.push({
        x: xs, y: ys, mode: "lines+markers",
        name: traceName,
        legendgroup: traceName,
        ...(lref && { legend: lref }),
        ...(traj.zorder != null && { zorder: traj.zorder }),
        line: { color: lineColor, width: LINE_WIDTH }, marker: { size: MARKER_SIZE },
        customdata: (cis || ys.map(() => null)).map((c) => c ? { ci: c } : null),
        hoverinfo: "none",
      });
    });
  }
  traces.push(...lineTraces);

  const yLabel = useNorm ? getNormYLabel() : getMetricYLabel(group.benchmarks[0], metric);
  const layout = getPlotlyLayout({
    margin: { l: 105, r: 4, t: 8, b: 50 },
    xaxis: { automargin: false, title: config.xAxisLabel },
    yaxis: {
      title: "", range: yRange,
      showgrid: true, gridcolor: "#d4d8dd", automargin: false, ticks: "", ticklen: 0,
      zeroline: state.currentNormalization === "zscore",
    },
    ...legendLayout(config),
  });
  plotChart(traces, layout, config.plotlyConfig, makeHoverHandler(config), onProgressUnhover);
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

  // With yRangeSkipFirst, the y-range tracks only the displayed shot and
  // each trajectory's first checkpoint is excluded (still plotted).
  const rangeShots = config.yRangeSkipFirst ? [state.currentShot] : config.allShots;
  for (const shot of rangeShots) {
    for (const traj of trajectories) {
      const checkpoints = traj.checkpoints();
      const rangeXs = config.yRangeSkipFirst ? checkpoints.slice(1) : checkpoints;
      for (const x of rangeXs) {
        const raw = getScore(traj.dataSource, x, benchmark, shot, metric);
        if (raw != null) {
          allYVals.push(useNorm
            ? applyNorm(raw, benchmark, null, metric)
            : toDisplayScale(raw, benchmark, metric));
        }
      }
    }
  }
  const tight = !!config.yRangeSkipFirst;
  const yRange = (useNorm || tight)
    ? computeYRange(allYVals, tight)
    : [0, computeYMax(allYVals)];

  // Bands and lines in separate passes so every band paints below every line.
  const lineTraces = [];
  for (const traj of trajectories) {
    const xValues = traj.checkpoints();
    if (!xValues.length) continue;
    const xs = xValues.map(config.xToTokens);
    const ys = xValues.map((x) => {
      const raw = getScore(traj.dataSource, x, benchmark, state.currentShot, metric);
      if (raw == null) return null;
      return useNorm ? applyNorm(raw, benchmark, null, metric) : toDisplayScale(raw, benchmark, metric);
    });
    const cis = wantSE ? xValues.map((x) => {
      const ci = getCombinedCI(traj.dataSource, x, benchmark, state.currentShot, metric);
      return scaleCIDistances(ci, benchmark, metric);
    }) : null;
    const lref = legendRefFor(config, traj);
    if (wantSE && cis) {
      const band = makeBandTrace(xs, ys, cis, traj.color, traj.name);
      if (band) {
        if (lref) band.legend = lref;
        traces.push(band);
      }
    }
    lineTraces.push({
      x: xs, y: ys, mode: "lines+markers", name: traj.name,
      legendgroup: traj.name,
      ...(lref && { legend: lref }),
      ...(traj.zorder != null && { zorder: traj.zorder }),
      line: { color: traj.color, width: LINE_WIDTH }, marker: { size: MARKER_SIZE },
      customdata: (cis || ys.map(() => null)).map((c) => c ? { ci: c } : null),
      hoverinfo: "none",
    });
  }
  traces.push(...lineTraces);

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
    ...legendLayout(config),
  });
  plotChart(traces, layout, config.plotlyConfig, makeHoverHandler(config), onProgressUnhover);
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
    if (g) return lead + formatTitleWithShot(g.name, shot);
  }
  if (state.metricsSetup[sel]) return lead + formatTitleWithShot(state.metricsSetup[sel].pretty_name, shot);
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
