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
//   - normAcrossTrajectories: reference set of the min-max / z-score
//     normalizations spans every trajectory's checkpoints (multisynt, where
//     the trajectories are different models) instead of each trajectory's own
//   - yRangeFit: the y-axis is fitted to exactly the plotted points (and
//     bands, when shown) of the displayed shot on every render — always
//     fully zoomed, no floor at 0 (multisynt). Without it the range is
//     computed up front by forEachRangeSlice: over every shot for stable
//     axes when switching shots, or tightly with yRangeSkipFirst.
//   - onSeries(series): optional, called after each render with the plotted
//     series — [{name, key, xs, ys, baselines}] per trajectory (tokens,
//     displayed scores, and where a chance-level model would be plotted) —
//     e.g. for the FineWeb2 signal measures

import { state } from "./state.js";
import {
  getScore, getCombinedCI, scaleCIDistances, applyNorm,
  aggregateScores, isAggregateSelection, isMacroSelection, getAggregatedTasks,
  getEffectiveMetric, formatTitleWithShot, capitalize, taskTitleDescription,
  wantCI, normNeedsAllValues, scoreDecimals, isRawScaleMetric, taskRandomBaseline, hasRandomBaseline,
  taskBaseMetric,
} from "./core.js";
import {
  getPlotlyLayout, plotChart,
  makeBandTrace, computeYRange, computeYMax, computeFitRange, makeYAxis,
} from "./chart.js";
import {
  showTooltip, hideTooltip,
  populateMetricSelector, hideMetricSelector, setChartHeader,
  defaultTaskDisplayName,
} from "./ui.js";

const PROGRESS_LEGEND = {
  x: 0.98, y: 0.02, xanchor: "right", yanchor: "bottom",
  bgcolor: "rgba(255,255,255,0.7)", borderwidth: 0,
};
const TOP_LEFT_LEGEND = {
  x: 0.0, y: 0.99, xanchor: "left", yanchor: "top",
  bgcolor: "rgba(255,255,255,0.8)", bordercolor: "#e2e8f0", borderwidth: 1,
};

// Line/marker sizing — base values used when building traces, hover values
// applied to the whole hovered run via setTraceEmphasis().
const LINE_WIDTH = 2.5, LINE_WIDTH_HOVER = 4.5;
const MARKER_SIZE = 6.5, MARKER_SIZE_HOVER = 9.5;
// Emphasized ("final model") runs: thicker at rest, thicker still on hover.
const LINE_WIDTH_FINAL = 4, LINE_WIDTH_FINAL_HOVER = 6;
const MARKER_SIZE_FINAL = 12.5, MARKER_SIZE_FINAL_HOVER = 15;

/** Base/hover line-width and marker-size for a trajectory, depending on
 *  whether it's flagged `emphasized` (a final-model run). Stored on each
 *  line trace as `_emph` so setTraceEmphasis can restore the right base. */
function emphasisFor(traj) {
  return traj && traj.emphasized
    ? { baseW: LINE_WIDTH_FINAL, baseS: MARKER_SIZE_FINAL,
        hoverW: LINE_WIDTH_FINAL_HOVER, hoverS: MARKER_SIZE_FINAL_HOVER, symbol: "star" }
    : { baseW: LINE_WIDTH, baseS: MARKER_SIZE,
        hoverW: LINE_WIDTH_HOVER, hoverS: MARKER_SIZE_HOVER, symbol: "circle" };
}

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
    const e = chartEl.data[prev]._emph;
    indices.push(prev);
    widths.push(e ? e.baseW : LINE_WIDTH); sizes.push(e ? e.baseS : MARKER_SIZE);
  }
  if (curve != null && curve < chartEl.data.length) {
    const e = chartEl.data[curve]._emph;
    indices.push(curve);
    widths.push(e ? e.hoverW : LINE_WIDTH_HOVER); sizes.push(e ? e.hoverS : MARKER_SIZE_HOVER);
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
      bgcolor: "rgba(0,0,0,0)", borderwidth: 0,
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

/** With config.xRangeTight, pin the x-axis to the first/last checkpoint
 *  (token units) across all trajectories plus a small margin (3% of the
 *  span on either side, config.xRangePad to change), replacing Plotly's
 *  larger autorange padding so the data spans almost the full plot width
 *  while the edge markers and the outermost tick label still fit. Returns
 *  undefined when disabled or degenerate (single x value). */
function tightXRange(config, trajectories) {
  if (!config.xRangeTight) return undefined;
  let min = Infinity, max = -Infinity;
  for (const traj of trajectories) {
    for (const x of traj.checkpoints()) {
      const t = config.xToTokens(x);
      if (t < min) min = t;
      if (t > max) max = t;
    }
  }
  if (!(min < max)) return undefined;
  const pad = (max - min) * (config.xRangePad ?? 0.03);
  return [min - pad, max + pad];
}

/** Resolve titlePrefix (string or function-returning-string). Returns "X – " or "". */
function resolveTitlePrefix(config) {
  const prefix = typeof config.titlePrefix === "function"
    ? config.titlePrefix()
    : config.titlePrefix;
  return prefix || "";
}

/** Iterate the (shot, trajectory) combinations whose scores define the
 *  y-range. Default: every shot in config.allShots and every checkpoint, for
 *  stable axes when switching shots. With config.yRangeSkipFirst the range
 *  instead tracks only the displayed shot, and each trajectory's first
 *  checkpoint is excluded (still plotted — early-training outliers just
 *  shouldn't compress the rest of the chart; the plot-area clip handles the
 *  spill). `fn(traj, shot, checkpoints, rangeXs)` receives both the full
 *  checkpoint list (e.g. as a normalization basis) and the included subset. */
function forEachRangeSlice(config, trajectories, fn) {
  if (config.yRangeFit) return;   // fitted to the plotted values instead
  const rangeShots = config.yRangeSkipFirst ? [state.currentShot] : config.allShots;
  for (const shot of rangeShots) {
    for (const traj of trajectories) {
      const checkpoints = traj.checkpoints();
      const rangeXs = config.yRangeSkipFirst ? checkpoints.slice(1) : checkpoints;
      fn(traj, shot, checkpoints, rangeXs);
    }
  }
}

/** Append one plotted run to the trace lists: its CI band (into `traces`,
 *  which paints below all lines) when `cis` is non-null, and its line trace
 *  (into `lineTraces`). */
function pushRunTraces(traces, lineTraces, config, traj, { xs, ys, cis, name, color, lgroup, customdata }) {
  const lref = legendRefFor(config, traj);
  const emph = emphasisFor(traj);
  if (cis) {
    const band = makeBandTrace(xs, ys, cis, color, lgroup);
    if (band) {
      if (lref) band.legend = lref;
      traces.push(band);
    }
  }
  lineTraces.push({
    x: xs, y: ys, mode: "lines+markers", name,
    legendgroup: lgroup,
    ...(lref && { legend: lref }),
    ...(traj.zorder != null && { zorder: traj.zorder }),
    line: { color, width: emph.baseW }, marker: { size: emph.baseS, symbol: emph.symbol },
    _emph: emph,
    customdata,
    hoverinfo: "none",
  });
}

/** Shared layout for the progress charts. */
function progressLayout(config, trajectories, yRange, showlegend) {
  const xRange = tightXRange(config, trajectories);
  return getPlotlyLayout({
    margin: { l: 105, r: 4, t: 8, b: 50 },
    xaxis: { automargin: false, title: config.xAxisLabel, ...(xRange && { range: xRange }) },
    yaxis: makeYAxis(yRange),
    ...(showlegend !== undefined && { showlegend }),
    ...legendLayout(config),
  });
}

/** Reference-set lookup for the min-max / z-score normalizations: the raw
 *  scores of one task (and shot) over the checkpoints of either this
 *  trajectory alone or, with config.normAcrossTrajectories, of all of them.
 *  Memoized per render. */
function makeRefScores(config, trajectories) {
  const cache = new Map();
  return (traj, bench, shot, metric) => {
    const scope = config.normAcrossTrajectories ? "*" : (traj.key || traj.name);
    const key = scope + "|" + bench + "|" + shot + "|" + (metric || "");
    if (cache.has(key)) return cache.get(key);
    const vals = [];
    // A side run starts with the main line's fork checkpoint (the very same
    // score block), which must not count twice in the reference set.
    const seen = new Set();
    for (const t of config.normAcrossTrajectories ? trajectories : [traj]) {
      for (const x of t.checkpoints()) {
        const block = t.dataSource[String(x)]?.[bench]?.[shot];
        if (block && typeof block === "object") {
          if (seen.has(block)) continue;
          seen.add(block);
        }
        const v = getScore(t.dataSource, String(x), bench, shot, metric);
        if (v !== undefined) vals.push(v);
      }
    }
    cache.set(key, vals);
    return vals;
  };
}

/** Collect the plotted extent of one run — its points, and the ends of its
 *  CI bands when drawn — for the fitted y-range. */
function collectFitValues(fitValues, ys, cis) {
  ys.forEach((y, i) => {
    if (y == null) return;
    fitValues.push(y);
    const ci = cis?.[i];
    if (ci) fitValues.push(y - (ci.loDist ?? 0), y + (ci.hiDist ?? 0));
  });
}

function formatCIStr(value, ci, fmt) {
  if (!ci) return "";
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
    const fmt = scoreDecimals();
    const scoreStr = Number(pt.y).toFixed(fmt);
    const cd = pt.customdata;
    const ci = (cd && typeof cd === "object" && cd.ci) ? cd.ci : null;
    const ciStr = formatCIStr(Number(pt.y), ci, fmt);

    let body;
    if (isAggregateSelection(state.currentTaskSelection)) {
      const unit = isMacroSelection() ? "categories" : "tasks";
      const countStr = cd && typeof cd === "object" ? cd.count : null;
      body = "Average: " + scoreStr + ciStr + (countStr != null ? " (" + countStr + " " + unit + ")" : "");
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
  const useCI = wantCI();
  const needAll = normNeedsAllValues();
  const tasks = getAggregatedTasks();
  const refScores = makeRefScores(config, trajectories);

  /** Aggregate {score, count, ci} at one checkpoint of one trajectory. */
  function aggregateAt(traj, x, shot, withCI) {
    return aggregateScores(tasks, (bench) => {
      const raw = getScore(traj.dataSource, x, bench, shot);
      if (raw === undefined) return undefined;
      const metric = taskBaseMetric(bench);
      const allRaw = needAll ? refScores(traj, bench, shot) : null;
      const score = applyNorm(raw, bench, allRaw, metric);
      const ci = withCI
        ? scaleCIDistances(getCombinedCI(traj.dataSource, x, bench, shot), bench, metric, allRaw)
        : undefined;
      return { score, ci };
    }, macro);
  }

  /** Where a chance-level model would be plotted at this checkpoint: each
   *  task's random baseline sent through the same normalization, aggregated
   *  over the same tasks that have a score here. The probability of the
   *  answer text has no chance level; a chance-level model assigns the
   *  exact answer (next to) no probability, so such a task enters at 0. */
  function baselineAt(traj, x, shot) {
    const r = aggregateScores(tasks, (bench) => {
      if (getScore(traj.dataSource, x, bench, shot) === undefined) return undefined;
      const metric = taskBaseMetric(bench);
      const allRaw = needAll ? refScores(traj, bench, shot) : null;
      const chance = hasRandomBaseline(metric) ? taskRandomBaseline(bench, metric) : 0;
      return { score: applyNorm(chance, bench, allRaw, metric) };
    }, macro);
    return r ? r.score : null;
  }

  const allYValues = [];
  forEachRangeSlice(config, trajectories, (traj, shot, checkpoints, rangeXs) => {
    for (const x of rangeXs) {
      const result = aggregateAt(traj, x, shot, false);
      if (result) allYValues.push(result.score);
    }
  });
  // Build bands and lines in separate passes so every band paints below
  // every line — otherwise traj-N's band would occlude traj-(N-1)'s line.
  const traces = [];
  const lineTraces = [];
  const series = [];
  const fitValues = [];
  for (const traj of trajectories) {
    const xValues = traj.checkpoints();
    if (!xValues.length) continue;
    const aggResults = xValues.map((x) => aggregateAt(traj, x, state.currentShot, useCI));
    const xs = xValues.map(config.xToTokens);
    const ys = aggResults.map((r) => r ? r.score : null);
    const cis = useCI ? aggResults.map((r) => r ? r.ci : null) : null;
    collectFitValues(fitValues, ys, cis);
    pushRunTraces(traces, lineTraces, config, traj, {
      xs, ys, cis,
      name: traj.name,
      color: traj.color,
      // Group by stable key, not display name — names can repeat across
      // trajectories, and Plotly merges same-group entries (killing the
      // tracegroupgap between them and tying their legend toggles).
      lgroup: traj.key || traj.name,
      customdata: aggResults.map((r) => r ? { count: r.count, ci: r.ci } : null),
    });
    if (config.onSeries) {
      series.push({
        name: traj.name, key: traj.key || traj.name, xs, ys,
        baselines: xValues.map((x) => baselineAt(traj, x, state.currentShot)),
      });
    }
  }
  traces.push(...lineTraces);

  const yRange = config.yRangeFit
    ? computeFitRange(fitValues)
    : computeYRange(allYValues, !!config.yRangeSkipFirst, config.yMaxHeadroom || 0);
  const layout = progressLayout(config, trajectories, yRange, trajectories.length > 1);
  plotChart(traces, layout, config.plotlyConfig, makeHoverHandler(config), onProgressUnhover);
  if (config.onSeries) config.onSeries(series);
}

function renderSingleProgress(config, benchmark) {
  if (!state.metricsSetup[benchmark]) return;
  const trajectories = config.getTrajectories();
  const metric = getEffectiveMetric(benchmark);
  const useCI = wantCI();
  const needAll = normNeedsAllValues();
  const refScores = makeRefScores(config, trajectories);
  const refFor = (traj, shot) => (needAll ? refScores(traj, benchmark, shot, metric) : null);

  const allYVals = [];
  forEachRangeSlice(config, trajectories, (traj, shot, checkpoints, rangeXs) => {
    for (const x of rangeXs) {
      const raw = getScore(traj.dataSource, x, benchmark, shot, metric);
      if (raw != null) allYVals.push(applyNorm(raw, benchmark, refFor(traj, shot), metric));
    }
  });
  const tight = !!config.yRangeSkipFirst;
  const rawScale = isRawScaleMetric(metric);

  // Bands and lines in separate passes so every band paints below every line.
  const traces = [];
  const lineTraces = [];
  const series = [];
  const fitValues = [];
  for (const traj of trajectories) {
    const xValues = traj.checkpoints();
    if (!xValues.length) continue;
    const allRaw = refFor(traj, state.currentShot);
    const xs = xValues.map(config.xToTokens);
    const ys = xValues.map((x) => {
      const raw = getScore(traj.dataSource, x, benchmark, state.currentShot, metric);
      return raw == null ? null : applyNorm(raw, benchmark, allRaw, metric);
    });
    const cis = useCI ? xValues.map((x) => {
      const ci = getCombinedCI(traj.dataSource, x, benchmark, state.currentShot, metric);
      return scaleCIDistances(ci, benchmark, metric, allRaw);
    }) : null;
    collectFitValues(fitValues, ys, cis);
    pushRunTraces(traces, lineTraces, config, traj, {
      xs, ys, cis,
      name: traj.name,
      color: traj.color,
      lgroup: traj.key || traj.name,
      customdata: (cis || ys.map(() => null)).map((c) => c ? { ci: c } : null),
    });
    if (config.onSeries) {
      // A raw log-likelihood or the probability of the answer text has no
      // chance level to plot.
      const baseline = hasRandomBaseline(metric) ? applyNorm(taskRandomBaseline(benchmark, metric), benchmark, allRaw, metric) : null;
      series.push({
        name: traj.name, key: traj.key || traj.name, xs, ys,
        baselines: ys.map((y) => (y == null ? null : baseline)),
      });
    }
  }
  traces.push(...lineTraces);

  const yRange = config.yRangeFit
    ? computeFitRange(fitValues)
    : (state.currentNormalization !== "none" || tight || rawScale)
      ? computeYRange(allYVals, tight, config.yMaxHeadroom || 0, rawScale)
      : [0, computeYMax(allYVals)];
  const layout = progressLayout(config, trajectories, yRange, trajectories.length > 1);
  plotChart(traces, layout, config.plotlyConfig, makeHoverHandler(config), onProgressUnhover);
  if (config.onSeries) config.onSeries(series);
}

// ─────────────────────────────────────────────────────────────
// Chart title & hover description
// ─────────────────────────────────────────────────────────────

/** Natural-language chart title.
 *  config.titlePrefix may add a leading qualifier (e.g. language name for multisynt
 *  or "NorOLMo" for norolmo). Aggregate views start with "Category average" / "Task average". */
/** "classification " / "generative " qualifier of the multisynt task-type
 *  selector, for titles and descriptions ("" when everything is kept). */
function taskTypeWord() {
  return { classification: "classification ", generation: "generative " }[state.taskTypeFilter] || "";
}

function getChartTitleText(config) {
  const sel = state.currentTaskSelection;
  const shot = state.currentShot + "-shot";
  const prefix = resolveTitlePrefix(config);
  const lead = prefix ? prefix + " — " : "";
  const avg = isMacroSelection() ? "category average" : "task average";
  const type = taskTypeWord();
  const n = getAggregatedTasks().length;

  if (sel === "__all_macro__" || sel === "__all__") return lead + avg + " across all " + type + "tasks (" + shot + ")";
  if (sel === "__custom__" || sel === "__custom_macro__") return lead + avg + " across " + n + " selected " + type + "tasks (" + shot + ")";
  if (sel.startsWith("__cat__")) return lead + avg + " across " + sel.slice(7) + " " + type + "tasks (" + shot + ")";
  if (sel.startsWith("__eval__")) return lead + avg + " across " + sel.slice(8) + " tasks (" + shot + ")";
  if (sel === "__lang__nob") return lead + avg + " across Bokmål tasks (" + shot + ")";
  if (sel === "__lang__nno") return lead + avg + " across Nynorsk tasks (" + shot + ")";
  if (sel === "__lang__sme") return lead + avg + " across Northern Sámi tasks (" + shot + ")";
  if (state.metricsSetup[sel]) return lead + formatTitleWithShot(defaultTaskDisplayName(sel), shot);
  return lead.replace(/ — $/, "");
}

/** Build the hover description for the chart title. */
function getChartTitleDescription(config) {
  const sel = state.currentTaskSelection;
  if (isAggregateSelection(sel)) {
    return { body: getProgressAggregateDescription(), footer: "" };
  }
  if (state.metricsSetup[sel]) {
    return taskTitleDescription(sel);
  }
  return { body: "", footer: "" };
}

/** Update the chart title and the inline description (shown when the user
 *  expands the <details> wrapping the title). */
export function updateProgressTitle(config) {
  setChartHeader(capitalize(getChartTitleText(config)), getChartTitleDescription(config));
}

function getProgressAggregateDescription() {
  const sel = state.currentTaskSelection;
  const aggregated = getAggregatedTasks();
  const count = aggregated.length || (state.checkedTasks.size > 0 ? state.checkedTasks.size : Object.keys(state.metricsSetup).length);
  const macro = isMacroSelection();
  const type = taskTypeWord();
  const cats = new Set();
  for (const b of aggregated) {
    const info = state.metricsSetup[b];
    if (info) cats.add(info.category);
  }
  const macroNote = macro ? " (" + cats.size + " categories, category average)" : " (task average)";
  let scope = "";
  if (sel === "__all_macro__" || sel === "__all__") scope = "all " + count + " " + type + "tasks" + macroNote;
  else if (sel === "__custom__" || sel === "__custom_macro__") scope = count + " selected " + type + "tasks" + macroNote;
  else if (sel.startsWith("__cat__")) scope = count + " " + type + "tasks in the \"" + sel.slice(7) + "\" category";
  else if (sel.startsWith("__eval__")) scope = "all " + count + " " + sel.slice(8) + " tasks";

  const avgDesc = macro
    ? "Scores are first averaged within each task category, then averaged across categories. This gives equal weight to each category regardless of how many tasks it contains. "
    : "";
  const normDescs = {
    none: "Scores are shown on their native metric scales without rescaling, then averaged.",
    baseline: "Each task score is rescaled to a 0–100 scale where 0 = random baseline performance and 100 = perfect score, then averaged across tasks. This accounts for different chance levels across tasks (e.g. 25% for 4-choice QA vs. 50% for binary classification).",
    minmax: "Each task score is rescaled to 0–100 using the minimum and maximum scores observed for that task across all plotted checkpoints, then averaged.",
    zscore: "Each task score is converted to a z-score (standard deviations from the mean score of that task across all plotted checkpoints), then averaged.",
    percentile: "Each task score is converted to a percentile rank, then averaged.",
  };
  const normDesc = normDescs[state.currentNormalization] || "";
  return "Aggregate score across " + scope + ". " + avgDesc + normDesc;
}
