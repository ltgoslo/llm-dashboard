#!/usr/bin/env python3
"""Detect corrupt or empty result JSON files across data/<dashboard>/.

Checks all results.json and results_*.json files for:
  1. Empty files (0 bytes)
  2. Invalid JSON (parse errors)
  3. Missing expected top-level keys (results)
  4. Empty results dict

Prints a summary suitable for identifying which evaluations need to be re-run.
"""

import json
import os
import glob
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SCAN_DIRS = [
    ("data/norolmo/progress", os.path.join(BASE_DIR, "data", "norolmo", "progress")),
    ("data/noreval/results", os.path.join(BASE_DIR, "data", "noreval", "results")),
    ("data/noreval-gen/results", os.path.join(BASE_DIR, "data", "noreval-gen", "results")),
    ("data/prelude/progress", os.path.join(BASE_DIR, "data", "prelude", "progress")),
    ("data/norprelude/progress", os.path.join(BASE_DIR, "data", "norprelude", "progress")),
    ("data/multisynt/results", os.path.join(BASE_DIR, "data", "multisynt", "results")),
]


def check_results_file(filepath):
    """Check a single results JSON file. Returns issue_description or None."""
    size = os.path.getsize(filepath)
    if size == 0:
        return "empty file (0 bytes)"

    try:
        with open(filepath) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        return f"invalid JSON: {e}"

    if not isinstance(data, dict):
        return f"unexpected top-level type: {type(data).__name__}"

    if "results" not in data:
        return "missing 'results' key"

    if not data["results"]:
        return "empty 'results' dict"

    return None


def scan_directory(base_path):
    """Scan a directory tree for corrupt result files.

    Returns list of (path_relative_to_base_path, path_relative_to_repo, issue_description).
    """
    issues = []
    seen = set()
    for pat in ("results.json", "results_*.json"):
        pattern = os.path.join(base_path, "**", pat)
        for filepath in sorted(glob.glob(pattern, recursive=True)):
            if filepath in seen:
                continue
            seen.add(filepath)
            issue = check_results_file(filepath)
            if issue:
                rel_base = os.path.relpath(filepath, base_path)
                rel_repo = os.path.relpath(filepath, BASE_DIR)
                issues.append((rel_base, rel_repo, issue))
    return issues


def parse_ablation_info(rel_to_root):
    """Extract (checkpoint_dir, benchmark, shot) from a path relative to a scan root."""
    parts = rel_to_root.split(os.sep)
    # e.g. NorOLMo-stage3-rope-scaling-step-31000/slide/5-shot/.../results_*.json
    if len(parts) >= 3:
        return parts[0], parts[1], parts[2]
    if len(parts) == 2:
        return parts[0], parts[1], ""
    return rel_to_root, "", ""


def main():
    found_issues = False

    for label, directory in SCAN_DIRS:
        if not os.path.isdir(directory):
            continue

        issues = scan_directory(directory)
        if issues:
            found_issues = True
            print(f"=== Corrupt files in {label}/ ({len(issues)} found) ===\n")
            for rel_base, rel_repo, issue in issues:
                ckpt, bench, shot = parse_ablation_info(rel_base)
                loc = f"{bench}/{shot}" if shot else bench
                print(f"  {ckpt}  {loc}  — {issue}")
                print(f"    {rel_repo}")
            print()

            # Summary: group by checkpoint for easy re-run
            print(f"--- Re-run summary ({label}) ---")
            by_checkpoint = {}
            for rel_base, _, _ in issues:
                ckpt, bench, shot = parse_ablation_info(rel_base)
                by_checkpoint.setdefault(ckpt, []).append((bench, shot))
            for ckpt, entries in sorted(by_checkpoint.items()):
                tasks = ", ".join(f"{b} ({s})" if s else b for b, s in entries)
                print(f"  {ckpt}: {tasks}")
            print()
        else:
            print(f"=== {label}/: all result files OK ===\n")

    if not found_issues:
        print("No corrupt result files found.")
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
