#!/usr/bin/env python3
"""Parallel-coordinates study of evaluation choices on the MultiSynt data.

For every combination of five evaluation-choice dimensions
  - shots:          0-shot / 5-shot
  - eval type:      classification / generation / both
  - prompt agg:     single prompt (per-prompt metric, averaged last) / average / max
  - normalization:  no norm (acc) / character (acc_norm) / PMI (acc_mutual_info) / max
  - MC formulation: CF / MCF / hybrid / max (pooled over formulations)
three output metrics are computed per task and then averaged over tasks:
  - monotonicity:        Spearman rho(tokens, score) per model, median over models
  - non-randomness:      max score - random baseline per model, median over models
  - ranking consistency: mean Kendall tau between successive checkpoint rankings

The metric definitions are 1:1 ports of docs/shared/filter.js (HPLT-E filter);
dimensions that a task does not carry (e.g. formulations on generation tasks)
fall back to the pooled value, mirroring resolveScoreObj in docs/shared/core.js.
Dimensions absent from a whole language (e.g. formulations and accuracy-norm
variants in French/Spanish) are dropped from its plots.

Usage: python3 analysis/eval_choice_study.py            # uses cache if present
       python3 analysis/eval_choice_study.py --rebuild  # force raw re-extraction
"""

import itertools
import json
import os
import sys
import statistics
from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
from matplotlib import cm, colors as mcolors

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

import build_data  # reuse the dashboard's extraction helpers

LANGUAGES = ["Norwegian_v2", "Finnish", "French", "Spanish"]
RESULTS_DIR = BASE_DIR / "data" / "multisynt" / "results"
ANALYSIS_DIR = Path(__file__).resolve().parent
PLOTS_DIR = ANALYSIS_DIR / "plots"

# Same token window as the dashboard's DEFAULT_CRITERIA (filter.js).
WINDOW_MIN, WINDOW_MAX = 10, 100

ACC_VARIANTS = ("acc", "acc_norm", "acc_mutual_info")
NORM_METRIC = {"none": "acc", "character": "acc_norm", "pmi": "acc_mutual_info"}


# ─────────────────────────────────────────────────────────────
# Raw per-prompt extraction (mirrors multisynt_process_checkpoint,
# but keeps each (formulation, prompt) partition separate)
# ─────────────────────────────────────────────────────────────


def extract_checkpoint(ckpt_path, task_configs):
    """{task: [[form, source_name, {metric: value}], ...]} for one checkpoint."""
    out = {}
    for benchmark, config in task_configs.items():
        partitions = []
        if config.get("aggregator") == "multiblimp":
            bench_path = os.path.join(ckpt_path, config.get("path", benchmark))
            agg = build_data.multisynt_process_multiblimp(bench_path)
            if agg:
                partitions.append([None, benchmark, {m: v for m, (v, _, _) in agg.items()}])
        else:
            if "paths" in config:
                sources = []
                for p in config["paths"]:
                    m = build_data.MULTISYNT_FORMULATION_RE.search(p.rsplit("/", 1)[-1])
                    sources.append((os.path.join(ckpt_path, p), p.replace("/", "_"),
                                    m.group(1) if m else None))
            else:
                sources = [(os.path.join(ckpt_path, config.get("path", benchmark)),
                            benchmark, None)]

            search_dirs = []
            for src_dir, src_name, src_form in sources:
                if not os.path.isdir(src_dir):
                    continue
                found = [(p, src_name, src_form)
                         for p in build_data.multisynt_partition_dirs(src_dir)]
                for form in build_data.MULTISYNT_FORMULATIONS:
                    form_dir = os.path.join(src_dir, form)
                    if not os.path.isdir(form_dir):
                        continue
                    form_name = f"{src_name}_{form}"
                    found += [(p, form_name, form)
                              for p in build_data.multisynt_partition_dirs(form_dir)
                              ] or [(form_dir, form_name, form)]
                search_dirs += found or [(src_dir, src_name, src_form)]

            for path, match_name, form in search_dirs:
                results_file = build_data.find_latest_results_json(path)
                if results_file is None:
                    continue
                metrics = build_data.multisynt_extract(results_file, benchmark, config, match_name)
                if metrics:
                    prompt_id = os.path.basename(path)
                    partitions.append([form, f"{match_name}/{prompt_id}",
                                       {m: v for m, (v, _, _) in metrics.items()}])
        if partitions:
            out[benchmark] = partitions
    return out


def extract_language(lang):
    """{model: {shot: {tokens: {task: [[form, source, {metric: value}], ...]}}}}"""
    lang_dir = RESULTS_DIR / lang
    all_configs = build_data.load_yaml(build_data.MULTISYNT_TASKS_YAML)
    lang_tasks, _ = build_data.multisynt_discover_language_tasks(str(lang_dir), all_configs)
    task_configs = {t: all_configs[t] for t in sorted(lang_tasks)}

    raw = {}
    for entry in sorted(os.listdir(lang_dir)):
        entry_path = lang_dir / entry
        if not entry_path.is_dir() or entry.startswith("."):
            continue
        base_model, shot = build_data.multisynt_parse_model_dir(entry)
        if base_model is None:
            continue
        print(f"  extracting {entry} ...")
        for ckpt_name in sorted(os.listdir(entry_path)):
            ckpt_path = entry_path / ckpt_name
            if not ckpt_path.is_dir() or ckpt_name.startswith("."):
                continue
            tokens_b = build_data.multisynt_parse_checkpoint_name(ckpt_name)
            if tokens_b is None or tokens_b == "main":
                continue
            scores = extract_checkpoint(str(ckpt_path), task_configs)
            if scores:
                raw.setdefault(base_model, {}).setdefault(shot, {})[str(tokens_b)] = scores
    return raw


def load_raw(lang, rebuild=False):
    cache_file = ANALYSIS_DIR / f".cache_{lang.lower()}_prompts.json"
    if cache_file.exists() and not rebuild:
        print(f"Loading cached per-prompt table: {cache_file}")
        return json.loads(cache_file.read_text())
    print(f"Extracting per-prompt scores from {RESULTS_DIR / lang} ...")
    raw = extract_language(lang)
    cache_file.write_text(json.dumps(raw))
    print(f"Cached to {cache_file}")
    return raw


# ─────────────────────────────────────────────────────────────
# Metric math (ports of filter.js)
# ─────────────────────────────────────────────────────────────


def spearman(x, y):
    if len(x) < 3:
        return None
    n = len(x)

    def rank(arr):
        order = sorted(range(n), key=lambda i: arr[i])
        ranks = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j < n - 1 and arr[order[j + 1]] == arr[order[j]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                ranks[order[k]] = avg
            i = j + 1
        return ranks

    rx, ry = rank(x), rank(y)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    dx2 = sum((a - mx) ** 2 for a in rx)
    dy2 = sum((b - my) ** 2 for b in ry)
    denom = (dx2 * dy2) ** 0.5
    return 0.0 if denom == 0 else num / denom


def kendall(x, y):
    n = len(x)
    if n < 2:
        return None
    concordant = discordant = 0
    for i in range(n):
        for j in range(i + 1, n):
            d = (x[i] - x[j]) * (y[i] - y[j])
            if d > 0:
                concordant += 1
            elif d < 0:
                discordant += 1
    pairs = n * (n - 1) / 2
    return 0.0 if pairs == 0 else (concordant - discordant) / pairs


def median(arr):
    return statistics.median(arr) if arr else None


# ─────────────────────────────────────────────────────────────
# Score resolution for one configuration
# ─────────────────────────────────────────────────────────────


class TaskData:
    """Per-task view over the raw table for one shot setting."""

    def __init__(self, raw, task, shot, info):
        self.task = task
        self.info = info
        self.scale = 100.0 if info["metric_scale"] == "unit" else 1.0
        self.baseline_pct = info["random_baseline"] * self.scale
        self.main_metric = info["main_metric"]
        # models -> {tokens(float): [ (form, source, metrics) ... ]}
        self.models = {}
        for model, shots in raw.items():
            ckpts = shots.get(shot, {})
            per_x = {}
            for tok, tasks in ckpts.items():
                if task in tasks:
                    per_x[float(tok)] = tasks[task]
                else:
                    per_x[float(tok)] = None  # checkpoint exists, task missing
            if any(v is not None for v in per_x.values()):
                self.models[model] = per_x
        self.has_forms = any(
            rec[0] is not None
            for per_x in self.models.values()
            for recs in per_x.values() if recs
            for rec in recs
        )
        # Normalization selector applies only when the task's main metric is
        # "acc" and all three variants are reported (mirrors resolveScoreObj).
        self.has_norm_variants = self.main_metric == "acc" and any(
            all(v in rec[2] for v in ACC_VARIANTS)
            for per_x in self.models.values()
            for recs in per_x.values() if recs
            for rec in recs
        )
        self.has_acc_norm = any(
            "acc_norm" in rec[2]
            for per_x in self.models.values()
            for recs in per_x.values() if recs
            for rec in recs
        )

    def effective_key(self, agg, norm, form):
        norm_eff = norm if self.has_norm_variants else "main"
        form_eff = form if (self.has_forms and form != "max") else "pooled"
        return (agg, norm_eff, form_eff)

    def pool(self, recs, form_eff):
        if recs is None:
            return []
        if form_eff == "pooled":
            return recs
        return [r for r in recs if r[0] == form_eff]

    def prompt_keys(self, form_eff):
        keys = set()
        for per_x in self.models.values():
            for recs in per_x.values():
                for r in self.pool(recs, form_eff):
                    keys.add(r[1])
        return sorted(keys)

    def score(self, recs, agg, norm_eff, form_eff, prompt_key=None):
        """Aggregated raw-percent score of one checkpoint block (or None)."""
        pool = self.pool(recs, form_eff)
        if prompt_key is not None:
            pool = [r for r in pool if r[1] == prompt_key]
        if not pool:
            return None
        # "loglik" and "char" are used by the metric-type study: raw
        # norm_loglikelihood_corr, and acc_norm without the all-three-variants
        # qualification (falling back to the main metric where absent).
        if norm_eff == "loglik":
            variants = ("norm_loglikelihood_corr",)
        elif norm_eff == "char":
            variants = ("acc_norm",) if self.has_acc_norm else (self.main_metric,)
        elif norm_eff == "maxnorm":
            variants = ACC_VARIANTS
        elif norm_eff in NORM_METRIC:
            variants = (NORM_METRIC[norm_eff],)
        else:
            variants = (self.main_metric,)
        best = None
        for metric in variants:
            vals = [r[2][metric] for r in pool if metric in r[2]]
            if not vals:
                continue
            v = max(vals) if agg == "max" else sum(vals) / len(vals)
            if best is None or v > best:
                best = v
        return None if best is None else best * self.scale

    def trajectories(self, agg, norm_eff, form_eff, prompt_key=None):
        """{model: {x: score}} on each model's full checkpoint grid."""
        out = {}
        for model, per_x in self.models.items():
            traj = {}
            for x, recs in per_x.items():
                s = self.score(recs, agg, norm_eff, form_eff, prompt_key)
                if s is not None:
                    traj[x] = s
            out[model] = traj
        return out


def interpolate(traj, grid, target):
    """filter.js interpolateScore: exact hit, else linear between grid neighbors."""
    if target in traj:
        return traj[target]
    lo = hi = None
    for v in grid:
        if v <= target:
            lo = v
        if v >= target and hi is None:
            hi = v
    if lo is None or hi is None or lo == hi:
        return None
    lo_s, hi_s = traj.get(lo), traj.get(hi)
    if lo_s is None or hi_s is None:
        return None
    return lo_s + (target - lo) / (hi - lo) * (hi_s - lo_s)


def criteria_from_trajectories(trajs, grids, baseline_pct):
    """(monotonicity, non_randomness, consistency) — ports of filter.js."""
    rhos, nonrands = [], []
    for model, traj in trajs.items():
        pts = sorted((x, s) for x, s in traj.items() if WINDOW_MIN <= x <= WINDOW_MAX)
        if len(pts) >= 3:
            rho = spearman([p[0] for p in pts], [p[1] for p in pts])
            if rho is not None:
                rhos.append(rho)
        if len(pts) >= 1:
            nonrands.append(max(0.0, max(p[1] for p in pts) - baseline_pct))

    consistency = None
    if len(trajs) >= 2:
        all_x = sorted({x for g in grids.values() for x in g
                        if WINDOW_MIN <= x <= WINDOW_MAX})
        rankings = []
        for xv in all_x:
            scores = []
            for model, traj in trajs.items():
                s = interpolate(traj, grids[model], xv)
                if s is None:
                    scores = None
                    break
                scores.append(s)
            if scores is not None:
                rankings.append(scores)
        if len(rankings) >= 2:
            taus = [kendall(rankings[i], rankings[i + 1]) or 0.0
                    for i in range(len(rankings) - 1)]
            consistency = sum(taus) / len(taus)

    return median(rhos), median(nonrands), consistency


def task_criteria(td, agg, norm_eff, form_eff):
    """The three criteria for one task under one effective configuration."""
    grids = {m: sorted(per_x.keys()) for m, per_x in td.models.items()}
    if agg == "single":
        # Evaluate every prompt separately, then average as the last step.
        per_prompt = [criteria_from_trajectories(
            td.trajectories(agg, norm_eff, form_eff, prompt_key=pk), grids, td.baseline_pct)
            for pk in td.prompt_keys(form_eff)]
        out = []
        for i in range(3):
            vals = [p[i] for p in per_prompt if p[i] is not None]
            out.append(sum(vals) / len(vals) if vals else None)
        return tuple(out)
    return criteria_from_trajectories(
        td.trajectories(agg, norm_eff, form_eff), grids, td.baseline_pct)


# ─────────────────────────────────────────────────────────────
# Configuration sweep
# ─────────────────────────────────────────────────────────────

SHOT_VAL = {"0-shot": "0", "5-shot": "5"}
AGG_VAL = {"Single": "single", "Average": "mean", "Max": "max"}
NORM_VAL = {"No norm": "none", "Character": "character", "PMI": "pmi", "Max": "maxnorm"}
FORM_VAL = {"CF": "cf", "MCF": "mcf", "Hybrid": "hybrid", "Max": "max"}
FORM_LABEL = {"cf": "CF", "mcf": "MCF", "hybrid": "Hybrid"}

DIMENSIONS = [
    ("Shots", ["0-shot", "5-shot"]),
    ("Evaluation type", ["Classification", "Generation", "Both"]),
    ("Prompt aggregation", ["Single", "Average", "Max"]),
    ("Normalization", ["No norm", "Character", "PMI", "Max"]),
    ("MC formulation", ["CF", "MCF", "Hybrid", "Max"]),
]


def lang_dimensions(metrics_setup):
    """The DIMENSIONS subset a language actually carries, with the formulation
    levels restricted to the formulations present (e.g. Finnish has no hybrid)."""
    dims = []
    forms = sorted({f for i in metrics_setup.values() for f in i.get("formulations", [])})
    has_norm = any(
        i["main_metric"] == "acc"
        and all(v in i.get("available_metrics", []) for v in ACC_VARIANTS)
        for i in metrics_setup.values())
    for name, levels in DIMENSIONS:
        if name == "Normalization" and not has_norm:
            continue
        if name == "MC formulation":
            if not forms:
                continue
            levels = [FORM_LABEL[f] for f in ("cf", "mcf", "hybrid") if f in forms] + ["Max"]
        dims.append((name, levels))
    return dims


def sweep(raw, metrics_setup, dims):
    task_data = {}   # (task, shot) -> TaskData
    memo = {}        # (task, shot, agg, norm_eff, form_eff) -> (mono, nonrand, cons)
    rows = []

    dim_names = [d for d, _ in dims]
    for combo in itertools.product(*[levels for _, levels in dims]):
        cfg = dict(zip(dim_names, combo))
        shot = SHOT_VAL[cfg["Shots"]]
        et = cfg["Evaluation type"]
        agg = AGG_VAL[cfg["Prompt aggregation"]]
        norm = NORM_VAL[cfg.get("Normalization", "Max")]
        form = FORM_VAL[cfg.get("MC formulation", "Max")]
        tasks = [t for t, info in metrics_setup.items()
                 if et == "Both" or info["evaluation_type"] == et.lower()]
        acc = [[], [], []]
        for t in tasks:
            if (t, shot) not in task_data:
                task_data[(t, shot)] = TaskData(raw, t, shot, metrics_setup[t])
            td = task_data[(t, shot)]
            key = (t, shot) + td.effective_key(agg, norm, form)
            if key not in memo:
                memo[key] = task_criteria(td, *td.effective_key(agg, norm, form))
            for i, v in enumerate(memo[key]):
                if v is not None:
                    acc[i].append(v)
        rows.append({
            **cfg,
            "monotonicity": sum(acc[0]) / len(acc[0]) if acc[0] else None,
            "non_randomness": sum(acc[1]) / len(acc[1]) if acc[1] else None,
            "consistency": sum(acc[2]) / len(acc[2]) if acc[2] else None,
        })
    return rows


# ─────────────────────────────────────────────────────────────
# Verification against the built data.json
# ─────────────────────────────────────────────────────────────


def verify_against_datajson(raw, metrics_setup, data, lang):
    """The pooled max/mean per checkpoint must reproduce data.json exactly."""
    models = data["languages"][lang]["models"]
    checked = mismatches = 0
    for model, shots in raw.items():
        for shot, ckpts in shots.items():
            for tok, tasks in ckpts.items():
                stored_ck = models[model]["progress"].get(tok)
                if stored_ck is None:
                    continue
                for task, recs in tasks.items():
                    entry = stored_ck.get(task, {}).get(shot, {})
                    main = metrics_setup[task]["main_metric"]
                    if main not in entry:
                        continue
                    vals = [r[2][main] for r in recs if main in r[2]]
                    if not vals:
                        continue
                    for agg_name, mine in (("max", max(vals)),
                                           ("mean", sum(vals) / len(vals))):
                        stored = entry[main].get(agg_name)
                        checked += 1
                        if stored is None or abs(round(mine, 6) - stored) > 1e-6:
                            mismatches += 1
                            if mismatches <= 5:
                                print(f"  MISMATCH {model}/{shot}/{tok}/{task} "
                                      f"{agg_name}: mine={mine:.6f} stored={stored}")
    print(f"Verification vs data.json: {checked} comparisons, {mismatches} mismatches")
    return mismatches == 0


# ─────────────────────────────────────────────────────────────
# Parallel-coordinates plot
# ─────────────────────────────────────────────────────────────

METRIC_SPECS = [
    ("monotonicity", "Monotonicity",
     "Spearman ρ (tokens vs. score) per model → median over models → mean over tasks"),
    ("non_randomness", "Non-randomness",
     "max score − random baseline (pp) per model → median over models → mean over tasks"),
    ("consistency", "Ranking consistency",
     "mean Kendall τ between successive checkpoint model rankings → mean over tasks"),
]


def plot_parallel_coordinates(rows, metric, title, subtitle, out_path,
                              dimensions, lang):
    rows = [r for r in rows if r[metric] is not None]
    values = np.array([r[metric] for r in rows])
    vmin, vmax = values.min(), values.max()
    norm = mcolors.Normalize(vmin=vmin, vmax=vmax)
    cmap = plt.colormaps["coolwarm"]

    n_axes = len(dimensions) + 1  # + numeric metric axis
    fig, ax = plt.subplots(figsize=(13, 6.5))

    # y position on each categorical axis: category slot + a small fan spread
    # ordered by metric value, so the coolwarm gradient stays visible inside
    # each bundle of coincident lines.
    ys = np.zeros((len(rows), n_axes))
    for a, (dim, levels) in enumerate(dimensions):
        slots = np.linspace(0.08, 0.92, len(levels))
        for li, level in enumerate(levels):
            idx = [i for i, r in enumerate(rows) if r[dim] == level]
            order = sorted(idx, key=lambda i: values[i])
            spread = np.linspace(-0.045, 0.045, len(order)) if len(order) > 1 else [0.0]
            for off, i in zip(spread, order):
                ys[i, a] = slots[li] + off
    ys[:, -1] = (values - vmin) / (vmax - vmin) if vmax > vmin else 0.5

    x = np.arange(n_axes)
    draw_order = np.argsort(values)  # best (warm) lines on top
    segments = [np.column_stack([x, ys[i]]) for i in draw_order]
    lc = LineCollection(segments, cmap=cmap, norm=norm, alpha=0.6, linewidths=1.4)
    lc.set_array(values[draw_order])
    ax.add_collection(lc)

    for a in range(n_axes):
        ax.axvline(a, color="#c8cdd4", linewidth=1.0, zorder=0)
    for a, (dim, levels) in enumerate(dimensions):
        slots = np.linspace(0.08, 0.92, len(levels))
        for li, level in enumerate(levels):
            ax.annotate(level, (a, slots[li]), xytext=(0, 10), textcoords="offset points",
                        ha="center", va="bottom", fontsize=9, color="#374151",
                        bbox=dict(boxstyle="round,pad=0.22", fc="white",
                                  ec="#d6dade", lw=0.7, alpha=0.95), zorder=5)
        ax.annotate(dim, (a, -0.05), ha="center", va="top", fontsize=10.5,
                    color="#111827", fontweight="bold", annotation_clip=False)
    # numeric axis ticks
    for frac in np.linspace(0, 1, 5):
        val = vmin + frac * (vmax - vmin)
        ax.annotate(f"{val:.2f}", (n_axes - 1, frac), xytext=(8, 0),
                    textcoords="offset points", ha="left", va="center",
                    fontsize=8.5, color="#6b7280")
    ax.annotate(title, (n_axes - 1, -0.05), ha="center", va="top", fontsize=10.5,
                color="#111827", fontweight="bold", annotation_clip=False)

    ax.set_xlim(-0.35, n_axes - 0.45)
    ax.set_ylim(-0.02, 1.06)
    ax.axis("off")

    fig.subplots_adjust(top=0.84, bottom=0.07, left=0.02, right=0.96)
    cbar = fig.colorbar(cm.ScalarMappable(norm=norm, cmap=cmap), ax=ax,
                        fraction=0.03, pad=0.05)
    cbar.set_label(title, fontsize=9.5)
    cbar.ax.tick_params(labelsize=8.5)
    cbar.outline.set_visible(False)

    fig.text(0.02, 0.955, f"{title} — MultiSynt {lang.replace('_', ' ')}",
             fontsize=15, fontweight="bold", color="#111827", va="top")
    fig.text(0.02, 0.905, subtitle + f"   ·   window {WINDOW_MIN}–{WINDOW_MAX}B tokens",
             fontsize=9.5, color="#6b7280", va="top")
    fig.savefig(out_path, dpi=180)
    plt.close(fig)
    print(f"  wrote {out_path}")


# ─────────────────────────────────────────────────────────────
# Metric-type study: accuracy vs. norm_loglikelihood_corr
# ─────────────────────────────────────────────────────────────
#
# Restricted to tasks reporting norm_loglikelihood_corr (all classification,
# so the Evaluation-type axis is dropped). The Normalization axis is replaced
# by a "Metric type" axis: Accuracy uses the character norm (acc_norm) where
# the task has it, falling back to the task's main metric; Loglikelihood uses
# norm_loglikelihood_corr directly. Non-randomness is excluded — it needs a
# random baseline, which only exists on the accuracy scale (the log-likelihood
# scale is unbounded), while Spearman/Kendall are rank-based and unaffected.

def ll_task_qualifies(raw, task):
    """True when every model that runs `task` reports norm_loglikelihood_corr
    on at least half of its checkpoints. metrics_setup's available_metrics is a
    union over models, so it alone overstates coverage — in French/Spanish only
    two corpora ever report the metric, which would break the cross-model
    consistency criterion and reduce the medians to 1–2 models."""
    for shots in raw.values():
        for ckpts in shots.values():
            recs_per_ckpt = [tasks[task] for tasks in ckpts.values() if task in tasks]
            if not recs_per_ckpt:
                continue
            with_ll = sum(1 for recs in recs_per_ckpt
                          if any("norm_loglikelihood_corr" in r[2] for r in recs))
            if with_ll < len(recs_per_ckpt) * 0.5:
                return False
    return True


def metric_type_dimensions(metrics_setup, ll_tasks):
    dims = [
        ("Shots", ["0-shot", "5-shot"]),
        ("Prompt aggregation", ["Single", "Average", "Max"]),
        ("Metric type", ["Accuracy", "Loglikelihood"]),
    ]
    forms = sorted({f for t in ll_tasks
                    for f in metrics_setup[t].get("formulations", [])})
    if forms:
        dims.append(("MC formulation",
                     [FORM_LABEL[f] for f in ("cf", "mcf", "hybrid") if f in forms]
                     + ["Max"]))
    return dims


def sweep_metric_type(raw, metrics_setup, ll_tasks, dims):
    task_data, memo, rows = {}, {}, []
    dim_names = [d for d, _ in dims]
    for combo in itertools.product(*[levels for _, levels in dims]):
        cfg = dict(zip(dim_names, combo))
        shot = SHOT_VAL[cfg["Shots"]]
        agg = AGG_VAL[cfg["Prompt aggregation"]]
        form = FORM_VAL[cfg.get("MC formulation", "Max")]
        acc = [[], []]
        for t in ll_tasks:
            if (t, shot) not in task_data:
                task_data[(t, shot)] = TaskData(raw, t, shot, metrics_setup[t])
            td = task_data[(t, shot)]
            if cfg["Metric type"] == "Loglikelihood":
                norm_eff = "loglik"
            else:
                norm_eff = "char" if td.has_acc_norm else "main"
            form_eff = form if (td.has_forms and form != "max") else "pooled"
            key = (t, shot, agg, norm_eff, form_eff)
            if key not in memo:
                memo[key] = task_criteria(td, agg, norm_eff, form_eff)
            mono, _, cons = memo[key]
            if mono is not None:
                acc[0].append(mono)
            if cons is not None:
                acc[1].append(cons)
        rows.append({
            **cfg,
            "monotonicity": sum(acc[0]) / len(acc[0]) if acc[0] else None,
            "consistency": sum(acc[1]) / len(acc[1]) if acc[1] else None,
        })
    return rows


def run_language(lang, data, rebuild):
    print(f"\n=== {lang} ===")
    raw = load_raw(lang, rebuild)
    metrics_setup = data["languages"][lang]["metrics_setup"]
    verify_against_datajson(raw, metrics_setup, data, lang)

    dims = lang_dimensions(metrics_setup)
    print(f"Sweeping configurations ({' × '.join(d for d, _ in dims)}) ...")
    rows = sweep(raw, metrics_setup, dims)

    csv_file = ANALYSIS_DIR / f"eval_choice_results_{lang.lower()}.csv"
    with open(csv_file, "w") as f:
        dim_names = [d for d, _ in dims]
        f.write(",".join(dim_names + [m for m, _, _ in METRIC_SPECS]) + "\n")
        for r in rows:
            f.write(",".join([str(r[d]) for d in dim_names]
                             + [f"{r[m]:.4f}" if r[m] is not None else ""
                                for m, _, _ in METRIC_SPECS]) + "\n")
    print(f"Wrote {csv_file} ({len(rows)} configurations)")

    slug = lang.lower()
    for metric, title, subtitle in METRIC_SPECS:
        out = PLOTS_DIR / f"parallel_coordinates_{slug}_{metric}.png"
        plot_parallel_coordinates(rows, metric, title, subtitle, out, dims, lang)

    # Second set: all tasks ("Both") only, without the Evaluation-type axis.
    both_rows = [r for r in rows if r["Evaluation type"] == "Both"]
    both_dims = [d for d in dims if d[0] != "Evaluation type"]
    for metric, title, subtitle in METRIC_SPECS:
        out = PLOTS_DIR / f"parallel_coordinates_{slug}_{metric}_all_tasks.png"
        plot_parallel_coordinates(both_rows, metric, title,
                                  subtitle + "   ·   all tasks", out,
                                  both_dims, lang)

    # Third set: accuracy vs. norm_loglikelihood_corr on LL-capable tasks.
    ll_tasks = [t for t, i in metrics_setup.items()
                if "norm_loglikelihood_corr" in i.get("available_metrics", [])
                and ll_task_qualifies(raw, t)]
    if not ll_tasks:
        print("No task has norm_loglikelihood_corr across all models — "
              "skipping the metric-type study")
        return
    mt_dims = metric_type_dimensions(metrics_setup, ll_tasks)
    print(f"Sweeping metric-type study ({len(ll_tasks)} LL-capable tasks, "
          f"{' × '.join(d for d, _ in mt_dims)}) ...")
    mt_rows = sweep_metric_type(raw, metrics_setup, ll_tasks, mt_dims)

    mt_csv = ANALYSIS_DIR / f"eval_choice_results_{slug}_metric_type.csv"
    with open(mt_csv, "w") as f:
        dim_names = [d for d, _ in mt_dims]
        f.write(",".join(dim_names + ["monotonicity", "consistency"]) + "\n")
        for r in mt_rows:
            f.write(",".join([str(r[d]) for d in dim_names]
                             + [f"{r[m]:.4f}" if r[m] is not None else ""
                                for m in ("monotonicity", "consistency")]) + "\n")
    print(f"Wrote {mt_csv} ({len(mt_rows)} configurations)")

    for metric, title, subtitle in METRIC_SPECS:
        if metric == "non_randomness":
            continue  # needs a random baseline; undefined on the LL scale
        out = PLOTS_DIR / f"parallel_coordinates_{slug}_{metric}_metric_type.png"
        plot_parallel_coordinates(mt_rows, metric, title,
                                  subtitle + "   ·   tasks with norm_loglikelihood_corr",
                                  out, mt_dims, lang)


def main():
    rebuild = "--rebuild" in sys.argv
    data = json.loads((BASE_DIR / "docs" / "multisynt" / "data.json").read_text())
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)
    for lang in LANGUAGES:
        run_language(lang, data, rebuild)


if __name__ == "__main__":
    main()
