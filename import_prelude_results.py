#!/usr/bin/env python3
"""Import an OpenEuroLLM Prelude NorEval-1.2 results dump into data/prelude/.

The evaluation pipeline delivers one JSONL file in which every line is a
complete lm-eval results document (what lm-eval itself writes as
results_<date>.json), covering all prompt/formulation variants of one task
for one checkpoint. This script fans the lines out into the layout that
build_data.py reads:

    data/prelude/progress/<branch>/<task>/results_<date>.json

<branch> is the Hugging Face branch of openeurollm/prelude the checkpoint
was downloaded from (`iter_0002400`, `anneal300b_iter_0955200`, ...). The
lines only record the snapshot commit hash of that download (in
`model_name`), so hashes are resolved through data/prelude/checkpoints.json,
a committed hash -> branch map that is extended from the Hugging Face refs
API whenever an unknown hash turns up.

Usage:
    python3 import_prelude_results.py results.jsonl [more.jsonl ...]
        [--repo openeurollm/prelude] [--overwrite]

Importing the same dump twice is a no-op. A file whose on-disk content
differs from the line being imported is reported and left alone unless
--overwrite is given.
"""

import argparse
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).parent
PRELUDE_DIR = BASE_DIR / "data" / "prelude"
PROGRESS_DIR = PRELUDE_DIR / "progress"
CHECKPOINTS_JSON = PRELUDE_DIR / "checkpoints.json"
DEFAULT_REPO = "openeurollm/prelude"

SNAPSHOT_RE = re.compile(r"snapshots/([0-9a-f]{40})")
VARIANT_SUFFIX_RE = re.compile(r"(?:_(?:cf|mcf|hybrid))?_p\d+$")


def load_checkpoint_map():
    if CHECKPOINTS_JSON.is_file():
        with open(CHECKPOINTS_JSON) as f:
            return json.load(f)
    return {}


def save_checkpoint_map(mapping):
    CHECKPOINTS_JSON.parent.mkdir(parents=True, exist_ok=True)
    ordered = dict(sorted(mapping.items(), key=lambda kv: (kv[1], kv[0])))
    with open(CHECKPOINTS_JSON, "w") as f:
        json.dump(ordered, f, indent=2)
        f.write("\n")


def fetch_branch_map(repo):
    """{commit hash: branch/tag name} from the Hugging Face refs API."""
    url = f"https://huggingface.co/api/models/{repo}/refs"
    with urllib.request.urlopen(url, timeout=60) as resp:
        refs = json.load(resp)
    out = {}
    for kind in ("branches", "tags"):
        for ref in refs.get(kind, []):
            out[ref["targetCommit"]] = ref["name"]
    return out


def checkpoint_of(line):
    """(kind, id) of the checkpoint a line was evaluated on: ("branch", name)
    when the model was loaded by revision, else ("hash", commit) taken from
    the snapshot path in model_name."""
    revision = (line.get("config") or {}).get("model_revision")
    if revision and revision != "main":
        return "branch", revision
    m = SNAPSHOT_RE.search(line.get("model_name") or "")
    if m:
        return "hash", m.group(1)
    raise ValueError(
        f"cannot identify the checkpoint of model_name={line.get('model_name')!r}"
    )


def task_of(line):
    """The task a line covers: its lm-eval group, else the common base of its
    `<task>[_<form>]_p<N>` result keys."""
    groups = line.get("groups") or {}
    if len(groups) == 1:
        return next(iter(groups))
    bases = {VARIANT_SUFFIX_RE.sub("", k) for k in line.get("results", {})}
    if len(bases) == 1:
        return bases.pop()
    raise ValueError(f"line covers several tasks: {sorted(bases)}")


def results_filename(line):
    stamp = datetime.fromtimestamp(float(line["date"]), tz=timezone.utc)
    return f"results_{stamp:%Y-%m-%dT%H-%M-%S.%f}.json"


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("jsonl", nargs="+", type=Path, help="results dump(s) to import")
    ap.add_argument("--repo", default=DEFAULT_REPO, help="HF repo whose refs name the checkpoints")
    ap.add_argument("--overwrite", action="store_true", help="replace files that differ on disk")
    args = ap.parse_args()

    lines = []
    for path in args.jsonl:
        with open(path, encoding="utf-8") as f:
            for n, raw in enumerate(f, 1):
                if raw.strip():
                    lines.append((f"{path}:{n}", json.loads(raw)))

    # Resolve every snapshot hash to its branch, extending the cached map.
    mapping = load_checkpoint_map()
    ids = [checkpoint_of(line) for _, line in lines]
    unknown = {h for kind, h in ids if kind == "hash" and h not in mapping}
    if unknown:
        print(f"Resolving {len(unknown)} unknown snapshot hash(es) via {args.repo} refs ...")
        try:
            fetched = fetch_branch_map(args.repo)
        except Exception as e:  # noqa: BLE001 — any network/HTTP failure is fatal here
            sys.exit(f"cannot fetch the refs of {args.repo}: {e}")
        for h in unknown:
            if h in fetched:
                mapping[h] = fetched[h]
        still = sorted(unknown - mapping.keys())
        if still:
            sys.exit(
                "no branch points at these snapshot hashes; add them to "
                f"{CHECKPOINTS_JSON.relative_to(BASE_DIR)} by hand:\n  " + "\n  ".join(still)
            )
        save_checkpoint_map(mapping)

    written = skipped = 0
    conflicts = []
    per_branch = {}
    for (where, line), (kind, ident) in zip(lines, ids):
        branch = ident if kind == "branch" else mapping[ident]
        task = task_of(line)
        out = PROGRESS_DIR / branch / task / results_filename(line)
        content = json.dumps(line, indent=2, ensure_ascii=False) + "\n"
        per_branch.setdefault(branch, set()).add(task)
        if out.exists():
            if out.read_text(encoding="utf-8") == content:
                skipped += 1
                continue
            if not args.overwrite:
                conflicts.append((where, out))
                continue
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(content, encoding="utf-8")
        written += 1

    for branch in sorted(per_branch):
        print(f"  {branch}: {len(per_branch[branch])} tasks")
    print(f"{written} file(s) written, {skipped} already up to date, {len(conflicts)} conflict(s)")
    for where, out in conflicts:
        print(f"  differs on disk (use --overwrite): {out.relative_to(BASE_DIR)}  <- {where}")
    if conflicts:
        sys.exit(1)


if __name__ == "__main__":
    main()
