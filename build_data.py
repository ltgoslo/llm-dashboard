#!/usr/bin/env python3
"""Build the four data.json files served by the dashboards.

Reads benchmark/model configs from YAML files at the repo root and result
JSONs from data/<dashboard>/{results,progress}/, and writes one consolidated
data.json into each docs/<dashboard>/.

Outputs:
    docs/noreval/data.json        — base-model NorEval comparison
    docs/noreval-gen/data.json    — instruction-tuned NorEval comparison
    docs/norolmo/data.json        — NorOLMo progression + ablations
    docs/multisynt/data.json      — multilingual progression

NorEval-side code (noreval, noreval-gen, norolmo) shares prompt-aggregation
and metric-extraction logic in `noreval_lib`. MultiSynt is in its own block
because its directory layout and aggregator quirks are non-trivially
different (per-partition scores via p0/p1/p2 dirs, MultiBLiMP custom
aggregation, multiple shot dirs combined into one model, etc.).
"""

import glob
import json
import math
import os
import re
import statistics
from pathlib import Path

import yaml
from scipy.stats import beta as _beta_dist, norm as _norm_dist

BASE_DIR = Path(__file__).parent

# Input paths
METRICS_SETUP_YAML = BASE_DIR / "metrics_setup.yaml"
MODELS_SETUP_YAML = BASE_DIR / "models_setup.yaml"
INSTRUCT_MODELS_SETUP_YAML = BASE_DIR / "models_instruct_setup.yaml"
MULTISYNT_TASKS_YAML = BASE_DIR / "multisynt_tasks.yaml"
MULTISYNT_MODELS_YAML = BASE_DIR / "multisynt_models.yaml"

NOREVAL_RESULTS = BASE_DIR / "data" / "noreval" / "results"
NOREVAL_GEN_RESULTS = BASE_DIR / "data" / "noreval-gen" / "results"
NOROLMO_PROGRESS = BASE_DIR / "data" / "norolmo" / "progress"
MULTISYNT_RESULTS = BASE_DIR / "data" / "multisynt" / "results"

# Output paths
NOREVAL_OUT = BASE_DIR / "docs" / "noreval" / "data.json"
NOREVAL_GEN_OUT = BASE_DIR / "docs" / "noreval-gen" / "data.json"
NOROLMO_OUT = BASE_DIR / "docs" / "norolmo" / "data.json"
MULTISYNT_OUT = BASE_DIR / "docs" / "multisynt" / "data.json"

SHOT_SETTINGS = ["0", "1", "5"]
SHOT_DIRS = {"0": "0-shot", "1": "1-shot", "5": "5-shot"}

# Metrics excluded globally from the metric selector.
# `bypass` is the lm-eval placeholder used when a task ran without
# computing a metric — the real value is patched in later.
EXCLUDED_METRICS = {"bleu_diff", "rouge1_diff", "rouge2_diff", "rougeL_diff", "bypass"}

# Per-benchmark metric exclusions. ask_gec's `exact_match` is the lm-eval
# placeholder; the real metric is ERRANT F0.5 (`errant`/`errant_f05`).
EXCLUDED_METRICS_PER_BENCHMARK = {
    "ask_gec": {"exact_match"},
    "noreval_multiblimp": {"acc_norm"},
}

# NorOLMo training: 8M tokens per step (8192 × 1024).
NOROLMO_TOKENS_PER_STEP = 8192 * 1024

# NorOLMo ablation display names and colors.
ABLATION_NAME_MAP = {
    "stage2-ablation-no-len-ext-stage1-data": "pretraining data, 1→0 decay",
    "stage2-no-len-ext-stage1-data-half-decay": "pretraining data, 1→½ decay",
    "stage2-no-len-ext-stage2-data-half-decay": "midtraining data, 1→½ decay",
    "stage2-newmix": "updated data mixture, 1→½ decay",
    "stage3-newmix": "updated data mixture, ½→0 decay",
    "stage3-no-rope-scaling": "midtraining data, 1→0 decay",
    "stage3-rope-scaling": "midtraining data, RoPE scaling, 1→0 decay",
    "stage3-mainline": "midtraining data, RoPE scaling, ½→0 decay",
}
# Note: the norolmo frontend currently uses its own RUN_COLOR map
# (docs/norolmo/app.js) and ignores these colors.
ABLATION_COLOR_MAP = {
    "stage2-ablation-no-len-ext-stage1-data": "#e63946",        # red
    "stage2-no-len-ext-stage1-data-half-decay": "#c70eff",      # magenta
    "stage2-no-len-ext-stage2-data-half-decay": "#2ca02c",      # green
    "stage2-newmix": "#9333ea",                                 # violet
    "stage3-newmix": "#9333ea",                                 # violet
    "stage3-no-rope-scaling": "#ff7f0e",                        # orange
    "stage3-rope-scaling": "#d62728",                           # dark red
    "stage3-mainline": "#5acc2d",                               # light green
}

# ─────────────────────────────────────────────────────────────
# Shared helpers (used by all dashboards)
# ─────────────────────────────────────────────────────────────


def load_yaml(path):
    with open(path) as f:
        return yaml.safe_load(f)


def find_latest_results_json(directory):
    """Find the newest results_*.json or results.json under `directory`."""
    simple = os.path.join(directory, "results.json")
    if os.path.isfile(simple):
        return simple
    pattern = os.path.join(directory, "**", "results_*.json")
    files = glob.glob(pattern, recursive=True)
    if not files:
        return None
    files.sort(key=lambda f: os.path.basename(f))
    return files[-1]


# Wilson score interval (z=1.96 ⇒ 95%). We store half-width / Z as a
# 1σ-equivalent SE so the existing quadrature combination (sampling ⊕ prompt)
# and cross-benchmark propagation in the frontend stay unchanged; the
# frontend multiplies by Z once at display time to produce the CI half-width.
WILSON_Z = 1.959963984540054
WILSON_Z2 = WILSON_Z * WILSON_Z

# Metric names treated as Bernoulli proportions for Wilson CI purposes.
# Wilson is computed from (p, n) directly, overriding any harness-supplied
# bootstrap SE (which is essentially Wald and breaks down near p=0 / p=1).
PROPORTION_METRIC_NAMES = {"acc", "acc_norm", "em_first", "em"}


def wilson_se(value, n_samples, metric_scale):
    """Wilson 95% CI half-width / Z, as a 1σ-equivalent SE for a [0,1] proportion.

    Defined and finite at p=0 and p=1 (Wald collapses there). Returns None
    when n is unknown or ≤ 1. The output is in the same display scale as
    `value` (i.e. percent stays percent)."""
    if not (n_samples and n_samples > 1):
        return None
    if metric_scale == "percent":
        p = max(0.0, min(1.0, value / 100.0))
        scale = 100.0
    else:
        p = max(0.0, min(1.0, value))
        scale = 1.0
    half_over_z = (
        math.sqrt(p * (1 - p) / n_samples + WILSON_Z2 / (4 * n_samples * n_samples))
        / (1 + WILSON_Z2 / n_samples)
    )
    return half_over_z * scale


def resolve_se(metric_name, value, harness_se, n_samples, metric_scale):
    """Choose an SE for a (metric, value, n) triple.

    Proportion-like metrics → Wilson, regardless of what the harness supplied.
    Other metrics → trust the harness bootstrap SE when present.
    Otherwise → Wilson approximation as a fallback (sloppy for non-proportions
    like F1 / ERRANT-F0.5, but the only thing we can produce without per-item
    data; see the dashboard 'About' section)."""
    base = metric_name.split(": ", 1)[0]  # strip subtask suffix if any
    if base in PROPORTION_METRIC_NAMES:
        wse = wilson_se(value, n_samples, metric_scale)
        if wse is not None:
            return wse
    if isinstance(harness_se, (int, float)) and math.isfinite(harness_se):
        return harness_se
    return wilson_se(value, n_samples, metric_scale)


# ─────────────────────────────────────────────────────────────
# Confidence intervals for prompt aggregations
# ─────────────────────────────────────────────────────────────
#
# Estimand: θ_k = aggregation_{i ≤ k} μ(p_i) — the chosen statistic over the
# true performances of the k specific prompts we evaluated. We do NOT try to
# extrapolate to a population of "all reasonable prompts" (untestable from
# k = 5 without parametric assumptions).
#
# For `max` we use Bonferroni-corrected one-sided bounds:
#     L = max_i ℓ_i(α/(2k)),    U = max_i u_i(α/2)
# Per-prompt bounds ℓ_i, u_i use Clopper–Pearson exact binomial for proportion-
# like metrics and the normal approximation with the harness/Wilson SE
# otherwise. By union bound, P(L > θ_k) ≤ α/2, and the i*-argument gives
# P(U < θ_k) ≤ α/2 with no correction on the upper side. CIs are intentionally
# asymmetric — wider below the point estimate than above.
#
# For `min` the structure is mirrored (Bonferroni on upper, plain on lower).
# For `mean` we use the standard Welch combination of sampling and between-
# prompt variance — that's the right CI for the mean estimand. For `median`
# / `first` we use the sampling CI of the selected prompt directly; there is
# no Bonferroni correction because no selection from k is happening.
#
# The independence-across-prompts assumption is conservative: prompts share
# items, so per-prompt estimates are positively correlated, which would make
# the true joint distribution tighter than the Bonferroni bound assumes.

ALPHA = 0.05  # 95% CI
Z_LO_BONF_K = {}    # cache: k -> z_{1 - α/(2k)}
Z_HI = _norm_dist.ppf(1 - ALPHA / 2)


def _z_lo_bonferroni(k):
    if k not in Z_LO_BONF_K:
        Z_LO_BONF_K[k] = _norm_dist.ppf(1 - ALPHA / (2 * k))
    return Z_LO_BONF_K[k]


def _clopper_pearson(c, n, alpha_lo, alpha_hi):
    """Exact binomial CI for a Bernoulli proportion. c successes out of n."""
    lo = 0.0 if c == 0 else float(_beta_dist.ppf(alpha_lo, c, n - c + 1))
    hi = 1.0 if c == n else float(_beta_dist.ppf(1 - alpha_hi, c + 1, n - c))
    return lo, hi


def _per_prompt_ci(value, se, n, scale, is_proportion, alpha_lo, alpha_hi):
    """Per-prompt (lo, hi) for one prompt's μ̂.

    Uses Clopper–Pearson when (proportion-like + n known), otherwise normal
    approximation with whatever sampling SE we have. Returns values on the
    original display scale (so percent stays percent)."""
    if is_proportion and n and n >= 1:
        ceil_ = 100.0 if scale == "percent" else 1.0
        p = max(0.0, min(1.0, value / ceil_))
        c = round(p * n)
        lo_unit, hi_unit = _clopper_pearson(c, n, alpha_lo, alpha_hi)
        return lo_unit * ceil_, hi_unit * ceil_
    z_lo = _norm_dist.ppf(1 - alpha_lo)
    z_hi = _norm_dist.ppf(1 - alpha_hi)
    se_use = se if (isinstance(se, (int, float)) and math.isfinite(se)) else 0.0
    return value - z_lo * se_use, value + z_hi * se_use


def bonferroni_max_ci(triples, scale, is_proportion):
    """95% CI for max_{i≤k} μ_i via Bonferroni on the lower bound only.

    triples: list of (value, se, n). Returns (lo, hi)."""
    k = len(triples)
    if k == 0:
        return None, None
    alpha_lo = ALPHA / (2 * k)  # union bound across k prompts
    alpha_hi = ALPHA / 2         # no correction needed on upper
    los, his = [], []
    for v, se, n in triples:
        lo, hi = _per_prompt_ci(v, se, n, scale, is_proportion, alpha_lo, alpha_hi)
        los.append(lo); his.append(hi)
    return max(los), max(his)


def bonferroni_min_ci(triples, scale, is_proportion):
    """95% CI for min_{i≤k} μ_i — mirror of max."""
    k = len(triples)
    if k == 0:
        return None, None
    alpha_lo = ALPHA / 2
    alpha_hi = ALPHA / (2 * k)
    los, his = [], []
    for v, se, n in triples:
        lo, hi = _per_prompt_ci(v, se, n, scale, is_proportion, alpha_lo, alpha_hi)
        los.append(lo); his.append(hi)
    return min(los), min(his)


def sampling_ci(value, se, n, scale, is_proportion):
    """Plain 95% CI for one prompt's μ̂ (median / first / single-prompt cases).

    No Bonferroni — we're not selecting from k."""
    return _per_prompt_ci(value, se, n, scale, is_proportion, ALPHA / 2, ALPHA / 2)


def welch_mean_ci(triples, scale, is_proportion):
    """95% CI for the mean over the k prompts, via the Welch–Satterthwaite
    combination of sampling SE and between-prompt SE. Symmetric — this is the
    only aggregation where the prompt-template SE is conceptually right."""
    k = len(triples)
    if k == 0:
        return None, None
    values = [v for v, _, _ in triples]
    ses = [se if isinstance(se, (int, float)) else 0.0 for _, se, _ in triples]
    mean_v = sum(values) / k
    # SE of the mean from per-prompt sampling
    se_sampling_sq = sum(s * s for s in ses) / (k * k)
    if k >= 2:
        sd_prompts = math.sqrt(sum((v - mean_v) ** 2 for v in values) / (k - 1))
        se_prompt = sd_prompts / math.sqrt(k)
    else:
        se_prompt = 0.0
    Vs = se_sampling_sq
    Vp = se_prompt * se_prompt
    df_p = max(k - 1, 1)
    denom = (Vp * Vp / df_p) if Vp > 0 else 0.0
    df_eff = (Vs + Vp) ** 2 / denom if denom > 0 else float("inf")
    # Hill 1970 4-term inverse-t for 0.975 quantile
    if df_eff >= 30:
        t = Z_HI
    else:
        d = max(df_eff, 2.0)
        z = Z_HI
        z3, z5, z7, z9 = z ** 3, z ** 5, z ** 7, z ** 9
        g1 = (z3 + z) / 4
        g2 = (5 * z5 + 16 * z3 + 3 * z) / 96
        g3 = (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / 384
        g4 = (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / 92160
        t = z + g1 / d + g2 / d ** 2 + g3 / d ** 3 + g4 / d ** 4
    half = t * math.sqrt(Vs + Vp)
    return mean_v - half, mean_v + half


def aggregate_prompt_variants(metric_values, metric_scale="unit"):
    """Reduce per-prompt (value, stderr, n) triples to a prompt-aggregation dict.

    Returns {metric_name: entry} where each entry has:
      max / mean / median / min / first        ← point estimates
      <agg>_ci_lo / <agg>_ci_hi                ← 95% asymmetric CIs
      max_prompt_idx, n_prompts, prompt_sd, prompt_mad
    """
    if not metric_values:
        return None
    out = {}
    for metric_name, triples in metric_values.items():
        # Normalize triples: accept legacy (v, se) too, default n = None.
        norm = []
        for t in triples:
            if len(t) == 3:
                norm.append((t[0], t[1], t[2]))
            else:
                norm.append((t[0], t[1], None))
        triples = norm

        base = metric_name.split(": ", 1)[0]
        is_proportion = base in PROPORTION_METRIC_NAMES
        values = [v for v, _, _ in triples]

        entry = {
            "max": round(max(values), 6),
            "mean": round(statistics.mean(values), 6),
            "median": round(statistics.median(values), 6),
            "min": round(min(values), 6),
            "first": round(values[0], 6),
        }
        max_idx = values.index(max(values))
        entry["max_prompt_idx"] = max_idx

        # Confidence intervals — see helpers above for the methodology.
        lo, hi = bonferroni_max_ci(triples, metric_scale, is_proportion)
        entry["max_ci_lo"], entry["max_ci_hi"] = round(lo, 6), round(hi, 6)
        lo, hi = bonferroni_min_ci(triples, metric_scale, is_proportion)
        entry["min_ci_lo"], entry["min_ci_hi"] = round(lo, 6), round(hi, 6)
        lo, hi = welch_mean_ci(triples, metric_scale, is_proportion)
        entry["mean_ci_lo"], entry["mean_ci_hi"] = round(lo, 6), round(hi, 6)

        # Median / first: sampling CI of the selected prompt, no Bonferroni.
        med = statistics.median(values)
        closest_idx = min(range(len(values)), key=lambda i: abs(values[i] - med))
        v_m, se_m, n_m = triples[closest_idx]
        lo, hi = sampling_ci(v_m, se_m, n_m, metric_scale, is_proportion)
        entry["median_ci_lo"], entry["median_ci_hi"] = round(lo, 6), round(hi, 6)
        v_f, se_f, n_f = triples[0]
        lo, hi = sampling_ci(v_f, se_f, n_f, metric_scale, is_proportion)
        entry["first_ci_lo"], entry["first_ci_hi"] = round(lo, 6), round(hi, 6)

        entry["n_prompts"] = len(values)
        if len(values) >= 2:
            entry["prompt_sd"] = round(statistics.stdev(values), 6)
            med_val = statistics.median(values)
            entry["prompt_mad"] = round(
                statistics.median([abs(v - med_val) for v in values]), 6
            )
        else:
            entry["prompt_sd"] = 0.0
            entry["prompt_mad"] = 0.0
        out[metric_name] = entry
    return out


# ─────────────────────────────────────────────────────────────
# NorEval-side (noreval, noreval-gen, norolmo) extraction
# ─────────────────────────────────────────────────────────────


def get_n_samples(n_samples_dict, task_key):
    ns_entry = n_samples_dict.get(task_key, {})
    return ns_entry.get("effective") or ns_entry.get("original")


def collect_prompt_metrics(task_results, n_samples, exclusions, metric_scale,
                           metric_values, rename=None):
    """Append a (value, se, n) triple to `metric_values` for every
    `<metric>,none` entry in one task's results. `rename` optionally maps the
    metric name (used to build "metric: subtask" virtual names)."""
    for key, val in task_results.items():
        if not key.endswith(",none") or "_stderr,none" in key:
            continue
        metric_name = key[: -len(",none")]
        if metric_name in exclusions:
            continue
        if isinstance(val, (int, float)):
            harness_se = task_results.get(f"{metric_name}_stderr,none")
            se = resolve_se(metric_name, val, harness_se, n_samples, metric_scale)
            name = rename(metric_name) if rename else metric_name
            metric_values.setdefault(name, []).append((val, se, n_samples))


def noreval_extract(results_json_path, benchmark_name, subtasks, metrics_setup_entry):
    """Read a NorEval result JSON and aggregate metrics across prompt variants.

    For each `(benchmark_name|benchmark_name_p<N>)` entry under "results", and
    optionally each subtask entry (`benchmark_name_<subtask>`), extract every
    `<metric>,none` value. Aggregate across prompt variants with
    aggregate_prompt_variants().

    Returns {metric_name: {…}} or None.
    """
    try:
        with open(results_json_path) as f:
            data = json.load(f)
    except json.JSONDecodeError:
        print(f"  WARNING: corrupt JSON, skipping: {results_json_path}")
        return None

    results = data.get("results", {})
    n_samples_dict = data.get("n-samples", {})
    bench_exclusions = EXCLUDED_METRICS | EXCLUDED_METRICS_PER_BENCHMARK.get(
        benchmark_name, set()
    )
    metric_scale = (
        metrics_setup_entry.get("metric_scale", "unit")
        if metrics_setup_entry else "unit"
    )

    metric_values = {}  # metric_name -> [(value, stderr_or_None, n), ...]
    for task_key, task_results in results.items():
        if task_key == benchmark_name or task_key.startswith(f"{benchmark_name}_p"):
            collect_prompt_metrics(
                task_results, get_n_samples(n_samples_dict, task_key),
                bench_exclusions, metric_scale, metric_values,
            )

    for subtask_code, subtask_info in (subtasks or {}).items():
        subtask_key = f"{benchmark_name}_{subtask_code}"
        task_results = results.get(subtask_key)
        if not task_results:
            continue
        pretty_name = subtask_info["pretty_name"]
        collect_prompt_metrics(
            task_results, get_n_samples(n_samples_dict, subtask_key),
            bench_exclusions, metric_scale, metric_values,
            rename=lambda m, p=pretty_name: f"{m}: {p}",
        )

    return aggregate_prompt_variants(metric_values, metric_scale)


def noreval_process_model_dir(model_path, metrics_setup):
    """Walk one model directory and collect per-benchmark per-shot scores.

    Returns (scores, discovered_metrics) where:
      scores = {benchmark: {shot: {metric: {…}}}}
      discovered_metrics = {benchmark: set_of_metric_names}
    """
    scores = {}
    discovered = {}
    for benchmark, config in metrics_setup.items():
        subtasks = config.get("subtasks")
        bench_scores = {}
        for shot_key, shot_dir_name in SHOT_DIRS.items():
            shot_path = os.path.join(model_path, benchmark, shot_dir_name)
            if not os.path.isdir(shot_path):
                continue
            results_file = find_latest_results_json(shot_path)
            if results_file is None:
                continue
            agg = noreval_extract(results_file, benchmark, subtasks, config)
            if agg is not None:
                bench_scores[shot_key] = agg
                discovered.setdefault(benchmark, set()).update(agg.keys())
        if bench_scores:
            scores[benchmark] = bench_scores
    return scores, discovered


def build_noreval_metrics_info(metrics_setup, discovered_metrics):
    """Build the metrics_setup section for a noreval-side data.json."""
    info = {}
    for benchmark, config in metrics_setup.items():
        max_perf = 100.0 if config.get("metric_scale") == "percent" else 1.0
        main_metric = config["main_metric"]
        disc = discovered_metrics.get(benchmark, set())
        base_metrics = {m for m in disc if ": " not in m}
        subtask_metrics = sorted(m for m in disc if ": " in m)
        base_others = sorted(base_metrics - {main_metric})
        available = (
            ([main_metric] if main_metric in disc else [])
            + base_others
            + subtask_metrics
        )
        if not available:
            available = sorted(disc)
        entry = {
            "pretty_name": config["pretty_name"],
            "description": config.get("description", ""),
            "main_metric": main_metric,
            "random_baseline": config["random_baseline"],
            "max_performance": max_perf,
            "category": config.get("category", "Uncategorized"),
            "evaluation_type": config.get("evaluation_type", ""),
            "metric_scale": config.get("metric_scale", "unit"),
            "url": config.get("url", ""),
            "available_metrics": available,
        }
        if config.get("subtasks"):
            entry["subtasks"] = {
                code: {
                    "pretty_name": st["pretty_name"],
                    "description": st.get("description", ""),
                }
                for code, st in config["subtasks"].items()
            }
        info[benchmark] = entry
    return info


def load_models_yaml(path):
    """Load a NorEval models YAML into the model-metadata section of data.json.

    Returns a dict whose keys are exactly the model_* / default_models fields
    the comparison dashboards read, so callers can splat it into the output.
    """
    meta = {
        "model_display_names": {},
        "model_categories": {},
        "model_organizations": {},
        "model_parameters": {},
        "model_colors": {},
        "model_fully_open": {},
        "model_info": {},
        "default_models": [],
    }
    if not path.exists():
        return meta
    for model_dir, cfg in load_yaml(path).items():
        meta["model_display_names"][model_dir] = cfg.get("display_name", model_dir)
        meta["model_categories"][model_dir] = cfg.get("category", "multilingual")
        meta["model_organizations"][model_dir] = cfg.get("organization", "")
        meta["model_parameters"][model_dir] = cfg.get("parameters", 0)
        meta["model_fully_open"][model_dir] = bool(cfg.get("fully_open", False))
        if cfg.get("default"):
            meta["default_models"].append(model_dir)
        if cfg.get("color"):
            meta["model_colors"][model_dir] = cfg["color"]
        info = {
            "description": cfg.get("description", ""),
            "huggingface_url": cfg.get("huggingface_url", ""),
            "license": cfg.get("license", ""),
        }
        if any(info.values()):
            meta["model_info"][model_dir] = info
    return meta


def build_noreval_lang_lists(metrics_setup):
    """Compute the language-membership lists used by the language filter."""
    nno = sorted(b for b in metrics_setup if "_nno" in b)
    sme = sorted(
        [b for b in metrics_setup if "_sme" in b]
        + (["noreval_multiblimp"] if "noreval_multiblimp" in metrics_setup else [])
    )
    nob_nno = sorted(b for b in metrics_setup if b in {
        "norsumm_nob_nno_translation", "norsumm_nno_nob_translation"
    })
    shared = ["slide"] if "slide" in metrics_setup else []
    return nno, sme, nob_nno, shared


# ─────────────────────────────────────────────────────────────
# NorEval comparison dashboards (base + instruct)
# ─────────────────────────────────────────────────────────────


def build_comparison_data(results_dir, models_yaml, metrics_setup):
    """Build a complete data.json for a comparison dashboard."""
    models = {}
    discovered = {}
    if results_dir.is_dir():
        for model_dir in sorted(os.listdir(results_dir)):
            model_path = results_dir / model_dir
            if not model_path.is_dir():
                continue
            print(f"  Model: {model_dir}")
            scores, disc = noreval_process_model_dir(str(model_path), metrics_setup)
            models[model_dir] = scores
            for b, mset in disc.items():
                discovered.setdefault(b, set()).update(mset)

    nno, sme, nob_nno, shared = build_noreval_lang_lists(metrics_setup)

    return {
        "metrics_setup": build_noreval_metrics_info(metrics_setup, discovered),
        "nno_benchmarks": nno,
        "sme_benchmarks": sme,
        "nob_nno_translation_benchmarks": nob_nno,
        "shared_language_benchmarks": shared,
        **load_models_yaml(models_yaml),
        "models": models,
    }


# ─────────────────────────────────────────────────────────────
# NorOLMo progression dashboard
# ─────────────────────────────────────────────────────────────


def build_norolmo_data(metrics_setup):
    """Walk data/norolmo/progress/ and build the norolmo data.json."""
    progress = {}
    ablations = {}
    discovered = {}

    if NOROLMO_PROGRESS.is_dir():
        for ckpt_dir in sorted(os.listdir(NOROLMO_PROGRESS)):
            ckpt_path = NOROLMO_PROGRESS / ckpt_dir
            if not ckpt_path.is_dir() or not ckpt_dir.startswith("NorOLMo-"):
                continue
            step_str = ckpt_dir.rsplit("-", 1)[-1]
            if not step_str.isdigit():
                continue
            step = int(step_str)
            if ckpt_dir.startswith("NorOLMo-step-"):
                # Main-line checkpoint: NorOLMo-step-{N}
                print(f"  Checkpoint: step {step}")
                target = progress
            else:
                # Ablation checkpoint: NorOLMo-<ablation_name>-step-{N}
                suffix = ckpt_dir[len("NorOLMo-"):]
                ablation_name = suffix[: suffix.rfind("-step-")]
                if not ablation_name:
                    continue
                print(f"  Ablation {ablation_name}: step {step}")
                target = ablations.setdefault(ablation_name, {})
            scores, disc = noreval_process_model_dir(str(ckpt_path), metrics_setup)
            target[step] = scores
            for b, mset in disc.items():
                discovered.setdefault(b, set()).update(mset)

    ablation_display_names = {
        n: ABLATION_NAME_MAP.get(n, n.replace("-", " ").title())
        for n in ablations
    }
    ablation_colors = {n: ABLATION_COLOR_MAP.get(n, "") for n in ablations}

    nno, sme, nob_nno, shared = build_noreval_lang_lists(metrics_setup)

    return {
        "metrics_setup": build_noreval_metrics_info(metrics_setup, discovered),
        "nno_benchmarks": nno,
        "sme_benchmarks": sme,
        "nob_nno_translation_benchmarks": nob_nno,
        "shared_language_benchmarks": shared,
        "progress": progress,
        "ablations": ablations,
        "ablation_display_names": ablation_display_names,
        "ablation_colors": ablation_colors,
    }


# ─────────────────────────────────────────────────────────────
# MultiSynt extraction
# ─────────────────────────────────────────────────────────────


def multisynt_extract(results_json_path, benchmark_name, task_config_entry, match_name=None):
    """Read one MultiSynt partition's results JSON.

    MultiSynt scores use suffixes other than `,none` (e.g. `,remove_whitespace`),
    so we accept any `,<suffix>` form. Only the benchmark's own (or per-
    partition `_p<N>`) entries are read — subtask entries like
    `global_mmlu_french_business_p0` are skipped, since lm-eval also reports
    the group aggregate under `results`. `match_name` overrides the name used
    to match result keys (e.g. `norbelebele_cf` for a formulation variant of
    `norbelebele`); `benchmark_name` still keys the metric exclusions.
    Returns {metric: (value, se, n)} or None.
    """
    if match_name is None:
        match_name = benchmark_name
    with open(results_json_path) as f:
        data = json.load(f)
    results = data.get("results", {})
    n_samples_dict = data.get("n-samples", {})
    metric_scale = (
        task_config_entry.get("metric_scale", "unit") if task_config_entry else "unit"
    )
    bench_exclusions = EXCLUDED_METRICS | EXCLUDED_METRICS_PER_BENCHMARK.get(
        benchmark_name, set()
    )

    metrics = {}
    for task_key, task_results in results.items():
        if not (task_key == match_name or task_key.startswith(f"{match_name}_p")):
            continue
        n_samples = get_n_samples(n_samples_dict, task_key)
        for key, val in task_results.items():
            if key == "alias" or "," not in key or "_stderr," in key:
                continue
            metric_name, metric_suffix = key.rsplit(",", 1)
            if metric_name in bench_exclusions:
                continue
            if isinstance(val, (int, float)) and math.isfinite(val):
                harness_se = task_results.get(f"{metric_name}_stderr,{metric_suffix}")
                if not (isinstance(harness_se, (int, float)) and math.isfinite(harness_se)):
                    harness_se = None
                se = resolve_se(metric_name, val, harness_se, n_samples, metric_scale)
                metrics[metric_name] = (val, se, n_samples)

    return metrics if metrics else None


# Metric families micro-averaged by `aggregator: multiblimp` tasks (each is a
# Bernoulli proportion, so sample-weighted averaging and Wilson CIs apply).
MULTIBLIMP_AGG_METRICS = ("acc", "acc_norm", "acc_mutual_info")


def multisynt_process_multiblimp(sub_entries, bench_exclusions):
    """Aggregate multiblimp per-phenomenon results into micro-averaged scores.

    `sub_entries` holds (subdir_path, results_key) pairs, one per phenomenon,
    each keyed by the lm-eval task name inside its results JSON. Accuracy-family
    metrics are micro-averaged weighted by sample count to mimic how
    noreval_multiblimp is reported in noreval-stats.
    """
    totals = {}
    for sub_path, key in sub_entries:
        results_file = find_latest_results_json(sub_path)
        if results_file is None:
            continue
        with open(results_file) as f:
            data = json.load(f)
        task_results = data.get("results", {}).get(key)
        if not task_results:
            continue
        n = (
            data.get("n-samples", {}).get(key, {}).get("effective")
            or data.get("n-samples", {}).get(key, {}).get("original")
        )
        if not n:
            continue
        for metric in MULTIBLIMP_AGG_METRICS:
            if metric in bench_exclusions:
                continue
            val = task_results.get(f"{metric},none")
            if val is None:
                continue
            totals.setdefault(metric, [0.0, 0])
            totals[metric][0] += val * n
            totals[metric][1] += n

    out = {}
    for metric, (weighted, total_n) in totals.items():
        micro = weighted / total_n
        se = wilson_se(micro, total_n, "unit") or 0.0
        out[metric] = (micro, se, total_n)
    return out or None


# Prompt-formulation subdirs (Norwegian v2 layout): each holds its own p<N>
# partitions, all pooled as prompt variants of the parent task.
MULTISYNT_FORMULATIONS = ("cf", "mcf", "hybrid")

# Matches a formulation tag embedded in a variant dir name (Finnish layout,
# e.g. `arc_challenge_fi_cf_fbv2`).
MULTISYNT_FORMULATION_RE = re.compile(
    r"(?:^|_)(" + "|".join(MULTISYNT_FORMULATIONS) + r")(?:_|$)"
)

# Suffix of a flat variant dir name (NorEval-1.2 layout), where formulation
# and prompt partition are embedded in the name itself rather than nested as
# subdirs: `norbelebele_nob_cf_p0`, or `ask_gec_nob_p3` (no formulation).
MULTISYNT_FLAT_SUFFIX = r"(?:_(%s))?_p\d+" % "|".join(MULTISYNT_FORMULATIONS)
MULTISYNT_FLAT_SUFFIX_RE = re.compile(MULTISYNT_FLAT_SUFFIX + r"$")


def multisynt_flat_variant_dirs(ckpt_path, src_dir, src_form):
    """Variant dirs for a task whose nested source dir is absent (flat layout).

    Looks next to where the source dir would be — and, for nested `path`
    configs, in the checkpoint dir itself — for `<base>[_<form>]_p<N>` dirs.
    Each one is a single prompt variant; its dir name doubles as the results
    key inside its JSON.
    """
    base = os.path.basename(src_dir)
    pattern = re.compile(re.escape(base) + MULTISYNT_FLAT_SUFFIX)
    for parent in dict.fromkeys((os.path.dirname(src_dir), ckpt_path)):
        if not os.path.isdir(parent):
            continue
        found = []
        for entry in sorted(os.listdir(parent)):
            m = pattern.fullmatch(entry)
            if m and os.path.isdir(os.path.join(parent, entry)):
                found.append((os.path.join(parent, entry), entry, m.group(1) or src_form))
        if found:
            return found
    return []


def multisynt_partition_dirs(path):
    """Sorted p<N> partition subdirs of `path` (empty if un-partitioned)."""
    return sorted(
        os.path.join(path, d)
        for d in os.listdir(path)
        if os.path.isdir(os.path.join(path, d)) and d.startswith("p") and d[1:].isdigit()
    )


def multisynt_process_checkpoint(ckpt_path, task_configs, shot):
    """Process one checkpoint directory. Returns {bench: {shot: {metric: {…}}}}."""
    scores = {}
    for benchmark, config in task_configs.items():
        partition_results = []
        if config.get("aggregator") == "multiblimp":
            # Phenomenon subdirs live either inside the task's own directory
            # (nested layout) or directly in the checkpoint dir with the task
            # name as prefix (NorEval-1.2 flat layout).
            bench_path = os.path.join(ckpt_path, config.get("path", benchmark))
            parent = bench_path if os.path.isdir(bench_path) else ckpt_path
            sub_entries = [
                (os.path.join(parent, d), d)
                for d in sorted(os.listdir(parent))
                if d.startswith(f"{benchmark}_")
                and os.path.isdir(os.path.join(parent, d))
            ]
            agg_metrics = multisynt_process_multiblimp(
                sub_entries, EXCLUDED_METRICS_PER_BENCHMARK.get(benchmark, set())
            )
            if agg_metrics:
                partition_results.append((None, agg_metrics))
        else:
            # A task's runs may live under several variant sources, all pooled
            # as prompt variants: multiple `paths` (Finnish's sibling
            # `*_cf_fbv2`/`*_mcf_fbv2` dirs, matched by their own dir name) and
            # cf/mcf/hybrid formulation subdirs inside a source (Norwegian v2,
            # matched as `<task>_<formulation>`). Each source holds one p<N>
            # subdir per prompt; a bare directory means a single
            # un-partitioned run.
            # Each source carries a formulation label: the subdir name for
            # formulation subdirs, or a tag embedded in a multi-`paths` dir
            # name (`arc_challenge_fi_cf_fbv2` → "cf"). Labels drive the
            # per-formulation `by_form` sub-aggregates below.
            if "paths" in config:
                sources = []
                for p in config["paths"]:
                    m = MULTISYNT_FORMULATION_RE.search(p.rsplit("/", 1)[-1])
                    sources.append(
                        (os.path.join(ckpt_path, p), p.replace("/", "_"),
                         m.group(1) if m else None)
                    )
            else:
                sources = [
                    (os.path.join(ckpt_path, config.get("path", benchmark)), benchmark, None)
                ]

            search_dirs = []
            for src_dir, src_name, src_form in sources:
                if not os.path.isdir(src_dir):
                    search_dirs += multisynt_flat_variant_dirs(
                        ckpt_path, src_dir, src_form
                    )
                    continue
                found = [
                    (p, src_name, src_form) for p in multisynt_partition_dirs(src_dir)
                ]
                for form in MULTISYNT_FORMULATIONS:
                    form_dir = os.path.join(src_dir, form)
                    if not os.path.isdir(form_dir):
                        continue
                    form_name = f"{src_name}_{form}"
                    found += [
                        (p, form_name, form) for p in multisynt_partition_dirs(form_dir)
                    ] or [(form_dir, form_name, form)]
                search_dirs += found or [(src_dir, src_name, src_form)]

            for path, match_name, form in search_dirs:
                results_file = find_latest_results_json(path)
                if results_file is None:
                    continue
                metrics = multisynt_extract(results_file, benchmark, config, match_name)
                if metrics:
                    partition_results.append((form, metrics))

        if not partition_results:
            continue

        # Reduce the (form_label, {metric: (val, se, n)}) pairs to
        # {metric: prompt-agg dict}.
        def collect(results):
            metric_values = {}
            for pmetrics in results:
                for metric_name, tup in pmetrics.items():
                    metric_values.setdefault(metric_name, []).append(tup)
            return metric_values

        scale = config.get("metric_scale", "unit")
        agg = aggregate_prompt_variants(collect([m for _, m in partition_results]), scale)
        if agg is None:
            continue

        # With ≥2 formulations, additionally aggregate each one on its own so
        # the dashboard's formulation selector can show it in isolation.
        labels = {form for form, _ in partition_results if form}
        if len(labels) >= 2:
            for form in (f for f in MULTISYNT_FORMULATIONS if f in labels):
                sub = aggregate_prompt_variants(
                    collect([m for f, m in partition_results if f == form]), scale
                )
                for metric_name, entry in (sub or {}).items():
                    if metric_name in agg:
                        agg[metric_name].setdefault("by_form", {})[form] = entry

        scores[benchmark] = {shot: agg}
    return scores


def multisynt_parse_model_dir(name):
    """Map e.g. 'hplt2_0shot_checkpoints' → ('hplt2', '0')."""
    m = re.match(r"^(.+?)_(\d+)shot_checkpoints$", name, re.IGNORECASE)
    return (m.group(1).lower(), m.group(2)) if m else (None, None)


def multisynt_parse_checkpoint_name(name):
    """Map checkpoint dir name to billions of tokens (or 'main')."""
    if name.isdigit():
        # 2048 sequences × 1024 tokens per step
        val = round(int(name) * 2048 * 1024 / 1e9, 1)
        return int(val) if val == int(val) else val
    upper = name.upper()
    if upper.endswith("B") and upper[:-1].isdigit():
        return int(upper[:-1])
    if name == "main":
        return "main"
    return None


def multisynt_discover_language_tasks(lang_dir, task_configs):
    """Find which configured tasks have results in this language.

    A task may declare one nested `path` (e.g. `noropenbookqa/noropenbookqa_nob`)
    or several `paths` (Finnish's sibling `*_cf_fbv2`/`*_mcf_fbv2` variant
    dirs), so every configured path is probed directly rather than walking
    the tree. Flat-layout dirs (NorEval 1.2) are recognized by stripping the
    embedded formulation/partition suffix and matching the config whose path
    basename remains; aggregator tasks instead claim every dir sharing their
    name as prefix (`multiblimp_ltg_sme_1-23`).
    """
    found = set()
    unknown = set()
    configured_paths = {}
    for key, cfg in task_configs.items():
        for p in cfg.get("paths", [cfg.get("path", key)]):
            configured_paths[p] = key
    known_tops = {p.split("/", 1)[0] for p in configured_paths}
    flat_bases = {os.path.basename(p): key for p, key in configured_paths.items()}
    aggregator_prefixes = {
        f"{key}_": key for key, cfg in task_configs.items() if cfg.get("aggregator")
    }

    for model_dir in os.listdir(lang_dir):
        model_path = os.path.join(lang_dir, model_dir)
        if not os.path.isdir(model_path) or model_dir.startswith("."):
            continue
        for ckpt in os.listdir(model_path):
            ckpt_path = os.path.join(model_path, ckpt)
            if not os.path.isdir(ckpt_path) or ckpt.startswith("."):
                continue
            for path, task in configured_paths.items():
                if task not in found and os.path.isdir(os.path.join(ckpt_path, path)):
                    found.add(task)
            for top in os.listdir(ckpt_path):
                top_path = os.path.join(ckpt_path, top)
                if not os.path.isdir(top_path) or top.startswith("."):
                    continue
                if top in known_tops:
                    continue
                base = MULTISYNT_FLAT_SUFFIX_RE.sub("", top)
                agg_key = next(
                    (k for p, k in aggregator_prefixes.items() if top.startswith(p)),
                    None,
                )
                if base != top and base in flat_bases:
                    found.add(flat_bases[base])
                elif agg_key is not None:
                    found.add(agg_key)
                else:
                    unknown.add(top)
    return found, unknown


def build_multisynt_data():
    """Build the multisynt data.json with per-language model trajectories."""
    if not MULTISYNT_RESULTS.is_dir():
        return {"languages": {}}

    all_task_configs = load_yaml(MULTISYNT_TASKS_YAML)
    model_configs = load_yaml(MULTISYNT_MODELS_YAML)

    output = {"languages": {}}
    for lang_name in sorted(os.listdir(MULTISYNT_RESULTS)):
        lang_dir = MULTISYNT_RESULTS / lang_name
        if not lang_dir.is_dir() or lang_name.startswith("."):
            continue
        print(f"\n=== MultiSynt language: {lang_name} ===")

        lang_tasks, unknown_tasks = multisynt_discover_language_tasks(
            str(lang_dir), all_task_configs
        )
        task_configs = {t: all_task_configs[t] for t in sorted(lang_tasks)}
        for u in sorted(unknown_tasks):
            print(f"  WARNING: no config for task '{u}', skipping")

        discovered = {}
        discovered_forms = {}
        models_out = {}

        # Group model dirs by base name (hplt2_0shot_checkpoints + _5shot → hplt2)
        model_groups = {}
        for entry in sorted(os.listdir(lang_dir)):
            entry_path = lang_dir / entry
            if not entry_path.is_dir() or entry.startswith("."):
                continue
            base_model, shot = multisynt_parse_model_dir(entry)
            if base_model is None:
                print(f"  WARNING: cannot parse '{entry}', skipping")
                continue
            model_groups.setdefault(base_model, []).append((entry, shot, entry_path))

        for base_model in sorted(model_groups):
            cfg = model_configs.get(base_model, {})
            display_name = cfg.get("display_name", base_model)
            color = cfg.get("color", "#6366f1")
            print(f"  Model: {base_model} ({display_name})")
            progress = {}
            for model_dir_name, shot, model_path in model_groups[base_model]:
                print(f"    Shot {shot}-shot ({model_dir_name})")
                for ckpt_name in sorted(os.listdir(model_path)):
                    ckpt_path = model_path / ckpt_name
                    if not ckpt_path.is_dir() or ckpt_name.startswith("."):
                        continue
                    tokens_b = multisynt_parse_checkpoint_name(ckpt_name)
                    if tokens_b is None:
                        continue
                    scores = multisynt_process_checkpoint(
                        str(ckpt_path), task_configs, shot
                    )
                    if scores:
                        bucket = progress.setdefault(tokens_b, {})
                        for bench, shot_data in scores.items():
                            bucket.setdefault(bench, {}).update(shot_data)
                            for metric_data in shot_data.values():
                                discovered.setdefault(bench, set()).update(metric_data.keys())
                                for entry in metric_data.values():
                                    discovered_forms.setdefault(bench, set()).update(
                                        entry.get("by_form", ())
                                    )

            models_out[base_model] = {
                "display_name": display_name,
                "color": color,
                "progress": progress,
            }

        # Resolve "main" checkpoint to the largest numeric token value seen.
        max_tokens = 0
        for md in models_out.values():
            for tk in md["progress"]:
                if isinstance(tk, (int, float)):
                    max_tokens = max(max_tokens, tk)
        for md in models_out.values():
            if "main" in md["progress"] and max_tokens > 0:
                md["progress"][max_tokens] = md["progress"].pop("main")

        # Build per-language metrics_setup
        metrics_setup_out = {}
        for task, config in task_configs.items():
            disc = discovered.get(task, set())
            if not disc:
                continue
            main_metric = config["main_metric"]
            max_perf = 100.0 if config.get("metric_scale") == "percent" else 1.0
            base_others = sorted(disc - {main_metric})
            available = (
                ([main_metric] if main_metric in disc else []) + base_others
            )
            forms = discovered_forms.get(task, set())
            metrics_setup_out[task] = {
                "pretty_name": config["pretty_name"],
                "main_metric": main_metric,
                "random_baseline": config["random_baseline"],
                "max_performance": max_perf,
                "category": config.get("category", "uncategorized"),
                "evaluation_type": config.get("evaluation_type", "classification"),
                "metric_scale": config.get("metric_scale", "unit"),
                "available_metrics": available,
                **({"formulations": [f for f in MULTISYNT_FORMULATIONS if f in forms]}
                   if forms else {}),
            }

        output["languages"][lang_name] = {
            "metrics_setup": metrics_setup_out,
            "models": models_out,
        }

    return output


# ─────────────────────────────────────────────────────────────
# Driver
# ─────────────────────────────────────────────────────────────


def write_data(out_path, data):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(data, f, ensure_ascii=False)
    size_kb = os.path.getsize(out_path) / 1024
    print(f"  → wrote {out_path.relative_to(BASE_DIR)} ({size_kb:.1f} KB)")


def main():
    metrics_setup = load_yaml(METRICS_SETUP_YAML)

    print("\n=== Building docs/noreval/data.json (base models) ===")
    noreval = build_comparison_data(
        NOREVAL_RESULTS, MODELS_SETUP_YAML, metrics_setup
    )
    write_data(NOREVAL_OUT, noreval)
    print(f"  Models: {len(noreval['models'])}")

    print("\n=== Building docs/noreval-gen/data.json (instruct models) ===")
    noreval_gen = build_comparison_data(
        NOREVAL_GEN_RESULTS, INSTRUCT_MODELS_SETUP_YAML, metrics_setup
    )
    write_data(NOREVAL_GEN_OUT, noreval_gen)
    print(f"  Models: {len(noreval_gen['models'])}")

    print("\n=== Building docs/norolmo/data.json (NorOLMo progression) ===")
    norolmo = build_norolmo_data(metrics_setup)
    write_data(NOROLMO_OUT, norolmo)
    print(f"  Checkpoints: {len(norolmo['progress'])}")
    print(f"  Ablations: {list(norolmo['ablations'].keys())}")

    print("\n=== Building docs/multisynt/data.json (multilingual progression) ===")
    multisynt = build_multisynt_data()
    write_data(MULTISYNT_OUT, multisynt)
    for lang, ld in multisynt["languages"].items():
        print(f"  {lang}: {len(ld['models'])} models, {len(ld['metrics_setup'])} tasks")

    print("\nDone.")


if __name__ == "__main__":
    main()
