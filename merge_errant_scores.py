#!/usr/bin/env python3
"""Merge ASK-GEC ERRANT scores into their corresponding lm-eval results JSONs.

The lm-eval harness emits the ASK-GEC `exact_match` metric in
`results_*.json`, but the real task metric (ERRANT F0.5) is computed by an
external scorer and saved alongside as `samples_<task>_<partition>_<...>_errant.json`
containing `{"errant": <value>}`.

This script walks every `samples_*_errant.json` under `results/Norwegian/**/ask_gec/`
and merges the ERRANT score into the corresponding `results_*.json` as
`errant,none` under the task's results entry. Idempotent.
"""

import json
import os
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent
ASK_GEC_GLOB = "data/multisynt/results/Norwegian/**/ask_gec/**/samples_*_errant.json"


def find_results_json(directory):
    """Find the (single) results_*.json in a directory."""
    candidates = sorted(p for p in os.listdir(directory) if p.startswith("results_") and p.endswith(".json"))
    if not candidates:
        return None
    if len(candidates) > 1:
        # Pick the newest by filename (timestamp embedded)
        return os.path.join(directory, candidates[-1])
    return os.path.join(directory, candidates[0])


def task_key_from_errant_filename(filename):
    """`samples_ask_gec_p0_2026-04-24T11-56-47.328995_errant.json`
    -> `ask_gec_p0`
    """
    base = os.path.basename(filename)
    assert base.startswith("samples_") and base.endswith("_errant.json"), base
    middle = base[len("samples_"):-len("_errant.json")]
    # middle is like "ask_gec_p0_2026-04-24T11-56-47.328995"
    # The task key is everything up to and including the partition (e.g. p0)
    parts = middle.split("_")
    # Find the partition token (pN where N is digits)
    for i, tok in enumerate(parts):
        if tok.startswith("p") and tok[1:].isdigit():
            return "_".join(parts[: i + 1])
    raise ValueError(f"Could not find partition token in {base}")


def merge_one(errant_path):
    """Merge a single errant file into its sibling results_*.json.

    Returns one of: "merged", "skipped" (already present and matches),
    "missing" (no results_*.json found), "noentry" (task key absent in results).
    """
    with open(errant_path) as f:
        errant_data = json.load(f)
    if "errant" not in errant_data:
        print(f"  WARNING: no 'errant' key in {errant_path}", file=sys.stderr)
        return "missing"
    errant_value = errant_data["errant"]

    directory = os.path.dirname(errant_path)
    results_path = find_results_json(directory)
    if results_path is None:
        print(f"  WARNING: no results_*.json next to {errant_path}", file=sys.stderr)
        return "missing"

    task_key = task_key_from_errant_filename(errant_path)

    with open(results_path) as f:
        results_data = json.load(f)

    task_results = results_data.get("results", {}).get(task_key)
    if task_results is None:
        print(f"  WARNING: task key {task_key!r} missing in {results_path}", file=sys.stderr)
        return "noentry"

    existing = task_results.get("errant,none")
    if existing == errant_value:
        return "skipped"

    task_results["errant,none"] = errant_value
    # Mark stderr as deterministic-from-scorer; build_data.py treats numeric
    # stderr verbatim and won't try to estimate one.
    task_results["errant_stderr,none"] = 0.0

    higher = results_data.setdefault("higher_is_better", {}).setdefault(task_key, {})
    higher.setdefault("errant", True)

    with open(results_path, "w") as f:
        json.dump(results_data, f, ensure_ascii=False)

    return "merged"


def main():
    import glob

    pattern = str(BASE_DIR / ASK_GEC_GLOB)
    errant_files = sorted(glob.glob(pattern, recursive=True))
    print(f"Found {len(errant_files)} ASK-GEC errant files")

    counts = {"merged": 0, "skipped": 0, "missing": 0, "noentry": 0}
    for ef in errant_files:
        status = merge_one(ef)
        counts[status] = counts.get(status, 0) + 1

    print("\nSummary:")
    for k, v in counts.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
