# LLM Dashboard

Interactive evaluation dashboards for language models, maintained by the
[Language Technology Group](https://www.mn.uio.no/ifi/english/research/groups/ltg/)
at the University of Oslo.

Four independent dashboards live under one repository:

| URL | Source data | Purpose |
| --- | --- | --- |
| [`/noreval`](https://ltgoslo.github.io/llm-dashboard/noreval/) | `data/noreval/` | Base-model comparison on the NorEval benchmark |
| [`/noreval-gen`](https://ltgoslo.github.io/llm-dashboard/noreval-gen/) | `data/noreval-gen/` | Instruction-tuned model comparison on NorEval |
| [`/norolmo`](https://ltgoslo.github.io/llm-dashboard/norolmo/) | `data/norolmo/` | NorOLMo 13B training-progress + ablations |
| [`/multisynt`](https://ltgoslo.github.io/llm-dashboard/multisynt/) | `data/multisynt/` | Multilingual training progress (Spanish, French, Finnish, Norwegian) |

Each dashboard has its own URL and its own `data.json`. The shared JavaScript /
CSS library lives in `docs/shared/` — score access, normalization, the chart
toolbar, the task-checkbox grid, and tooltips are written once and imported by
each dashboard via ES modules.

## Repository layout

```
llm-dashboard/
├── README.md
├── build_data.py                 ← single script, builds all 4 data.json files
├── metrics_setup.yaml            ← NorEval benchmark configs (used by 3 dashboards)
├── models_setup.yaml             ← NorEval base-model metadata
├── models_instruct_setup.yaml    ← NorEval instruct-model metadata
├── multisynt_tasks.yaml          ← MultiSynt task configs
├── multisynt_models.yaml         ← MultiSynt model display names + colors
├── check_missing.py              ← validates that every model has every benchmark
├── check_corrupt.py              ← finds corrupt result JSON files
├── merge_errant_scores.py        ← merges external ERRANT scores into ask_gec results
├── data/                         ← evaluation result JSONs (input to build_data.py)
│   ├── noreval/results/<model>/<bench>/<N-shot>/.../results_*.json
│   ├── noreval-gen/results/<model>/<bench>/<N-shot>/.../results_*.json
│   ├── norolmo/progress/NorOLMo-step-<N>/<bench>/<N-shot>/.../results_*.json
│   └── multisynt/results/<Lang>/<model>_<N>shot_checkpoints/<ckpt>/<bench>/p<N>/results.json
└── docs/                         ← GitHub Pages root (served as static site)
    ├── index.html                ← redirects to /noreval/
    ├── shared/
    │   ├── style.css             ← all dashboard styling
    │   ├── state.js              ← single mutable state object
    │   ├── core.js               ← score access, normalization, aggregation
    │   ├── chart.js              ← Plotly config, colors, layout helpers
    │   ├── ui.js                 ← tooltip, checkboxes, metric selector
    │   ├── selection.js          ← task-selection logic + shared control listeners
    │   ├── filter.js             ← HPLT-E quality filter (multisynt only)
    │   ├── url-state.js          ← URL hash/search save/restore
    │   ├── comparison.js         ← bar-chart logic shared by noreval + noreval-gen
    │   └── progress.js           ← line-chart logic shared by norolmo + multisynt
    ├── noreval/{index.html, app.js, data.json}
    ├── noreval-gen/{index.html, app.js, data.json}
    ├── norolmo/{index.html, app.js, data.json}
    └── multisynt/{index.html, app.js, data.json}
```

## Building locally

```bash
pip install pyyaml scipy
python3 build_data.py             # regenerates all four data.json files
python3 -m http.server 8000 -d docs   # serves at http://localhost:8000/noreval/
```

GitHub Actions rebuilds `docs/*/data.json` on every push that touches
`data/`, the YAML configs, or `build_data.py`.

## Adding a new …

### … model to NorEval

1. Drop the results under `data/noreval/results/<your-model>/` (same
   `{bench}/{N-shot}/{sanitized-name}/results_*.json` layout as existing models)
2. Add an entry in `models_setup.yaml` with `display_name`, `category`,
   `organization`, `parameters`, `license`, `huggingface_url`, etc.
3. `python3 build_data.py` and commit — GitHub Actions deploys

For an instruction-tuned model, swap `data/noreval-gen/results/` and
`models_instruct_setup.yaml`.

### … new NorEval benchmark

1. Add the results dirs under `<model>/<your-bench>/{0,1,5}-shot/...` for every
   model in `data/noreval/`, `data/noreval-gen/`, and every NorOLMo checkpoint
   in `data/norolmo/progress/`
2. Add a `<your-bench>:` entry to `metrics_setup.yaml` (pretty_name, main_metric,
   random_baseline, category, evaluation_type, metric_scale, url)
3. Run `build_data.py` and commit

### … new MultiSynt task

1. Add the results dirs under
   `data/multisynt/results/<Lang>/<model>_<N>shot_checkpoints/<ckpt>/<your-task>/p<N>/results.json`,
   or in the flat NorEval-1.2 layout, where formulation and prompt partition
   are embedded in the dir name itself:
   `.../<ckpt>/<your-task>[_<cf|mcf|hybrid>]_p<N>/results.json`
2. Add a `<your-task>:` entry to `multisynt_tasks.yaml`. Optionally use the
   `path:` field if the result files live under a sub-directory
   (e.g. `path: noropenbookqa/noropenbookqa_no_fact_nob`)
3. Run `build_data.py` and commit

### … new MultiSynt language

1. Drop result dirs at `data/multisynt/results/<NewLanguage>/...`
2. Make sure each task name there appears in `multisynt_tasks.yaml`
3. Run `build_data.py` — the language tab is auto-discovered

### … new MultiSynt model

1. Drop result dirs at `data/multisynt/results/<Lang>/<your-model>_{0,5}shot_checkpoints/<ckpt>/.../results.json`
2. Add a `<your-model>:` entry to `multisynt_models.yaml` with `display_name`
   and `color`
3. Run `build_data.py` and commit

## License

[MIT](LICENSE)
