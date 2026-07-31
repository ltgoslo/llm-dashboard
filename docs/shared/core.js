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
  acc_norm: "accuracy (character norm)",
  acc_mutual_info: "accuracy (PMI norm)",
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
  acc: "unit", acc_norm: "unit", acc_mutual_info: "unit",
  f1: "unit", em: "unit", em_first: "unit",
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
  acc_norm: "Accuracy after normalizing answer log-likelihoods by character length.",
  acc_mutual_info: "Accuracy after normalizing answer log-likelihoods by their unconditional (PMI) likelihood.",
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

// Proper capitalization for dataset/acronym names appearing as the
// parenthetical part of a pretty_name (only applied in chart titles, where
// the dataset name reads as a proper noun). Keys are lowercase; missing
// entries fall back to first-letter capitalization.
export const TASK_NAME_DISPLAY = {
  belebele: "Belebele",
  cola: "CoLA",
  openbookqa: "OpenBookQA",
  truthfulqa: "TruthfulQA",
  multiblimp: "MultiBLiMP",
  norquad: "NorQuAD",
  norsumm: "NorSumm",
  "nrk-quiz": "NRK-quiz",
};

/** Capitalize the first letter (so lowercase pretty_names lead with a capital). */
export function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Build a chart-title task label that folds the shot setting into a trailing
 *  parenthetical, e.g. "reading comprehension (belebele)" + "5-shot" becomes
 *  "reading comprehension (Belebele; 5-shot)". The parenthetical's contents
 *  are looked up in TASK_NAME_DISPLAY for proper-noun casing, falling back
 *  to first-letter capitalization when the name already starts lowercase. */
export function formatTitleWithShot(name, shot) {
  if (!name) return "(" + shot + ")";
  const m = name.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (!m) return name + " (" + shot + ")";
  const inner = m[2];
  const display = TASK_NAME_DISPLAY[inner.toLowerCase()]
    || (/^[a-z]/.test(inner) ? inner.charAt(0).toUpperCase() + inner.slice(1) : inner);
  return m[1] + " (" + display + "; " + shot + ")";
}

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

/** The accuracy-normalization variants the multisynt "Accuracy norm"
 *  selector chooses between (in the order they are compared for "max"). */
export const ACC_NORM_VARIANTS = ["acc", "acc_norm", "acc_mutual_info"];

/** Resolve the stored score entry for one (bench, shot) block, honoring the
 *  multisynt formulation and accuracy-normalization selectors. Inert on
 *  dashboards that never set those state fields (both null) or for tasks
 *  without the corresponding variants:
 *   - state.currentFormulation ("cf"/"mcf"/"hybrid") swaps in the entry's
 *     `by_form` sub-aggregate when the task has one; "max" keeps the pooled
 *     aggregate over all formulations.
 *   - state.currentAccNorm redirects the main-metric "acc" lookup to one of
 *     ACC_NORM_VARIANTS, or, for "max", to whichever variant scores highest
 *     under the current prompt aggregation. Only applies when the block
 *     carries all three variants; an explicit non-acc metric selection
 *     bypasses it. */
export function resolveScoreObj(shotBlock, bench, metric) {
  if (!shotBlock) return undefined;
  const main = state.metricsSetup[bench]?.main_metric;
  metric = metric || main;
  const form = state.currentFormulation;
  const pickForm = (obj) =>
    obj && typeof obj === "object" && form && form !== "max" && obj.by_form?.[form]
      ? obj.by_form[form]
      : obj;

  const anorm = state.currentAccNorm;
  if (anorm && metric === "acc" && main === "acc"
      && ACC_NORM_VARIANTS.every((m) => shotBlock[m] != null)) {
    if (anorm !== "max") return pickForm(shotBlock[anorm]);
    // "stdev" has no score to rank variants by; use the best prompt instead.
    const aggField = state.currentPromptAgg === "stdev" ? "max" : state.currentPromptAgg;
    let best;
    let bestV = -Infinity;
    for (const m of ACC_NORM_VARIANTS) {
      const o = pickForm(shotBlock[m]);
      const v = typeof o === "number" ? o : o?.[aggField];
      if (v != null && v > bestV) { best = o; bestV = v; }
    }
    if (best !== undefined) return best;
  }
  return pickForm(shotBlock[metric]);
}

/** Pull raw score from a data source, respecting the current prompt aggregation.
 *  The "stdev" prompt-agg returns prompt_sd (used by multisynt). */
export function getScore(dataSource, entity, bench, shot, metric) {
  const obj = resolveScoreObj(dataSource[entity]?.[bench]?.[shot], bench, metric);
  if (obj === undefined || obj === null) return undefined;
  if (typeof obj === "number") return state.currentPromptAgg === "stdev" ? 0 : obj;
  if (state.currentPromptAgg === "stdev") return obj.prompt_sd != null ? obj.prompt_sd : undefined;
  return obj[state.currentPromptAgg];
}

/** Pull stored asymmetric 95% CI (loDist, hiDist) for the current prompt
 *  aggregation, where loDist = point − ci_lo and hiDist = ci_hi − point.
 *
 *  The build pipeline precomputes these CIs:
 *    - max / min:  Bonferroni union bound across the k prompts, using
 *                  Clopper–Pearson exact binomial for proportion-like
 *                  metrics and the normal approximation with the harness/
 *                  Wilson SE otherwise. Intentionally asymmetric.
 *    - mean:       Welch–Satterthwaite combination of sampling and between-
 *                  prompt variance.
 *    - median / first: sampling CI of the selected prompt (no Bonferroni).
 *
 *  Estimand: θ_k = aggregation_{i ≤ k} μ(p_i) — over the k specific prompts
 *  evaluated, not the prompt-population supremum. */
export function getCIDistances(dataSource, entity, bench, shot, metric) {
  const obj = resolveScoreObj(dataSource[entity]?.[bench]?.[shot], bench, metric);
  if (!obj || typeof obj === "number") return undefined;
  const agg = state.currentPromptAgg;
  if (agg === "stdev") return undefined;
  const v = obj[agg];
  const lo = obj[agg + "_ci_lo"];
  const hi = obj[agg + "_ci_hi"];
  if (v == null || lo == null || hi == null) return undefined;
  return { loDist: Math.max(0, v - lo), hiDist: Math.max(0, hi - v) };
}

/** CI distances for display. Returns undefined for the "stdev" prompt-
 *  aggregation (no CI on SD bars). The sampling and prompt-template
 *  uncertainty are already combined inside the stored CI — the multi-prompt
 *  structure is baked into the Bonferroni / Welch estimator. */
export function getCombinedCI(dataSource, entity, bench, shot, metric) {
  if (state.currentPromptAgg === "stdev") return undefined;
  return getCIDistances(dataSource, entity, bench, shot, metric);
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

/** Scale a single distance (lo or hi half-width) by the current normalization
 *  factor. All normalizations except percentile are linear, so we just divide
 *  by the local "scale" of the normalization. */
function scaleDistance(dist, benchmark, metric, allRaw) {
  if (dist === undefined || dist === null) return undefined;
  if (state.currentNormalization === "none") return toDisplayScale(dist, benchmark, metric);
  if (state.currentNormalization === "baseline") {
    const info = state.metricsSetup[benchmark];
    const range = info.max_performance - info.random_baseline;
    return range === 0 ? 0 : (dist / range) * 100;
  }
  if (state.currentNormalization === "minmax") {
    if (!allRaw || allRaw.length < 2) return toDisplayScale(dist, benchmark, metric);
    const mn = Math.min(...allRaw), mx = Math.max(...allRaw);
    return mx === mn ? 0 : (dist / (mx - mn)) * 100;
  }
  if (state.currentNormalization === "zscore") {
    if (!allRaw || allRaw.length < 2) return 0;
    const mean = allRaw.reduce((a, b) => a + b, 0) / allRaw.length;
    const std = Math.sqrt(allRaw.reduce((s, v) => s + (v - mean) ** 2, 0) / allRaw.length);
    return std === 0 ? 0 : dist / std;
  }
  return undefined;  // percentile: non-linear, CIs not meaningful
}

/** Scale a (loDist, hiDist) CI pair using the same linear transform as the
 *  score. Returns undefined under percentile normalization. */
export function scaleCIDistances(ci, benchmark, metric, allRaw) {
  if (!ci) return undefined;
  const lo = scaleDistance(ci.loDist, benchmark, metric, allRaw);
  const hi = scaleDistance(ci.hiDist, benchmark, metric, allRaw);
  if (lo === undefined || hi === undefined) return undefined;
  return { loDist: lo, hiDist: hi };
}

/** Whether error bars / CI bands should be rendered for the current view.
 *  CIs are shown under every normalization except percentile — a non-linear
 *  rank transform with no meaningful interval — and can be turned off
 *  entirely via the multisynt error-bands toggle. */
export function wantCI() {
  return state.showCIBands && state.currentNormalization !== "percentile";
}

/** Whether the current normalization needs the raw scores of all compared
 *  entities as its reference set (min-max / z-score / percentile). */
export function normNeedsAllValues() {
  return ["minmax", "zscore", "percentile"].includes(state.currentNormalization);
}

/** Decimal places for displayed scores (z-scores get an extra digit). */
export function scoreDecimals() {
  return state.currentNormalization === "zscore" ? 2 : 1;
}

// ─────────────────────────────────────────────────────────────
// Y-axis labels
// ─────────────────────────────────────────────────────────────

export function getNormYLabel() {
  if (state.currentPromptAgg === "stdev") return "prompt stdev";
  if (state.currentNormalization === "baseline") return "normalized score";
  if (state.currentNormalization === "minmax") return "normalized score";
  if (state.currentNormalization === "zscore") return "z-score";
  if (state.currentNormalization === "percentile") return "percentile rank";
  return "score";
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

/** Sum scores and squared CI distances over one benchmark set. */
function accumulateScores(benchmarks, scoreFn) {
  let sum = 0, count = 0, lo2 = 0, hi2 = 0;
  for (const bench of benchmarks) {
    const r = scoreFn(bench);
    if (r === undefined) continue;
    const s = (typeof r === "number") ? r : r.score;
    if (s === undefined) continue;
    sum += s; count++;
    const ci = (typeof r === "object" && r.ci) ? r.ci : null;
    const lo = ci?.loDist ?? 0, hi = ci?.hiDist ?? 0;
    lo2 += lo * lo; hi2 += hi * hi;
  }
  return { sum, count, lo2, hi2 };
}

/** Compute an aggregate score over `benchmarks` using a per-benchmark scoreFn.
 *  - macro=true: average within categories first, then across categories.
 *  - macro=false: simple micro-average across all benchmarks.
 *  scoreFn(bench) returns { score, ci } | number | undefined, where
 *  ci = { loDist, hiDist } if available.
 *  Returns { score, count, ci } | null. Lower and upper CI distances are
 *  propagated independently as √(Σ d²)/N — the same quadrature rule we use
 *  for SEs, but applied to each side of the asymmetric interval. */
export function aggregateScores(benchmarks, scoreFn, macro) {
  if (macro) {
    let groupSum = 0, groupCount = 0, groupLo2 = 0, groupHi2 = 0;
    for (const group of getMacroGroups(benchmarks)) {
      const { sum, count, lo2, hi2 } = accumulateScores(group, scoreFn);
      if (count > 0) {
        groupSum += sum / count;
        groupLo2 += lo2 / (count * count);
        groupHi2 += hi2 / (count * count);
        groupCount++;
      }
    }
    if (groupCount === 0) return null;
    return {
      score: groupSum / groupCount,
      count: groupCount,
      ci: { loDist: Math.sqrt(groupLo2) / groupCount, hiDist: Math.sqrt(groupHi2) / groupCount },
    };
  }
  const { sum, count, lo2, hi2 } = accumulateScores(benchmarks, scoreFn);
  if (count === 0) return null;
  return {
    score: sum / count,
    count,
    ci: { loDist: Math.sqrt(lo2) / count, hiDist: Math.sqrt(hi2) / count },
  };
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

/** Chart-title description for a single benchmark: the task description plus
 *  "Metric: <name>. <metric description>", and the task URL (as footer).
 *  `subtaskDescFn(bench, metric)` may supply a per-subtask description that
 *  overrides the base metric's. Returns { body, footer }. */
export function taskTitleDescription(benchmark, subtaskDescFn) {
  const info = state.metricsSetup[benchmark];
  if (!info) return { body: "", footer: "" };
  const metric = getEffectiveMetric(benchmark);
  const metricName = METRIC_DISPLAY[metric] || metric;
  const baseMetric = getBaseMetric(metric);
  const subtaskDesc = subtaskDescFn ? subtaskDescFn(benchmark, metric) : null;
  const metricDesc = subtaskDesc || METRIC_DESCRIPTIONS[baseMetric] || METRIC_DESCRIPTIONS[metric] || "";
  const body = (info.description ? info.description + " " : "")
    + "Metric: " + metricName + ". " + metricDesc;
  const url = info.url || "";
  return { body, footer: url ? url.replace("https://huggingface.co/", "https://hf.co/") : "" };
}
