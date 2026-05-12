#!/usr/bin/env python3
"""Detect corrupt or empty result JSON files in NorOLMo_progress/.

Checks all results_*.json files for:
  1. Empty files (0 bytes)
  2. Invalid JSON (parse errors)
  3. Missing expected top-level keys (results, config)
  4. Empty results dict

Prints a summary suitable for identifying which evaluations need to be re-run.
"""

import json
import os
import glob
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROGRESS_DIR = os.path.join(BASE_DIR, "data", "norolmo", "progress")
RESULTS_DIR = os.path.join(BASE_DIR, "data", "noreval", "results")
INSTRUCT_DIR = os.path.join(BASE_DIR, "data", "noreval-gen", "results")


def check_results_file(filepath):
    """Check a single results JSON file. Returns (issue_description,) or None."""
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

    Returns list of (relative_path, issue_description).
    """
    issues = []
    pattern = os.path.join(base_path, "**", "results_*.json")
    for filepath in sorted(glob.glob(pattern, recursive=True)):
        issue = check_results_file(filepath)
        if issue:
            rel = os.path.relpath(filepath, BASE_DIR)
            issues.append((rel, issue))
    return issues


def parse_ablation_info(rel_path):
    """Extract (checkpoint_dir, benchmark, shot) from a relative path."""
    parts = rel_path.split(os.sep)
    # e.g. NorOLMo_progress/NorOLMo-stage3-rope-scaling-step-31000/slide/5-shot/.../results_*.json
    if len(parts) >= 4:
        return parts[1], parts[2], parts[3]
    return rel_path, "", ""


def main():
    found_issues = False

    for label, directory in [("data/norolmo/progress", PROGRESS_DIR), ("data/noreval/results", RESULTS_DIR), ("data/noreval-gen/results", INSTRUCT_DIR)]:
        if not os.path.isdir(directory):
            continue

        issues = scan_directory(directory)
        if issues:
            found_issues = True
            print(f"=== Corrupt files in {label}/ ({len(issues)} found) ===\n")
            for rel_path, issue in issues:
                ckpt, bench, shot = parse_ablation_info(rel_path)
                print(f"  {ckpt}  {bench}/{shot}  — {issue}")
                print(f"    {rel_path}")
            print()

            # Summary: group by checkpoint for easy re-run
            print(f"--- Re-run summary ({label}) ---")
            by_checkpoint = {}
            for rel_path, issue in issues:
                ckpt, bench, shot = parse_ablation_info(rel_path)
                by_checkpoint.setdefault(ckpt, []).append((bench, shot))
            for ckpt, entries in sorted(by_checkpoint.items()):
                tasks = ", ".join(f"{b} ({s})" for b, s in entries)
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
