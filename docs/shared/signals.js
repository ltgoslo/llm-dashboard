// Early-signal meta-measures of a training-progress chart, after
// FineWeb2 (Penedo et al., 2025, arXiv:2506.20920, Appendix A.5.1):
// monotonicity, ordering ("ranking") consistency and non-randomness. SNR is
// left out — it needs seed-replicate runs.
//
// They are computed on the plotted series — the scores exactly as displayed
// under the current selectors, aggregation and normalization — so the chart
// and the numbers always agree:
//   series = [{ name, xs, ys, baselines }]  (one per model / trajectory)
//     xs        training tokens, ascending
//     ys        plotted score per checkpoint (null where missing)
//     baselines where a chance-level model would be plotted, per checkpoint
//               (the task's random baseline sent through the same
//                normalization and aggregation), or null

import { attachTooltip } from "./ui.js";

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

/** Spearman rank correlation (Pearson correlation of the average ranks;
 *  FineWeb2's 1 − 6Σd²/(n(n²−1)) when there are no ties). null for fewer
 *  than two points or a constant sequence. */
export function spearman(x, y) {
  if (x.length < 2) return null;
  return pearson(ranks(x), ranks(y));
}

/** Kendall's τ-a between two score vectors over the same items:
 *  (concordant − discordant) / (n choose 2); ties count for neither. */
export function kendallTauA(a, b) {
  const n = a.length;
  if (n < 2) return null;
  let c = 0, d = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = Math.sign(a[i] - a[j]) * Math.sign(b[i] - b[j]);
      if (s > 0) c++; else if (s < 0) d++;
    }
  }
  return (c - d) / (n * (n - 1) / 2);
}

const mean = (vs) => (vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null);

/** Sample standard deviation (n − 1); null for fewer than two values. */
function stdev(vs) {
  if (vs.length < 2) return null;
  const m = mean(vs);
  return Math.sqrt(vs.reduce((s, v) => s + (v - m) ** 2, 0) / (vs.length - 1));
}

/** Residual standard deviation of a least-squares line through (xs, ys) —
 *  the regression's standard error, with n − 2 degrees of freedom: the
 *  scatter around the trend rather than around the mean. null for fewer
 *  than three points or a degenerate x. */
function linearResidualSd(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  if (sxx === 0) return null;
  const slope = sxy / sxx, intercept = my - slope * mx;
  const rss = ys.reduce((s, y, i) => s + (y - (intercept + slope * xs[i])) ** 2, 0);
  return Math.sqrt(rss / (n - 2));
}

/** The last `k` plotted (x, y) points of a series, nulls dropped. */
function tailPoints(s, k) {
  const pts = [];
  s.ys.forEach((y, i) => { if (y != null) pts.push([s.xs[i], y]); });
  return pts.slice(-k);
}

/** FineWeb2 monotonicity: the Spearman correlation between training tokens
 *  and score of each model, averaged over the models. */
export function monotonicity(series) {
  const rhos = [];
  for (const s of series) {
    const xs = [], ys = [];
    s.ys.forEach((y, i) => { if (y != null) { xs.push(s.xs[i]); ys.push(y); } });
    const r = spearman(xs, ys);
    if (r != null) rhos.push(r);
  }
  return mean(rhos);
}

/** FineWeb2 ordering consistency: Kendall's τ-a between the models' ranking
 *  at consecutive checkpoints, averaged over the consecutive pairs in the
 *  second half of training. Checkpoints are aligned by position (the
 *  models' token grids differ slightly), and the first half is the first
 *  ⌊N/2⌋ positions of the longest trajectory. */
export function rankingConsistency(series) {
  const N = Math.max(0, ...series.map((s) => s.ys.length));
  const taus = [];
  for (let i = Math.floor(N / 2); i + 1 < N; i++) {
    const a = [], b = [];
    for (const s of series) {
      if (s.ys[i] != null && s.ys[i + 1] != null) { a.push(s.ys[i]); b.push(s.ys[i + 1]); }
    }
    const t = kendallTauA(a, b);
    if (t != null) taus.push(t);
  }
  return mean(taus);
}

// Non-randomness looks at the last NOISE_WINDOW checkpoints of each model.
const NOISE_WINDOW = 5;

/** FineWeb2 non-randomness: the best model's final score minus where a
 *  chance-level model would be plotted, divided by the noise level at the
 *  end of training — `noiseFn(points)` of each model's last NOISE_WINDOW
 *  plotted (x, y) points, averaged over the models. FineWeb2 takes the
 *  noise from seed-replicate runs, which the dashboards don't have.
 *  Returns { value, maxScore, baseline, maxImprovement, sigmaEnd }; value
 *  is null when no baseline is available or the noise is zero. */
function nonRandomnessWith(series, noiseFn) {
  let best = null;
  const sigmas = [];
  for (const s of series) {
    const i = s.ys.length - 1;
    if (i >= 0 && s.ys[i] != null && s.baselines?.[i] != null) {
      const d = s.ys[i] - s.baselines[i];
      if (best == null || d > best.maxImprovement) {
        best = { maxScore: s.ys[i], baseline: s.baselines[i], maxImprovement: d };
      }
    }
    const sigma = noiseFn(tailPoints(s, NOISE_WINDOW));
    if (sigma != null) sigmas.push(sigma);
  }
  const sigmaEnd = mean(sigmas);
  const value = best != null && sigmaEnd != null && sigmaEnd > 0 ? best.maxImprovement / sigmaEnd : null;
  return { value, sigmaEnd, ...(best || { maxScore: null, baseline: null, maxImprovement: null }) };
}

/** Non-randomness with the noise taken as the standard deviation of each
 *  model's last five plotted scores. Overstates the noise while a score is
 *  still rising at the end of training, since the trend counts as spread. */
export function nonRandomness(series) {
  return nonRandomnessWith(series, (pts) => stdev(pts.map((p) => p[1])));
}

/** Non-randomness with the noise taken as the residual standard deviation
 *  of a linear fit (score vs. tokens) through each model's last five plotted
 *  points — the scatter around the trend; close to (slightly above, with
 *  n − 2 degrees of freedom) the plain standard deviation when there is no
 *  trend. */
export function nonRandomnessLinearFit(series) {
  return nonRandomnessWith(series, (pts) => linearResidualSd(pts.map((p) => p[0]), pts.map((p) => p[1])));
}

/** All measures for the plotted series. */
export function computeSignals(series) {
  const nr = nonRandomness(series);
  const nrFit = nonRandomnessLinearFit(series);
  return {
    monotonicity: monotonicity(series),
    rankingConsistency: rankingConsistency(series),
    nonRandomness: nr.value,
    nonRandomnessParts: nr,
    nonRandomnessFit: nrFit.value,
    nonRandomnessFitParts: nrFit,
    nModels: series.length,
  };
}

/** "= (max − baseline) / noise" with the numbers filled in, for a
 *  non-randomness chip; "" when the measure is undefined. */
function nonRandomnessFormula(parts, digits) {
  if (parts.value == null || !isFinite(parts.value)) return "";
  const f = (v) => v.toFixed(digits);
  return `= (${f(parts.maxScore)} − ${f(parts.baseline)}) / ${f(parts.sigmaEnd)}`;
}

const SIGNAL_INFO = [
  {
    key: "monotonicity", label: "Monotonicity", digits: 3,
    body: "Spearman rank correlation between training tokens and the plotted score of each model, averaged over the models (FineWeb2, Appendix A.5.1). 1 means the score only ever goes up; FineWeb2 keeps tasks scoring ≥ 0.5.",
  },
  {
    key: "rankingConsistency", label: "Ranking consistency", digits: 3,
    body: "Kendall's τ-a between the ranking of the models at consecutive checkpoints, averaged over the checkpoint pairs in the second half of training (FineWeb2's ordering consistency). Checkpoints are aligned by position, and the first half of training is ignored as in FineWeb2. 1 means the models never swap places.",
  },
  {
    key: "nonRandomness", label: "Non-randomness", digits: 3,
    formula: (signals) => nonRandomnessFormula(signals.nonRandomnessParts, 3),
    body: "= (max − baseline) / sd: the best model's final score, minus where a chance-level model would be plotted, divided by the noise level at the end of training (FineWeb2's non-randomness; FineWeb2 keeps tasks scoring ≥ 3). FineWeb2 measures the noise as the spread between seed-replicate runs; here it is the standard deviation of each model's plotted scores over its last five checkpoints, averaged over the models — which overstates the noise while a score is still rising at the end of training.",
  },
  {
    key: "nonRandomnessFit", label: "Non-randomness (linear fit)", digits: 3,
    formula: (signals) => nonRandomnessFormula(signals.nonRandomnessFitParts, 3),
    body: "= (max − baseline) / residual sd: as non-randomness, but the noise is the residual standard deviation of a straight line fitted to each model's last five plotted points (score vs. tokens), averaged over the models — the scatter around the trend rather than around the mean, so a score that is still rising steadily is not counted as noise. With no trend it is close to the plain standard deviation (slightly larger, as one degree of freedom goes to the slope).",
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
    const formulaText = info.formula ? info.formula(signals) : "";
    if (formulaText) {
      const formula = document.createElement("span");
      formula.className = "chart-signal-formula";
      formula.textContent = formulaText;
      chip.appendChild(formula);
    }
    attachTooltip(chip, () => ({ title: info.label, body: info.body }));
    container.appendChild(chip);
  }
}
