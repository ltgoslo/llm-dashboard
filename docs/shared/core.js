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
  prob_correct: "conditional probability of correct",
  prob_correct_norm: "conditional probability of correct (character norm)",
  prob_correct_mutual_info: "conditional probability of correct (PMI norm)",
  likelihood_correct: "probability of correct",
  likelihood_correct_norm: "probability of correct (character norm)",
  pmi_correct: "PMI of correct answer",
  f1: "F1",
  f1_norm: "F1 (character norm)",
  f1_mutual_info: "F1 (PMI norm)",
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
  norm_loglikelihood_corr: "log-likelihood (correct answer)",
};

export const METRIC_SCALES = {
  acc: "unit", acc_norm: "unit", acc_mutual_info: "unit",
  prob_correct: "unit", prob_correct_norm: "unit", prob_correct_mutual_info: "unit",
  likelihood_correct: "unit", likelihood_correct_norm: "unit",
  f1: "unit", f1_norm: "unit", f1_mutual_info: "unit", em: "unit", em_first: "unit",
  exact: "unit", exact_match: "unit", fscore: "unit", bleu_acc: "unit",
  rougeL_acc: "unit", rouge1_acc: "unit", rouge2_acc: "unit",
  mcc: "unit", is_included: "unit",
  bertscore_f1_max: "unit", bertscore_f1_avg: "unit",
  errant: "unit", errant_f05: "unit",
  bleu: "percent", bleu_max: "percent", bleu_avg: "percent",
  chrf: "percent", ter: "percent", rouge1: "percent",
  rougeL_max: "percent", rougeL_avg: "percent",
  rouge1_max: "percent", rouge2_max: "percent",
  // "raw": shown on its native scale (no ×100), may be negative, and is
  // exempt from the random-baseline normalization and the y ≥ 0 axis floor.
  norm_loglikelihood_corr: "raw",
  pmi_correct: "raw",
};

/** Whether a metric is displayed on its own raw (possibly negative) scale. */
export function isRawScaleMetric(metric) {
  return METRIC_SCALES[getBaseMetric(metric)] === "raw";
}

// Base metrics without a chance level: a task's random baseline is defined
// for its main metric (and its soft metric); the probability of generating
// the correct answer text, like a raw log-likelihood, has none.
const NO_BASELINE_METRICS = new Set(["likelihood_correct", "pmi_correct"]);

/** Whether the task's random baseline applies to `metric` — false for the
 *  raw-scale metrics and the probability of the correct answer, which are
 *  shown unnormalized under the random-baseline normalization. */
export function hasRandomBaseline(metric) {
  if (!metric) return true;
  return !isRawScaleMetric(metric) && !NO_BASELINE_METRICS.has(llNormBase(getBaseMetric(metric)));
}

export const METRIC_DESCRIPTIONS = {
  acc: "Proportion of correctly classified examples.",
  acc_norm: "Accuracy after normalizing answer log-likelihoods by character length.",
  acc_mutual_info: "Accuracy after normalizing answer log-likelihoods by their unconditional (PMI) likelihood.",
  prob_correct: "Conditional probability of the correct answer: the probability mass on it after normalizing the answer likelihoods over the choices (soft accuracy).",
  likelihood_correct: "Probability of the correct answer text: the exponentiated mean log-likelihood the model assigns to it, not normalized over the choices. Under the character-length normalization this is a per-character probability.",
  pmi_correct: "Pointwise mutual information of the correct answer text and the prompt: its log-likelihood given the prompt minus its log-likelihood without it. Raw (log) scale; higher is better.",
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
  norm_loglikelihood_corr: "Length-normalized log-likelihood of the correct answer. Raw (negative) scale; higher is better.",
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

// ── Log-likelihood normalization variants ──
// NorEval 1.2 scores every answer-ranking metric under three normalizations
// of the answer log-likelihoods: none (`<m>`), character length (`<m>_norm`)
// and PMI (`<m>_mutual_info`). The multisynt "Loglikelihood normalization"
// selector picks one of them (or the best-scoring one) orthogonally to the
// base metric; see resolvePoint().

/** Suffix a selector value maps to; undefined for "max" (best of the three).
 *  Accepts both the generic values and the legacy acc-named ones. */
const LL_NORM_SUFFIX = {
  none: "", norm: "_norm", mutual_info: "_mutual_info",
  acc: "", acc_norm: "_norm", acc_mutual_info: "_mutual_info",
};

/** "acc_norm" → "acc", "prob_correct_mutual_info" → "prob_correct"; a base
 *  metric (or a subtask metric, or `norm_loglikelihood_corr`) is returned
 *  unchanged. */
export function llNormBase(metric) {
  if (!metric || metric.indexOf(": ") !== -1) return metric;
  for (const suffix of ["_mutual_info", "_norm"]) {
    if (metric.endsWith(suffix) && metric.length > suffix.length) {
      return metric.slice(0, -suffix.length);
    }
  }
  return metric;
}

/** The three normalization variants of a base metric. */
export function llNormVariants(base) {
  return [base, base + "_norm", base + "_mutual_info"];
}

/** Whether `metrics` (an array or Set) carries `base` together with at
 *  least one of its normalization variants (the probability of the correct
 *  answer has only the character-length one). */
export function hasLLNormVariants(metrics, base) {
  const set = metrics instanceof Set ? metrics : new Set(metrics || []);
  const [plain, ...variants] = llNormVariants(base);
  return set.has(plain) && variants.some((m) => set.has(m));
}

/** The base metrics the "Classification metric" selector of the aggregate
 *  views (multisynt, prelude, norprelude) chooses between: accuracy, the
 *  probability of the correct answer text and its conditional probability
 *  among the choices (NorEval 1.2's `likelihood_correct` / `prob_correct`). */
export const CLASSIFICATION_METRICS = ["acc", "likelihood_correct", "prob_correct"];

/** A task's metric under the classification-metric selector: the selected
 *  metric where a classification task has it, else its accuracy (a task
 *  without the probability metrics, or whose main metric is macro-F1 or
 *  MCC), else — as on the dashboards without the selector — its main
 *  metric. */
export function taskBaseMetric(benchmark) {
  const info = state.metricsSetup[benchmark];
  if (!info) return undefined;
  const wanted = state.classificationMetric;
  if (!wanted || info.evaluation_type !== "classification") return info.main_metric;
  const has = (m) => (info.available_metrics || []).includes(m);
  return has(wanted) ? wanted : has("acc") ? "acc" : info.main_metric;
}

/** Random baseline of a task for `metric`: the metric's own where the task
 *  declares one (`random_baselines`: NoReC's accuracy and conditional answer
 *  probability next to its macro-F1 main metric), else the task's. */
export function taskRandomBaseline(benchmark, metric) {
  const info = state.metricsSetup[benchmark];
  metric = metric || taskBaseMetric(benchmark);
  const own = metric ? info.random_baselines?.[llNormBase(getBaseMetric(metric))] : undefined;
  return own != null ? own : info.random_baseline;
}

/** Whether a task is kept by the multisynt task-type selector (null/"all"
 *  on the other dashboards keeps everything). */
export function taskTypeMatches(benchmark) {
  const t = state.taskTypeFilter;
  if (!t || t === "all") return true;
  return state.metricsSetup[benchmark]?.evaluation_type === t;
}

/** The checked tasks that pass the task-type selector — the set every
 *  aggregate view averages over. */
export function getAggregatedTasks() {
  return [...state.checkedTasks].filter(taskTypeMatches);
}

// ─────────────────────────────────────────────────────────────
// Score access (prompt-aggregation aware)
// ─────────────────────────────────────────────────────────────

/** The accuracy-normalization variants the "Accuracy norm" selector of the
 *  prelude dashboard chooses between (in the order they are compared for
 *  "max"). */
export const ACC_NORM_VARIANTS = ["acc", "acc_norm", "acc_mutual_info"];

/** The stored prompt-aggregation entry of `metric` in one (bench, shot)
 *  block: the greedy-decoding run (`by_decoding.greedy`) when the Decoding
 *  selector asks for it and the entry has one, and within that the
 *  formulation's `by_form` sub-aggregate when `form` names one the entry
 *  has (else the pooled entry). */
function pickEntry(shotBlock, metric, form) {
  let e = shotBlock[metric];
  const dec = state.currentDecoding;
  if (dec && dec !== "sampling" && e && typeof e === "object" && e.by_decoding?.[dec]) e = e.by_decoding[dec];
  return form && e && typeof e === "object" && e.by_form?.[form] ? e.by_form[form] : e;
}

/** {value, loDist, hiDist, obj} of one stored entry under the prompt
 *  aggregation `agg`; undefined when the entry has no such aggregate. */
function entryPoint(entry, agg) {
  if (entry == null) return undefined;
  if (typeof entry === "number") return { value: agg === "stdev" ? 0 : entry, obj: null };
  if (agg === "stdev") return entry.prompt_sd != null ? { value: entry.prompt_sd, obj: entry } : undefined;
  const v = entry[agg];
  if (v == null) return undefined;
  const lo = entry[agg + "_ci_lo"], hi = entry[agg + "_ci_hi"];
  return {
    value: v,
    loDist: lo != null ? Math.max(0, v - lo) : undefined,
    hiDist: hi != null ? Math.max(0, hi - v) : undefined,
    obj: entry,
  };
}

/** The log-likelihood-normalization variants the selector may choose from
 *  for `metric` in this block: all three when the selector is active and the
 *  block carries them, else just `metric` itself. The default scope ("acc")
 *  only redirects a task's main "acc" metric (prelude); multisynt widens it
 *  to every base metric (`state.llNormScope = "all"`). An explicitly chosen
 *  variant such as "acc_norm" is always taken literally. */
function llVariantsInBlock(shotBlock, bench, metric) {
  if (!state.currentAccNorm || metric !== llNormBase(metric)) return [metric];
  if ((state.llNormScope || "acc") === "acc"
      && !(metric === "acc" && state.metricsSetup[bench]?.main_metric === "acc")) {
    return [metric];
  }
  const vs = llNormVariants(metric).filter((m) => shotBlock[m] != null);
  return vs.length >= 2 && vs[0] === metric ? vs : [metric];
}

/** The variant of `metric` the selector resolves to: the chosen one, or for
 *  "max" whichever scores highest under the current prompt aggregation
 *  (within `form` when a formulation is selected). The variants of a
 *  likelihood (a probability, a per-character probability and a likelihood
 *  ratio) or of a raw log-likelihood live on different scales, so "max"
 *  keeps the plain one there. */
function chooseVariant(shotBlock, bench, metric, form) {
  const vs = llVariantsInBlock(shotBlock, bench, metric);
  if (vs.length === 1) return vs[0];
  const suffix = LL_NORM_SUFFIX[state.currentAccNorm];
  // An explicitly chosen variant the metric doesn't have falls back to the
  // plain one (the probability of the correct answer has no PMI variant).
  if (suffix !== undefined) return vs.includes(metric + suffix) ? metric + suffix : metric;
  if (!hasRandomBaseline(metric)) return metric;
  // "stdev" has no score to rank variants by; use the best prompt instead.
  const rankAgg = state.currentPromptAgg === "stdev" ? "max" : state.currentPromptAgg;
  let best = vs[0], bestV = -Infinity;
  for (const m of vs) {
    const e = pickEntry(shotBlock, m, form);
    const v = typeof e === "number" ? e : e?.[rankAgg];
    if (v != null && v > bestV) { best = m; bestV = v; }
  }
  return best;
}

/** Resolve the displayed point of one (bench, shot) block — the score under
 *  the current prompt aggregation plus its stored 95% CI distances — honoring
 *  the multisynt/prelude selectors. Returns {value, loDist, hiDist, obj} or
 *  undefined; `obj` is the stored entry the point came from (for the
 *  prompt-noise fields the signal filter reads).
 *   - state.currentAccNorm picks the log-likelihood normalization variant
 *     (see chooseVariant); null on dashboards without the selector.
 *   - state.currentDecoding ("greedy") swaps in a generative task's
 *     greedy-decoding run where it has one; "sampling" (or null) keeps the
 *     entry itself.
 *   - state.currentFormulation ("cf"/"mcf"/"hybrid") swaps in the entry's
 *     `by_form` sub-aggregate when the task has one. "max" keeps the pooled
 *     aggregate over all formulations — unless state.formulationCombine is
 *     set (multisynt): then "max"/"mean" aggregate *across* formulations the
 *     per-formulation scores obtained under the prompt aggregation. max∘max
 *     and mean∘mean (with equally many prompts per formulation) coincide
 *     with the pooled aggregate, whose precomputed CI is exact and is used;
 *     the mixed combinations take the CI of the best formulation (max) or
 *     combine the per-formulation CI distances in quadrature (mean). */
export function resolvePoint(shotBlock, bench, metric) {
  if (!shotBlock) return undefined;
  metric = metric || taskBaseMetric(bench);
  const agg = state.currentPromptAgg;
  const form = state.currentFormulation;
  const pooled = pickEntry(shotBlock, metric, null);
  const byForm = pooled && typeof pooled === "object" ? pooled.by_form : undefined;
  const forms = byForm ? Object.keys(byForm) : [];
  const pointFor = (f) => entryPoint(pickEntry(shotBlock, chooseVariant(shotBlock, bench, metric, f), f), agg);

  if (!form || !forms.length) return pointFor(null);
  if (form !== "max" && form !== "mean") return pointFor(forms.includes(form) ? form : null);
  if (!state.formulationCombine || forms.length < 2) return pointFor(null);

  const equalCounts = forms.every((f) => byForm[f].n_prompts === byForm[forms[0]].n_prompts);
  if (equalCounts && agg === form) return pointFor(null);
  const pts = forms.map(pointFor).filter(Boolean);
  if (!pts.length) return undefined;
  if (form === "max") return pts.reduce((a, b) => (b.value > a.value ? b : a));
  const k = pts.length;
  const quad = (key) => pts.every((p) => p[key] != null)
    ? Math.sqrt(pts.reduce((sum, p) => sum + p[key] * p[key], 0)) / k
    : undefined;
  return {
    value: pts.reduce((sum, p) => sum + p.value, 0) / k,
    loDist: quad("loDist"), hiDist: quad("hiDist"),
    obj: pointFor(null)?.obj ?? null,
  };
}

/** Pull raw score from a data source, respecting the current prompt aggregation.
 *  The "stdev" prompt-agg returns prompt_sd (used by multisynt). */
export function getScore(dataSource, entity, bench, shot, metric) {
  return resolvePoint(dataSource[entity]?.[bench]?.[shot], bench, metric)?.value;
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
 *    - median / first / single: sampling CI of the selected prompt (no
 *                  Bonferroni).
 *
 *  Estimand: θ_k = aggregation_{i ≤ k} μ(p_i) — over the k specific prompts
 *  evaluated, not the prompt-population supremum. */
export function getCIDistances(dataSource, entity, bench, shot, metric) {
  const pt = resolvePoint(dataSource[entity]?.[bench]?.[shot], bench, metric);
  if (!pt || pt.loDist == null || pt.hiDist == null) return undefined;
  return { loDist: pt.loDist, hiDist: pt.hiDist };
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

/** Baseline normalization: 0 = random baseline, 100 = perfect. The
 *  baseline is the task's, or the soft metric's own when `metric` is it. */
export function baselineNorm(raw, benchmark, metric) {
  const info = state.metricsSetup[benchmark];
  const base = taskRandomBaseline(benchmark, metric), max = info.max_performance;
  return max === base ? 0 : ((raw - base) / (max - base)) * 100;
}

/** Apply the current normalization to a raw score.
 *  For min-max / z-score / percentile, pass `allRaw` = all raw scores for this benchmark
 *  across the entities being compared. */
export function applyNorm(raw, benchmark, allRaw, metric) {
  if (state.currentPromptAgg === "stdev") return toDisplayScale(raw, benchmark, metric);
  if (state.currentNormalization === "none") return toDisplayScale(raw, benchmark, metric);
  if (state.currentNormalization === "baseline") {
    // The task's random baseline is defined for its main metric, not for a
    // raw-scale log-likelihood or the probability of the answer text — show
    // those unnormalized.
    if (!hasRandomBaseline(metric)) return toDisplayScale(raw, benchmark, metric);
    return baselineNorm(raw, benchmark, metric);
  }
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
    if (!hasRandomBaseline(metric)) return toDisplayScale(dist, benchmark, metric);
    const info = state.metricsSetup[benchmark];
    const range = info.max_performance - taskRandomBaseline(benchmark, metric);
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
  return state.currentTaskSelection === "__all_macro__"
      || state.currentTaskSelection === "__custom_macro__";
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

/** True for any aggregating task selection (all / category / language / eval-type / custom). */
export function isAggregateSelection(sel) {
  return sel === "__all__" || sel === "__all_macro__" || sel === "__custom__"
      || sel === "__custom_macro__"
      || sel.startsWith("__cat__") || sel.startsWith("__lang__") || sel.startsWith("__eval__");
}

/** Effective metric for an individual/group view: the currentMetric
 *  override, else the task's metric under the classification-metric
 *  selector (taskBaseMetric). */
export function getEffectiveMetric(benchmark) {
  return state.currentMetric || taskBaseMetric(benchmark);
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
