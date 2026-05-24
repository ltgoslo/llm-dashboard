"""Check for missing evaluation results across all models and checkpoints.

Reads metrics_setup.yaml as the canonical list of expected benchmarks,
then checks that every model/checkpoint has all benchmarks x shot settings
with valid results JSON files containing the expected main_metric.
"""

import os
import glob
import json

import yaml

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SHOT_SETTINGS = ["0-shot", "1-shot", "5-shot"]


def load_metrics_setup():
    """Load benchmark definitions from metrics_setup.yaml."""
    path = os.path.join(BASE_DIR, "metrics_setup.yaml")
    with open(path) as f:
        return yaml.safe_load(f)


def find_results_json(path, latest_only=False):
    """Find results_*.json files under path. If latest_only, return only the newest."""
    files = glob.glob(os.path.join(path, "**", "results_*.json"), recursive=True)
    if latest_only and len(files) > 1:
        files.sort(key=os.path.getmtime)
        return [files[-1]]
    return files


def check_model_dir(model_path, benchmarks):
    """Check a single model directory for missing benchmarks/shots."""
    missing = []
    for benchmark in benchmarks:
        bench_path = os.path.join(model_path, benchmark)
        if not os.path.isdir(bench_path):
            missing.append((benchmark, "ALL", "benchmark directory missing"))
            continue
        for shot in SHOT_SETTINGS:
            shot_path = os.path.join(bench_path, shot)
            if not os.path.isdir(shot_path):
                missing.append((benchmark, shot, "shot directory missing"))
                continue
            results = find_results_json(shot_path)
            if not results:
                missing.append((benchmark, shot, "no results JSON found"))
    return missing


def check_main_metrics(base_paths, metrics_setup):
    """Check that each results JSON contains its expected main_metric.

    For benchmarks with subtasks (e.g. noreval_multiblimp), also checks
    that all expected subtask entries are present in the results.
    """
    issues = []
    for base_path in base_paths:
        if not os.path.isdir(base_path):
            continue
        for model_dir in sorted(os.listdir(base_path)):
            model_path = os.path.join(base_path, model_dir)
            if not os.path.isdir(model_path):
                continue
            for benchmark, config in metrics_setup.items():
                main_metric = config["main_metric"]
                metric_key = f"{main_metric},none"
                subtasks = config.get("subtasks", {})
                bench_path = os.path.join(model_path, benchmark)
                if not os.path.isdir(bench_path):
                    continue
                for shot in SHOT_SETTINGS:
                    shot_path = os.path.join(bench_path, shot)
                    if not os.path.isdir(shot_path):
                        continue
                    for results_file in find_results_json(shot_path, latest_only=True):
                        try:
                            with open(results_file) as f:
                                data = json.load(f)
                            results = data.get("results", {})

                            # Check main_metric in all result entries
                            for task_name, task_results in results.items():
                                if metric_key not in task_results:
                                    issues.append((
                                        model_dir, benchmark, shot, task_name,
                                        f"missing {metric_key}",
                                    ))

                            # For benchmarks with subtasks, check each expected subtask
                            if subtasks:
                                for subtask_key in subtasks:
                                    full_key = f"{benchmark}_{subtask_key}"
                                    if full_key not in results:
                                        issues.append((
                                            model_dir, benchmark, shot, full_key,
                                            "missing subtask entry",
                                        ))
                        except Exception as e:
                            issues.append((
                                model_dir, benchmark, shot, results_file,
                                f"error reading JSON: {e}",
                            ))
    return issues


def main():
    metrics_setup = load_metrics_setup()
    benchmarks = sorted(metrics_setup.keys())
    found_issues = False

    # Check data/noreval/results/ (base models) and data/noreval-gen/results/ (instruct)
    results_dir = os.path.join(BASE_DIR, "data", "noreval", "results")
    instruct_dir = os.path.join(BASE_DIR, "data", "noreval-gen", "results")
    for label, rdir in [("data/noreval/results", results_dir), ("data/noreval-gen/results", instruct_dir)]:
        if not os.path.isdir(rdir):
            continue
        models = sorted(os.listdir(rdir))
        print(f"=== {label} ({len(models)} models, {len(benchmarks)} expected benchmarks) ===\n")
        for model in models:
            model_path = os.path.join(rdir, model)
            if not os.path.isdir(model_path):
                continue
            missing = check_model_dir(model_path, benchmarks)
            if missing:
                found_issues = True
                print(f"  {model}:")
                for bench, shot, reason in missing:
                    print(f"    MISSING: {bench} / {shot} — {reason}")
                print()
            else:
                print(f"  {model}: OK ({len(benchmarks)} benchmarks x {len(SHOT_SETTINGS)} shots)")

    exit()

    # Check data/norolmo/progress/ (training checkpoints)
    progress_dir = os.path.join(BASE_DIR, "data", "norolmo", "progress")
    if os.path.isdir(progress_dir):
        checkpoints = sorted(
            os.listdir(progress_dir),
            key=lambda x: int(x.split("-")[-1]) if x.split("-")[-1].isdigit() else 0,
        )
        print(f"\n=== data/norolmo/progress/ ({len(checkpoints)} checkpoints) ===\n")
        for ckpt in checkpoints:
            ckpt_path = os.path.join(progress_dir, ckpt)
            if not os.path.isdir(ckpt_path):
                continue
            missing = check_model_dir(ckpt_path, benchmarks)
            if missing:
                found_issues = True
                print(f"  {ckpt}:")
                for bench, shot, reason in missing:
                    print(f"    MISSING: {bench} / {shot} — {reason}")
                print()
            else:
                print(f"  {ckpt}: OK")

    # Check that main_metric exists in every results JSON
    print(f"\n=== main_metric integrity check ===\n")
    base_paths = [results_dir, instruct_dir, progress_dir]
    metric_issues = check_main_metrics(base_paths, metrics_setup)
    if metric_issues:
        found_issues = True
        for model, bench, shot, task, reason in metric_issues:
            print(f"  {model} / {bench} / {shot} / {task} — {reason}")
    else:
        print("  All results contain their expected main_metric.")

    if not found_issues:
        print("\n\nAll evaluations complete!")
    else:
        print("\n\nSome evaluations are missing (see above).")


if __name__ == "__main__":
    main()
