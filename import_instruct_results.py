#!/usr/bin/env python3
"""Import a NorEval Instruct run export into data/instruct/.

The instruct evaluation (generative NorEval v1.3 for instruction-tuned
models, graded by an LLM judge) exports one Parquet file per model,
export/models/<model>.parquet: one row per judgment unit (a task's draw:
an item and a prompt variant), with the prompt, the model's response, the
judge's output and score; the file's schema metadata (key
`noreval_instruct`) describes the run and holds the model's results. The
files are large (32 tasks × 1,000 judged responses, up to ~140 MB each),
so the repository keeps an extract of them, which build_data.py reads:

    data/instruct/run.json              the run: its settings and tasks, the
                                        judge and its prompt, the columns
    data/instruct/draws.json            each task's draws: item and prompt
                                        variant (the same for every model)
    data/instruct/examples/<task>.json  the task's first EXAMPLES draws: the
                                        prompt and the reference (the same
                                        for every model)
    data/instruct/results/<model>.json  the model's results as the export
                                        computed them (from all draws), and
                                        the judge's score of every draw
    data/instruct/responses/<model>/<task>.json
                                        the model's responses to the task's
                                        first EXAMPLES draws and their
                                        judgments (the page reads these
                                        files as they are: build_data.py
                                        copies them, so git keeps one copy)

Every score the dashboard shows comes from all draws; only the responses
and judgments are cut to EXAMPLES per task. Draws are i.i.d. samples of a
task's items and prompt variants, made once for the run, so the first
EXAMPLES draws are a random sample, and the same prompts for every model.

Usage:
    python3 import_instruct_results.py results-instruct.zip
    python3 import_instruct_results.py export/models/ [more.parquet ...]

A zip is read in place (its */models/*.parquet members); a directory is
searched for *.parquet files. A model's files are replaced by every
import. A model from another run (other seed, draws, judge or rubric) is
refused: its examples would not be the same prompts.
"""

import argparse
import json
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

import pyarrow.parquet as pq

BASE_DIR = Path(__file__).parent
OUT_DIR = BASE_DIR / "data" / "instruct"
EXAMPLES = 32
METADATA_KEY = b"noreval_instruct"

# The run settings every imported model must share with data/instruct/run.json.
RUN_KEYS = ("seed", "n", "replicates", "judges", "rubric", "formulations", "noreval", "tasks")

# What the extract keeps of a row: shared by every model (examples/) and the
# model's own (responses/). Nothing else of a row is kept but its judge score.
SHARED_COLUMNS = ("draw", "doc_index", "doc_fingerprint", "prompt_variant", "formulation",
                  "language", "source_language", "prompt", "reference", "reference_text")
RESPONSE_COLUMNS = ("draw", "response_thinking", "response_answer", "response_finish_reason",
                    "response_finished_thinking", "response_output_tokens", "judge_auto",
                    "judged_response_cut", "judge_output", "judge_points")
COLUMNS = sorted(set(SHARED_COLUMNS + RESPONSE_COLUMNS) | {"task", "thinking"})


def write_json(path, data, one_line_each=False):
    """`data` as JSON; with `one_line_each`, a dict with each of its values
    on one line (long lists of numbers)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        if one_line_each:
            f.write("{\n" + ",\n".join(
                f"{json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False, separators=(',', ':'))}"
                for k, v in data.items()) + "\n}\n")
        else:
            json.dump(data, f, ensure_ascii=False, indent=1)
            f.write("\n")


def write_responses(path, model, task, examples):
    """A model's responses to a task's examples: compact JSON (the page
    reads the file as it is), one example per line."""
    path.parent.mkdir(parents=True, exist_ok=True)
    head = json.dumps({"model": model, "task": task}, ensure_ascii=False, separators=(",", ":"))[:-1]
    lines = ",\n".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in examples)
    with open(path, "w") as f:
        f.write(head + ',"examples":[\n' + lines + "\n]}\n")


def read_json(path):
    if not path.is_file():
        return None
    with open(path) as f:
        return json.load(f)


def nonempty(v):
    """A string column's value, or None for an empty or missing one."""
    return v if isinstance(v, str) and v != "" else None


def parquet_sources(args, tmp):
    """(label, path) of every Parquet file the arguments name; a zip's
    members are extracted into `tmp`, one at a time as they are read."""
    for arg in args:
        p = Path(arg)
        if p.is_dir():
            for f in sorted(p.rglob("*.parquet")):
                yield str(f), f
        elif p.suffix == ".zip":
            with zipfile.ZipFile(p) as zf:
                names = sorted(n for n in zf.namelist()
                               if re.search(r"(^|/)models/[^/]+\.parquet$", n))
                if not names:
                    sys.exit(f"{p}: no */models/*.parquet members")
                for name in names:
                    dest = Path(tmp) / Path(name).name
                    with zf.open(name) as src, open(dest, "wb") as out:
                        shutil.copyfileobj(src, out, 1 << 20)
                    yield f"{p}:{name}", dest
                    dest.unlink()
        elif p.suffix == ".parquet":
            yield str(p), p
        else:
            sys.exit(f"{p}: not a zip, a directory or a .parquet file")


def check_run(meta, label):
    """The run's description: data/instruct/run.json, written by the first
    import; a model from another run is refused."""
    run_path = OUT_DIR / "run.json"
    run = {
        "description": meta.get("description", ""),
        "run": meta["run"],
        "judge": meta["judge"],
        "judge_prompt": meta["judge_prompt"],
        "columns": meta.get("columns", {}),
    }
    old = read_json(run_path)
    if old is None:
        write_json(run_path, run)
        return run
    for key in RUN_KEYS:
        if old["run"].get(key) != run["run"].get(key):
            sys.exit(f"{label}: run setting `{key}` differs from data/instruct/run.json "
                     f"({old['run'].get(key)!r:.120} vs {run['run'].get(key)!r:.120}): another run?")
    if old["judge"].get("name") != run["judge"].get("name") or old["judge_prompt"] != run["judge_prompt"]:
        sys.exit(f"{label}: another judge or judge prompt than data/instruct/run.json")
    # The run's history grows; keep the latest export's.
    if old != run:
        write_json(run_path, run)
    return run


def import_model(label, path, examples):
    pf = pq.ParquetFile(path)
    raw = (pf.schema_arrow.metadata or {}).get(METADATA_KEY)
    if raw is None:
        sys.exit(f"{label}: no `{METADATA_KEY.decode()}` metadata: not a NorEval Instruct export")
    meta = json.loads(raw)
    run = check_run(meta, label)
    n = run["run"]["n"]
    tasks = list(run["run"]["tasks"])
    model = meta["model"]["name"]

    rows = pf.read(columns=COLUMNS).to_pylist()
    by_task = {}
    for r in rows:
        by_task.setdefault(r["task"], []).append(r)
    missing = [t for t in tasks if t not in by_task]
    extra = [t for t in by_task if t not in run["run"]["tasks"]]
    if missing or extra:
        sys.exit(f"{label}: tasks missing {missing}, unknown {extra}")
    thinking = {bool(r["thinking"]) for r in rows}
    if len(thinking) != 1:
        sys.exit(f"{label}: rows with and without thinking")

    draws = read_json(OUT_DIR / "draws.json") or {}
    draws_changed = False
    points, responses = {}, {}
    for task in tasks:
        task_rows = sorted(by_task[task], key=lambda r: r["draw"])
        if [r["draw"] for r in task_rows] != list(range(n)):
            sys.exit(f"{label}: {task} has draws {len(task_rows)} rows, not 0…{n - 1}")
        # Each draw's item and prompt variant: the run's plan, the same for every model.
        variants = sorted({r["prompt_variant"] for r in task_rows})
        plan = {
            "variants": variants,
            "doc_index": [r["doc_index"] for r in task_rows],
            "variant": [variants.index(r["prompt_variant"]) for r in task_rows],
        }
        if task not in draws:
            draws[task] = plan
            draws_changed = True
        elif draws[task] != plan:
            sys.exit(f"{label}: {task}'s draws differ from data/instruct/draws.json: another run?")
        points[task] = "".join("-" if r["judge_points"] is None else str(int(r["judge_points"])) for r in task_rows)

        # The first `examples` draws: the prompts (shared) and the model's responses.
        shown = task_rows[:examples]
        shared = [{
            "draw": r["draw"], "doc_index": r["doc_index"], "doc_fingerprint": r["doc_fingerprint"],
            "prompt_variant": r["prompt_variant"], "formulation": r["formulation"],
            "language": nonempty(r["language"]), "source_language": nonempty(r["source_language"]),
            "prompt": r["prompt"], "reference": json.loads(r["reference"]),
            "reference_text": r["reference_text"],
        } for r in shown]
        ex_path = OUT_DIR / "examples" / f"{task}.json"
        old = read_json(ex_path)
        if old is None or len(old["examples"]) < len(shared):
            write_json(ex_path, {"task": task, "examples": shared})
        elif old["examples"][:len(shared)] != shared:
            sys.exit(f"{label}: {task}'s example prompts differ from {ex_path.relative_to(BASE_DIR)}")
        # (A field without a value is left out: no reasoning, no automatic grade.)
        responses[task] = [{k: v for k, v in {
            "draw": r["draw"],
            "answer": r["response_answer"] or "",
            "thinking": nonempty(r["response_thinking"]),
            "finish_reason": r["response_finish_reason"],
            "finished_thinking": bool(r["response_finished_thinking"]),
            "output_tokens": r["response_output_tokens"],
            "judge_output": r["judge_output"] or "",
            "judge_points": r["judge_points"],
            "judge_auto": nonempty(r["judge_auto"]),
            "judged_response_cut": bool(r["judged_response_cut"]),
        }.items() if v is not None} for r in shown]

    if draws_changed:
        write_json(OUT_DIR / "draws.json", draws, one_line_each=True)
    write_json(OUT_DIR / "results" / f"{model}.json", {
        "model": {**{k: meta["model"].get(k) for k in ("name", "repo", "revision", "max_tokens")},
                  "thinking": thinking.pop()},
        "judge": meta["judge"]["name"],
        "results": meta["results"],
        "points": points,
    })
    out = OUT_DIR / "responses" / model
    for old in out.glob("*.json") if out.is_dir() else []:
        if old.stem not in responses:
            old.unlink()
    for task, examples in responses.items():
        write_responses(out / f"{task}.json", model, task, examples)
    # (The mean over the tasks of their mean grades, as the page shows it.)
    means = [sum(map(int, g)) / len(g) for g in (p.replace("-", "") for p in points.values()) if g]
    print(f"  {model}: {len(tasks)} tasks, mean grade {sum(means) / len(means) if means else float('nan'):.2f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("exports", nargs="+", help="export zip(s), directories or .parquet files")
    ap.add_argument("--examples", type=int, default=EXAMPLES,
                    help=f"responses kept per task and model (default {EXAMPLES})")
    args = ap.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        count = 0
        for label, path in parquet_sources(args.exports, tmp):
            print(f"{label}")
            import_model(label, path, args.examples)
            count += 1
    if not count:
        sys.exit("no Parquet files found")
    print(f"Imported {count} model(s) into {OUT_DIR.relative_to(BASE_DIR)}/. Next: python3 build_data.py")


if __name__ == "__main__":
    main()
