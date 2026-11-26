// Shared mutable state used by all dashboards.
//
// All shared modules read from this single object. Dashboards mutate fields
// directly (e.g. state.currentShot = "0") — module exports are live bindings,
// so the change is visible everywhere immediately.

export const state = {
  DATA: null,                 // The loaded data.json
  metricsSetup: null,         // Resolved per-dashboard (or per-language for multisynt)
  currentShot: "5",
  currentTaskSelection: "__all_macro__",
  currentPromptAgg: "max",
  currentNormalization: "baseline",
  currentMetric: null,        // null = use the benchmark's main_metric
  decimals: 1,                // places of a displayed score (scoreDecimals: z-scores get 2); /instruct's 0–5 mean grades 2
  scoreTop: 100,              // a perfect displayed score: 100 (scores shown ×100), 5 (/instruct's top grade)
  categoryOrder: null,        // the page's order of the task categories (null: CATEGORY_ORDER, NorEval's)
  showCIBands: true,          // false hides CI bands (multisynt toggle)
  // Multisynt / prelude selectors; null = inactive (other dashboards never set them).
  currentFormulation: null,   // "max" | "mean" | "cf" | "mcf" | "hybrid"
  currentAccNorm: null,       // "max" | "none" | "norm" | "mutual_info" (legacy: "acc" | "acc_norm" | "acc_mutual_info")
  currentDecoding: null,      // "sampling" | "greedy" — generative tasks that were run both ways carry `by_decoding.greedy`
  // Multisynt-only: see resolvePoint() / taskBaseMetric() / getAggregatedTasks() in core.js.
  llNormScope: "acc",         // "acc": the LL-norm selector only redirects a main "acc" metric; "all": any base metric
  formulationCombine: false,  // true: "max"/"mean" formulation values aggregate across the per-formulation scores
  classificationMetric: null, // "acc" | "likelihood_correct" | "prob_correct": the "Classification metric" selector of the aggregate views (multisynt, prelude, norprelude); null = every task's main metric
  taskTypeFilter: "all",      // "all" | "classification" | "generation" — mask over checkedTasks in aggregate views
  checkedTasks: new Set(),
};
