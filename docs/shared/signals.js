// Early-signal meta-measures of a training-progress chart — monotonicity,
// ranking consistency and non-randomness — computed exactly as in the
// multisynt-eval-conditions pipeline (scripts/eval-conditions/metrics.py:
// compute_monotonicity, compute_ranking_consistency, compute_non_random),
// which follows FineWeb2 (Penedo et al., 2025, arXiv:2506.20920, App. A.5.1).
// SNR is left out there as well (it needs seed-replicate runs).
//
// They are computed on the plotted series — the scores exactly as displayed
// under the current selectors, aggregation and rescaling — so the chart and
// the numbers always agree:
//   series   = [{ name, xs, ys }]  one per model (reference lines excluded)
//     xs     training tokens, ascending — the model's own checkpoint grid
//     ys     plotted score per checkpoint (null where the model has none)
//   baseline where a chance-level model would be plotted: each task's chance
//            level sent through the same rescaling and aggregated like the
//            scores over the tasks that have one (0 when none has)
//
// A checkpoint without a score is not a row of the pipeline's series, so it
// is not a checkpoint here either: the training-window shares, a model's
// final score and the noise window all look at scored checkpoints only. The
// position in `xs` stands in for the pipeline's ckpt_index, which aligns the
// models by ordinal checkpoint position because their token grids differ
// slightly (step-based vs. 2B … 90B, main).

import { attachTooltip } from "./ui.js";

// Training windows, as fractions of each model's own token budget.
const MONOTONICITY_WINDOW = [0.0, 1.0];
const RANKING_CONSISTENCY_WINDOW = [0.5, 1.0];
// Non-randomness' noise: each model's last 5 scored checkpoints, as in FineWeb2.
const NON_RANDOM_LAST_STEPS = 5;

/** Average ranks (1-based, ties share the mean rank). */
function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k][1]] = r;
    i = j + 1;
  }
  return out;
}

function pearson(x, y) {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Spearman rank correlation (Pearson correlation of the average ranks, as
 *  pandas' corr(method="spearman")). null for fewer than two points or a
 *  constant sequence. */
export function spearman(x, y) {
  if (x.length < 2) return null;
  return pearson(ranks(x), ranks(y));
}

/** Kendall's τ-b between two score vectors over the same items, as scipy's
 *  kendalltau: (concordant − discordant) / √((n₀ − t_a)(n₀ − t_b)), where
 *  n₀ counts the pairs not tied in both and t_a / t_b the pairs tied in a
 *  only / b only. null where scipy gives NaN (fewer than two items, or
 *  every pair tied in one of the vectors). */
export function kendallTauB(a, b) {
  const n = a.length;
  if (n < 2) return null;
  let c = 0, d = 0, tiesA = 0, tiesB = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sa = Math.sign(a[i] - a[j]), sb = Math.sign(b[i] - b[j]);
      if (sa === 0 && sb === 0) continue;
      if (sa === 0) tiesA++;
      else if (sb === 0) tiesB++;
      else if (sa === sb) c++;
      else d++;
    }
  }
  const denom = Math.sqrt((c + d + tiesA) * (c + d + tiesB));
  return denom > 0 ? (c - d) / denom : null;
}

const mean = (vs) => (vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null);

/** Sample standard deviation (ddof = 1); null for fewer than two values. */
function stdev(vs) {
  if (vs.length < 2) return null;
  const m = mean(vs);
  return Math.sqrt(vs.reduce((s, v) => s + (v - m) ** 2, 0) / (vs.length - 1));
}

/** Positions of the scored checkpoints of a series. */
function scoredIdx(s) {
  const idx = [];
  s.ys.forEach((y, i) => { if (y != null && isFinite(y)) idx.push(i); });
  return idx;
}

/** Scored checkpoints whose share of the model's own token budget (x over
 *  its largest scored x) lies in [lo, hi] — the pipeline's _window. */
function windowIdx(s, [lo, hi]) {
  const idx = scoredIdx(s);
  const budget = Math.max(...idx.map((i) => s.xs[i]));
  return idx.filter((i) => {
    const share = s.xs[i] / budget;
    return share >= lo - 1e-9 && share <= hi + 1e-9;
  });
}

/** Monotonicity: Spearman(training tokens, score) of each model over all its
 *  checkpoints, averaged over the models. A model with fewer than two
 *  checkpoints or a constant score is left out; null when none remains. */
export function monotonicity(series) {
  const rhos = [];
  for (const s of series) {
    const idx = windowIdx(s, MONOTONICITY_WINDOW);
    const ys = idx.map((i) => s.ys[i]);
    if (idx.length < 2 || new Set(ys).size < 2) continue;
    const r = spearman(idx.map((i) => s.xs[i]), ys);
    if (r != null && isFinite(r)) rhos.push(r);
  }
  return mean(rhos);
}

/** Ranking consistency: Kendall's τ-b between the models' ranking at
 *  adjacent checkpoint positions, averaged over the adjacent pairs in the
 *  later half of training — the scored checkpoints at ≥ 50 % of each
 *  model's own token budget. A pair needs two models present at both
 *  positions; a τ that is undefined (every pair tied) counts as 0, as in
 *  the pipeline. null without any pair. */
export function rankingConsistency(series) {
  const windows = series.map((s) => new Set(windowIdx(s, RANKING_CONSISTENCY_WINDOW)));
  const idxs = [...new Set(windows.flatMap((w) => [...w]))].sort((a, b) => a - b);
  const taus = [];
  for (let k = 0; k + 1 < idxs.length; k++) {
    const a = [], b = [];
    series.forEach((s, m) => {
      if (windows[m].has(idxs[k]) && windows[m].has(idxs[k + 1])) {
        a.push(s.ys[idxs[k]]);
        b.push(s.ys[idxs[k + 1]]);
      }
    });
    if (a.length < 2) continue;
    const tau = kendallTauB(a, b);
    taus.push(tau == null ? 0 : tau);
  }
  return mean(taus);
}

/** Non-randomness: the best model's final plotted score minus `baseline`
 *  (where a chance-level model would be plotted), divided by the noise at
 *  the end of training — the standard deviation of each model's scores over
 *  its last 5 scored checkpoints, averaged over the models that have at
 *  least two. null when no model has a final score or such a noise
 *  estimate, or when the scores are constant up to floating-point noise. */
export function nonRandomness(series, baseline) {
  const finals = [], sds = [];
  for (const s of series) {
    const idx = scoredIdx(s);
    if (!idx.length) continue;
    finals.push(s.ys[idx[idx.length - 1]]);
    const tail = idx.slice(-NON_RANDOM_LAST_STEPS).map((i) => s.ys[i]);
    if (tail.length >= 2) sds.push(stdev(tail));
  }
  if (!finals.length || !sds.length) return null;
  const best = Math.max(...finals);
  const noise = mean(sds);
  if (noise <= 1e-12 * (Math.abs(best) + 1)) return null;
  return (best - (baseline ?? 0)) / noise;
}

/** All measures for the plotted series. */
export function computeSignals(series, baseline) {
  return {
    monotonicity: monotonicity(series),
    rankingConsistency: rankingConsistency(series),
    nonRandomness: nonRandomness(series, baseline),
    nModels: series.length,
  };
}

const SIGNAL_INFO = [
  {
    key: "monotonicity", label: "Monotonicity", digits: 3,
    body: "Spearman rank correlation between training tokens and the plotted score of each model over all its checkpoints, averaged over the models (FineWeb2, Appendix A.5.1; a model with a constant score is left out). 1 means the score only ever goes up; FineWeb2 keeps tasks scoring ≥ 0.5.",
  },
  {
    key: "rankingConsistency", label: "Ranking consistency", digits: 3,
    body: "Kendall's τ (τ-b) between the rankings of the models at adjacent checkpoints in the later half of training — the checkpoints at ≥ 50 % of each model's own token budget, aligned by checkpoint position — averaged over the adjacent pairs (FineWeb2's ordering consistency). 1 means the models never swap places.",
  },
  {
    key: "nonRandomness", label: "Non-randomness", digits: 3,
    body: "The best model's final plotted score minus where a chance-level model would be plotted (each task's chance level sent through the same rescaling and aggregated like the scores, over the tasks that have one), divided by the noise at the end of training: the standard deviation of each model's plotted scores over its last five checkpoints, averaged over the models (FineWeb2's non-randomness, with the late-training spread standing in for its seed-replicate noise; FineWeb2 keeps tasks scoring ≥ 3).",
  },
];

/** Render the measures as "Label value" chips with explanatory hover
 *  tooltips into `container`. */
export function renderSignals(container, signals) {
  if (!container) return;
  container.innerHTML = "";
  for (const info of SIGNAL_INFO) {
    const v = signals[info.key];
    const chip = document.createElement("span");
    chip.className = "chart-signal";
    const label = document.createElement("span");
    label.className = "chart-signal-label";
    label.textContent = info.label;
    const value = document.createElement("span");
    value.className = "chart-signal-value";
    value.textContent = v == null || !isFinite(v) ? "–" : v.toFixed(info.digits);
    chip.appendChild(label);
    chip.appendChild(value);
    attachTooltip(chip, () => ({ title: info.label, body: info.body }));
    container.appendChild(chip);
  }
}
