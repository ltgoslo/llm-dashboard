#!/usr/bin/env python3
"""Standalone comparison: bootstrap vs current CI methods on selected cases.

For each (model, benchmark, shot) we load per-prompt (μ̂_i, σ_i) from the raw
lm-eval-harness JSON and compute four versions of the displayed-score CI when
the user has the default "max" aggregation selected:

  1. current dashboard            — value=max(prompts), CI=Welch combination
                                    of max_stderr + sd(prompts)/√k. Conflates
                                    SE-of-the-mean with the SE of the max.
  2. sampling-only                — value=max(prompts), CI=±z·max_stderr. Drops
                                    the prompt term entirely; correct CI for
                                    one specific prompt's mean.
  3. parametric bootstrap of max  — value=max(prompts), CI=quantiles of the
                                    sampling distribution of max_i μ̃_i where
                                    μ̃_i ~ N(μ̂_i, σ_i²) independently.
                                    Estimand: max over the k specific prompts
                                    we evaluated (not the prompt population).
  4. bootstrap point + CI         — point estimate = median of the bootstrap
                                    (winner's-curse-corrected), CI = quantiles.

The bootstrap assumes per-prompt estimates are independent. They aren't
strictly — all prompts evaluate the same items — but without per-item data we
can't estimate the correlation. The independence assumption is conservative
for the winner's-curse direction (overstates the chance that a different
prompt wins).
"""
import glob
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import yaml

REPO = Path(__file__).parent
DATA_ROOT = REPO / "data" / "noreval" / "results"
METRICS_YAML = REPO / "metrics_setup.yaml"

Z95 = 1.959963984540054
PROPORTION_METRICS = {"acc", "acc_norm", "em_first", "em"}


def load_metrics_setup():
    with open(METRICS_YAML) as f:
        return yaml.safe_load(f)


def wilson_se(v, n, scale):
    """Wilson 95% half-width / z, as a 1σ-equivalent SE."""
    if not (n and n > 1):
        return None
    if scale == "percent":
        p = max(0.0, min(1.0, v / 100.0))
        s = 100.0
    else:
        p = max(0.0, min(1.0, v))
        s = 1.0
    return s * math.sqrt(p * (1 - p) / n + Z95**2 / (4 * n * n)) / (1 + Z95**2 / n)


def tinv95_hill(df):
    """Hill (1970) 4-term series for the 0.975 t-quantile."""
    if df >= 30:
        return Z95
    d = max(df, 2.0)
    z = Z95
    z3, z5, z7, z9 = z**3, z**5, z**7, z**9
    g1 = (z3 + z) / 4
    g2 = (5 * z5 + 16 * z3 + 3 * z) / 96
    g3 = (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / 384
    g4 = (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / 92160
    return z + g1 / d + g2 / d**2 + g3 / d**3 + g4 / d**4


def load_per_prompt(model, bench, shot, metrics_setup):
    """Return list of {prompt, v, se} dicts and (main_metric, scale)."""
    cfg = metrics_setup[bench]
    main_metric = cfg["main_metric"]
    scale = cfg.get("metric_scale", "unit")
    is_proportion = main_metric in PROPORTION_METRICS

    pattern = str(DATA_ROOT / model / bench / f"{shot}-shot" / "*" / "results_*.json")
    files = sorted(glob.glob(pattern))
    if not files:
        return None, main_metric, scale
    rj = json.load(open(files[-1]))

    items = []
    for tk, tr in rj.get("results", {}).items():
        if not tk.startswith(f"{bench}_p"):
            continue
        v = tr.get(f"{main_metric},none")
        if not isinstance(v, (int, float)) or not math.isfinite(v):
            continue
        harness_se = tr.get(f"{main_metric}_stderr,none")
        ns = rj.get("n-samples", {}).get(tk, {}) or {}
        n = ns.get("effective") or ns.get("original")
        if is_proportion:
            se = wilson_se(v, n, scale)
        elif isinstance(harness_se, (int, float)) and math.isfinite(harness_se):
            se = harness_se
        else:
            se = wilson_se(v, n, scale)
        items.append({"prompt": tk, "v": v, "se": se if se is not None else 0.0, "n": n})
    items.sort(key=lambda x: x["prompt"])
    return items, main_metric, scale


def method_current_welch(items):
    """value=max, CI = Welch on (max_stderr, sd(prompts)/√k). What the dashboard
    shows today for the default `max` aggregation. Symmetric."""
    vals = np.array([x["v"] for x in items])
    ses = np.array([x["se"] for x in items])
    k = len(vals)
    i_max = int(np.argmax(vals))
    point = float(vals[i_max])
    SE_s = float(ses[i_max])
    if k < 2:
        return point, point - Z95 * SE_s, point + Z95 * SE_s
    SD_p = float(vals.std(ddof=1))
    SE_p = SD_p / math.sqrt(k)
    Vs, Vp = SE_s**2, SE_p**2
    denom = (Vp * Vp / (k - 1)) if Vp > 0 else 0
    df_eff = (Vs + Vp) ** 2 / denom if denom > 0 else float("inf")
    half = tinv95_hill(df_eff) * math.sqrt(Vs + Vp)
    return point, point - half, point + half


def method_sampling_only(items):
    """value=max, CI=±z·max_stderr. Correct CI for the single best prompt's
    mean; ignores winner's-curse and prompt-template uncertainty."""
    vals = np.array([x["v"] for x in items])
    ses = np.array([x["se"] for x in items])
    i_max = int(np.argmax(vals))
    point = float(vals[i_max])
    SE_s = float(ses[i_max])
    return point, point - Z95 * SE_s, point + Z95 * SE_s


def method_bootstrap_max(items, n_boot=20000, alpha=0.05, seed=42):
    """Parametric bootstrap of max-over-k. NOT a valid 95% frequentist CI for
    θ_k = max μ_i — coverage drops to ~31% under tied true means (the bootstrap
    distribution is centered on the empirical max which is biased up by the
    winner's curse). Kept for comparison and as an approximate Bayesian
    credible interval under an independent-normal posterior."""
    rng = np.random.default_rng(seed)
    vals = np.array([x["v"] for x in items])
    ses = np.array([x["se"] for x in items])
    samples = rng.normal(vals, ses, size=(n_boot, len(vals)))
    maxes = samples.max(axis=1)
    lo = float(np.quantile(maxes, alpha / 2))
    hi = float(np.quantile(maxes, 1 - alpha / 2))
    return float(vals.max()), lo, hi, float(np.median(maxes))


def method_bonferroni_max(items, alpha=0.05):
    """Frequentist 95% CI for θ_k = max μ_i via simultaneous one-sided bounds.

      L = max_i ℓ(c_i, n_i, α/(2k))      ← Bonferroni-corrected lower
      U = max_i u(c_i, n_i, α/2)         ← no correction needed for upper

    For proportion-like metrics we use Clopper–Pearson (exact binomial); for
    others we use the normal approximation with the harness bootstrap SE. The
    asymmetry is intentional and gives valid coverage by union bound on the
    lower side and by the i*-argument on the upper side (P(U_max < μ_{i*}) ≤
    P(U_{i*} < μ_{i*}) ≤ α/2)."""
    from scipy.stats import beta, norm

    vals = np.array([x["v"] for x in items])
    ses = np.array([x["se"] for x in items])
    ns = np.array([x["n"] or 0 for x in items], dtype=int)
    k = len(vals)
    alpha_L = alpha / 2
    alpha_U = alpha / 2

    # Detect proportion-like by SE pattern: if integer-valued p·n ≈ c, treat as
    # binomial. For our use, we plumb is_proportion in via the caller — but to
    # keep this self-contained, we infer from n being available.
    lo_per_prompt = np.zeros(k)
    hi_per_prompt = np.zeros(k)
    for i in range(k):
        v_i, n_i = float(vals[i]), int(ns[i])
        if n_i > 0 and 0 <= v_i <= 1:
            # Clopper–Pearson exact binomial bounds
            c = round(v_i * n_i)
            lo_per_prompt[i] = 0.0 if c == 0 else beta.ppf(alpha_L / k, c, n_i - c + 1)
            hi_per_prompt[i] = 1.0 if c == n_i else beta.ppf(1 - alpha_U, c + 1, n_i - c)
        else:
            # Normal approximation with harness SE (BLEU/ROUGE/etc., already in
            # display scale — could be percent)
            z_lo = norm.ppf(1 - alpha_L / k)
            z_hi = norm.ppf(1 - alpha_U)
            lo_per_prompt[i] = v_i - z_lo * ses[i]
            hi_per_prompt[i] = v_i + z_hi * ses[i]

    return float(vals.max()), float(lo_per_prompt.max()), float(hi_per_prompt.max())


def fmt(v):
    return f"{v:8.4f}"


def run_case(model, bench, shot, label, metrics_setup, ceiling):
    items, mm, scale = load_per_prompt(model, bench, shot, metrics_setup)
    if not items:
        print(f"\n=== {label} ===\n  (no data)")
        return

    print(f"\n=== {label} ===")
    print(f"  {model} / {bench} / {shot}-shot   metric={mm}  scale={scale}")
    print(f"  per-prompt:")
    for x in items:
        print(f"    {x['prompt']:25} v={x['v']:8.4f}  SE={x['se']:8.4f}  n={x['n']}")

    print(f"\n  {'method':35} {'value':>9} {'lo':>9} {'hi':>9} {'width':>8}  breach?")

    methods = [
        ("1. current dashboard (max+Welch)", method_current_welch(items)),
        ("2. sampling-only (z·max_stderr)",  method_sampling_only(items)),
    ]
    boot = method_bootstrap_max(items)
    methods.append(("3. percentile bootstrap (NOT a 95% CI; ~31% coverage)", boot[:3]))
    methods.append(("4. Bonferroni union bound (valid 95% CI)", method_bonferroni_max(items)))

    for label_m, (pt, lo, hi) in methods:
        out = "  "
        if hi > ceiling or lo < 0:
            excess = max(hi - ceiling, -lo)
            out = f"  ← out of [0,{ceiling}] by {excess:.3f}"
        print(f"  {label_m:50} {fmt(pt)} {fmt(lo)} {fmt(hi)} {fmt(hi-lo):>8}{out}")


CASES = [
    # (model, bench, shot, label)
    ("norolmo-13b-stage2", "ask_gec", "5",
     "TIGHT  — prompts cluster (errant_f05 ≈ 0.50)"),
    ("normistral-11b-warm", "noridiom_nob", "0",
     "BIMODAL — 2 broken prompts at 0 + 3 working prompts at 0.5–0.6"),
    ("norolmo-13b-stage2", "noridiom_nno", "5",
     "CLOSE AT TOP — two prompts tied at 0.9438 (winner's curse)"),
    ("norolmo-13b-stage2", "tatoeba_eng_nob", "0",
     "BLEU DISAGREE — 4 translation prompts span 22 BLEU points"),
    ("norolmo-13b-stage2", "norsumm_nob", "0",
     "ROUGE — 6 summarization prompts, one degenerate (≈2)"),
]


def main():
    ms = load_metrics_setup()
    for model, bench, shot, label in CASES:
        cfg = ms[bench]
        ceil_ = 100.0 if cfg.get("metric_scale") == "percent" else 1.0
        run_case(model, bench, shot, label, ms, ceil_)


if __name__ == "__main__":
    main()
