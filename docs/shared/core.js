// Shared score-access, normalization, and aggregation helpers.
//
// Reads from state.js. Dashboards pass `dataSource` explicitly to score-access
// functions because each dashboard has a different score-tree shape (a flat
// {model: {bench: …}} map, a multilingual {lang: {model: …}}, ablation maps, etc.).

import { state } from "./state.js";

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

export const MODEL_COLORS = [
  "#6366f1", "#f43f5e", "#10b981", "#f59e0b", "#8b5cf6",
  "#06b6d4", "#ec4899", "#84cc16", "#14b8a6", "#f97316",
  "#3b82f6", "#ef4444", "#22c55e", "#a855f7", "#0ea5e9",
];

export const METRIC_DISPLAY = {
  acc: "accuracy",
  acc_norm: "accuracy (normalized)",
  f1: "F1",
  em: "exact match",
  em_first: "exact match (first word)",
  exact: "exact match",
  exact_match: "exact match",
  fscore: "F-score",
  bleu: "BLEU",
  bleu_max: "BLEU (best ref.)",
  bleu_avg: "BLEU (avg ref.)",
  bleu_acc: "BLEU accuracy",
  chrf: "chrF",
  ter: "TER",
  is_included: "inclusion rate",
  rougeL_max: "ROUGE-L (best ref.)",
  rougeL_avg: "ROUGE-L (avg ref.)",
  rougeL_acc: "ROUGE-L accuracy",
  rouge1_max: "ROUGE-1 (best ref.)",
  rouge1_acc: "ROUGE-1 accuracy",
  rouge2_max: "ROUGE-2 (best ref.)",
  rouge2_acc: "ROUGE-2 accuracy",
  rouge1: "ROUGE-1",
  bertscore_f1_max: "BERTScore F1 (best ref.)",
  bertscore_f1_avg: "BERTScore F1 (avg ref.)",
  mcc: "MCC",
  errant: "ERRANT F0.5",
  errant_f05: "ERRANT F0.5",
};

export const METRIC_SCALES = {
  acc: "unit", acc_norm: "unit", f1: "unit", em: "unit", em_first: "unit",
  exact: "unit", exact_match: "unit", fscore: "unit", bleu_acc: "unit",
  rougeL_acc: "unit", rouge1_acc: "unit", rouge2_acc: "unit",
  mcc: "unit", is_included: "unit",
  bertscore_f1_max: "unit", bertscore_f1_avg: "unit",
  errant: "unit", errant_f05: "unit",
  bleu: "percent", bleu_max: "percent", bleu_avg: "percent",
  chrf: "percent", ter: "percent", rouge1: "percent",
  rougeL_max: "percent", rougeL_avg: "percent",
  rouge1_max: "percent", rouge2_max: "percent",
};

export const METRIC_DESCRIPTIONS = {
  acc: "Proportion of correctly classified examples.",
  acc_norm: "Accuracy after normalizing for answer option length.",
  f1: "Harmonic mean of precision and recall.",
  em: "Proportion of predictions that exactly match the reference.",
  em_first: "Exact match accuracy of the first generated word against the correct completion word.",
  exact: "Proportion of predictions that exactly match the reference.",
  exact_match: "Proportion of predictions that exactly match the reference.",
  fscore: "Token-level overlap between predicted and reference text.",
  bleu: "Measures n-gram overlap between generated and reference text.",
  bleu_max: "Highest BLEU score across multiple reference texts.",
  bleu_avg: "Average BLEU score across multiple reference texts.",
  bleu_acc: "Fraction of examples where the generation is more similar (by BLEU) to correct answers than incorrect ones.",
  chrf: "Character-level F-score between generated and reference text.",
  rougeL_max: "Longest common subsequence overlap with the best-matching reference.",
  rougeL_avg: "Average longest common subsequence overlap across references.",
  rougeL_acc: "Fraction of examples where the generation is more similar (by ROUGE-L) to correct answers than incorrect ones.",
  rouge1_max: "Unigram overlap with the best-matching reference.",
  rouge1_acc: "Fraction of examples where the generation is more similar (by ROUGE-1) to correct answers than incorrect ones.",
  rouge2_max: "Bigram overlap with the best-matching reference.",
  rouge2_acc: "Fraction of examples where the generation is more similar (by ROUGE-2) to correct answers than incorrect ones.",
  errant: "Grammar error correction metric emphasizing precision (F0.5) over recall.",
  errant_f05: "Grammar error correction metric emphasizing precision (F0.5) over recall.",
  mcc: "Matthews correlation coefficient for classification.",
};

// ─────────────────────────────────────────────────────────────
// Metric helpers
// ─────────────────────────────────────────────────────────────

/** Extract the base metric name from a subtask metric like "acc: Person: 1→2" → "acc". */
export function getBaseMetric(metric) {
  if (!metric) return metric;
  const sep = metric.indexOf(": ");
  return sep !== -1 && METRIC_SCALES[metric.slice(0, sep)] ? metric.slice(0, sep) : metric;
}

/** Convert raw stored score to a 0–100 display scale. */
export function toDisplayScale(value, benchmark, metric) {
  const base = metric ? getBaseMetric(metric) : null;
  const scale = base ? (METRIC_SCALES[base] || "unit") : state.metricsSetup[benchmark].metric_scale;
  return scale === "unit" ? value * 100 : value;
}

// ─────────────────────────────────────────────────────────────
// Score access (prompt-aggregation aware)
// ─────────────────────────────────────────────────────────────

/** Pull raw score from a data source, respecting the current prompt aggregation.
 *  The "stdev" prompt-agg returns prompt_sd (used by multisynt). */
export function getScore(dataSource, entity, bench, shot, metric) {
  metric = metric || state.metricsSetup[bench]?.main_metric;
  const obj = dataSource[entity]?.[bench]?.[shot]?.[metric];
  if (obj === undefined || obj === null) return undefined;
  if (typeof obj === "number") return state.currentPromptAgg === "stdev" ? 0 : obj;
  if (state.currentPromptAgg === "stdev") return obj.prompt_sd != null ? obj.prompt_sd : undefined;
  return obj[state.currentPromptAgg];
}

/** Pull sampling stderr matching the current prompt-aggregation. */
export function getStderr(dataSource, entity, bench, shot, metric) {
  metric = metric || state.metricsSetup[bench]?.main_metric;
  const obj = dataSource[entity]?.[bench]?.[shot]?.[metric];
  if (obj === undefined || obj === null) return undefined;
  if (typeof obj === "number") return undefined;
  const se = obj[state.currentPromptAgg + "_stderr"];
  return (se !== undefined && se !== null) ? se : undefined;
}

/** Prompt-variant SE: SD(prompt_scores) / sqrt(n_prompts). */
export function getPromptSE(dataSource, entity, bench, shot, metric) {
  metric = metric || state.metricsSetup[bench]?.main_metric;
  const obj = dataSource[entity]?.[bench]?.[shot]?.[metric];
  if (!obj || typeof obj === "number") return undefined;
  const sd = obj.prompt_sd;
  const n = obj.n_prompts;
  if (sd == null || n == null || n < 2) return undefined;
  return sd / Math.sqrt(n);
}

/** Combined SE = sqrt(sampling_se^2 + prompt_se^2), respecting toggles.
 *  Returns undefined when the prompt-agg is "stdev" (no error bars for SD bars). */
export function getCombinedSE(dataSource, entity, bench, shot, metric) {
  if (state.currentPromptAgg === "stdev") return undefined;
  const sampSe = state.showStderr ? getStderr(dataSource, entity, bench, shot, metric) : undefined;
  const promptSe = state.showPromptDeviation ? getPromptSE(dataSource, entity, bench, shot, metric) : undefined;
  if (sampSe == null && promptSe == null) return undefined;
  return Math.sqrt((sampSe || 0) ** 2 + (promptSe || 0) ** 2);
}

// ─────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────

/** Baseline normalization: 0 = random baseline, 100 = perfect. */
export function baselineNorm(raw, benchmark) {
  const info = state.metricsSetup[benchmark];
  const base = info.random_baseline, max = info.max_performance;
  return max === base ? 0 : ((raw - base) / (max - base)) * 100;
}

/** Apply the current normalization to a raw score.
 *  For min-max / z-score / percentile, pass `allRaw` = all raw scores for this benchmark
 *  across the entities being compared. */
export function applyNorm(raw, benchmark, allRaw, metric) {
  if (state.currentPromptAgg === "stdev") return toDisplayScale(raw, benchmark, metric);
  if (state.currentNormalization === "none") return toDisplayScale(raw, benchmark, metric);
  if (state.currentNormalization === "baseline") return baselineNorm(raw, benchmark);
  if (state.currentNormalization === "minmax") {
    if (!allRaw || allRaw.length < 2) return toDisplayScale(raw, benchmark, metric);
    const mn = Math.min(...allRaw), mx = Math.max(...allRaw);
    return mx === mn ? 50 : ((raw - mn) / (mx - mn)) * 100;
  }
  if (state.currentNormalization === "zscore") {
    if (!allRaw || allRaw.length < 2) return 0;
    const mean = allRaw.reduce((a, b) => a + b, 0) / allRaw.length;
    const std = Math.sqrt(allRaw.reduce((s, v) => s + (v - mean) ** 2, 0) / allRaw.length);
    return std === 0 ? 0 : (raw - mean) / std;
  }
  if (state.currentNormalization === "percentile") {
    if (!allRaw || allRaw.length < 2) return 50;
    const below = allRaw.filter((v) => v < raw).length;
    const equal = allRaw.filter((v) => v === raw).length;
    return ((below + (equal - 1) / 2) / (allRaw.length - 1)) * 100;
  }
  return toDisplayScale(raw, benchmark, metric);
}

/** Scale a stderr value for display using the same linear transform as the score. */
export function scaleStderr(se, benchmark, metric, allRaw) {
  if (se === undefined || se === null) return undefined;
  if (state.currentNormalization === "none") return toDisplayScale(se, benchmark, metric);
  if (state.currentNormalization === "baseline") {
    const info = state.metricsSetup[benchmark];
    const range = info.max_performance - info.random_baseline;
    return range === 0 ? 0 : (se / range) * 100;
  }
  if (state.currentNormalization === "minmax") {
    if (!allRaw || allRaw.length < 2) return toDisplayScale(se, benchmark, metric);
    const mn = Math.min(...allRaw), mx = Math.max(...allRaw);
    return mx === mn ? 0 : (se / (mx - mn)) * 100;
  }
  if (state.currentNormalization === "zscore") {
    if (!allRaw || allRaw.length < 2) return 0;
    const mean = allRaw.reduce((a, b) => a + b, 0) / allRaw.length;
    const std = Math.sqrt(allRaw.reduce((s, v) => s + (v - mean) ** 2, 0) / allRaw.length);
    return std === 0 ? 0 : se / std;
  }
  return undefined;  // percentile: non-linear, error bars not meaningful
}

/** Whether the current normalization can display sampling error bars meaningfully. */
export function isStderrCompatible() {
  return state.currentNormalization !== "percentile";
}

// ─────────────────────────────────────────────────────────────
// Y-axis labels
// ─────────────────────────────────────────────────────────────

export function getNormYLabel() {
  if (state.currentPromptAgg === "stdev") return "prompt stdev (0–100)";
  if (state.currentNormalization === "baseline") return "normalized score (baseline=0, perfect=100)";
  if (state.currentNormalization === "minmax") return "normalized score (min-max across models)";
  if (state.currentNormalization === "zscore") return "z-score (standard deviations from mean)";
  if (state.currentNormalization === "percentile") return "percentile rank (0=worst, 100=best)";
  return "score (0–100)";
}

export function getMetricYLabel(benchmark, metric) {
  const m = metric || state.metricsSetup[benchmark].main_metric;
  if (METRIC_DISPLAY[m]) return METRIC_DISPLAY[m];
  const base = getBaseMetric(m);
  if (base !== m && METRIC_DISPLAY[base]) return METRIC_DISPLAY[base];
  return m;
}

// ─────────────────────────────────────────────────────────────
// Selection / aggregation helpers
// ─────────────────────────────────────────────────────────────

export function isMacroSelection() {
  return state.currentTaskSelection === "__all_macro__";
}

/** Group a benchmark set by category for macro-averaging. */
export function getMacroGroups(benchmarks) {
  const benchSet = benchmarks instanceof Set ? benchmarks : new Set(benchmarks);
  const categoryGroups = {};
  for (const bench of benchSet) {
    const info = state.metricsSetup[bench];
    if (!info) continue;
    const cat = info.category;
    if (!categoryGroups[cat]) categoryGroups[cat] = [];
    categoryGroups[cat].push(bench);
  }
  return Object.values(categoryGroups);
}

/** Compute an aggregate score over `benchmarks` using a per-benchmark scoreFn.
 *  - macro=true: average within categories first, then across categories.
 *  - macro=false: simple micro-average across all benchmarks.
 *  scoreFn(bench) returns { score, stderr } | number | undefined.
 *  Returns { score, count, stderr } | null. */
export function aggregateScores(benchmarks, scoreFn, macro) {
  if (macro) {
    const groups = getMacroGroups(benchmarks);
    let groupSum = 0, groupCount = 0, groupSe2 = 0;
    for (const group of groups) {
      let sum = 0, count = 0, se2 = 0;
      for (const bench of group) {
        const r = scoreFn(bench);
        if (r === undefined) continue;
        const s = (typeof r === "number") ? r : r.score;
        if (s === undefined) continue;
        sum += s; count++;
        const se = (typeof r === "object" && r.stderr != null) ? r.stderr : 0;
        se2 += se * se;
      }
      if (count > 0) {
        groupSum += sum / count;
        groupSe2 += se2 / (count * count);
        groupCount++;
      }
    }
    if (groupCount === 0) return null;
    return {
      score: groupSum / groupCount,
      count: groupCount,
      stderr: Math.sqrt(groupSe2) / groupCount,
    };
  } else {
    let sum = 0, count = 0, se2 = 0;
    for (const bench of benchmarks) {
      const r = scoreFn(bench);
      if (r === undefined) continue;
      const s = (typeof r === "number") ? r : r.score;
      if (s === undefined) continue;
      sum += s; count++;
      const se = (typeof r === "object" && r.stderr != null) ? r.stderr : 0;
      se2 += se * se;
    }
    if (count === 0) return null;
    return { score: sum / count, count, stderr: Math.sqrt(se2) / count };
  }
}

/** True for any aggregating task selection (all / category / language / eval-type / custom / filtered). */
export function isAggregateSelection(sel) {
  return sel === "__all__" || sel === "__all_macro__" || sel === "__custom__"
      || sel === "__filtered__"
      || sel.startsWith("__cat__") || sel.startsWith("__lang__") || sel.startsWith("__eval__");
}

/** Effective metric for an individual/group view (currentMetric override, else main_metric). */
export function getEffectiveMetric(benchmark) {
  return state.currentMetric || state.metricsSetup[benchmark]?.main_metric;
}
