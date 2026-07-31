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
  showCIBands: true,          // false hides CI bands (multisynt toggle)
  // Multisynt-only selectors; null = inactive (other dashboards never set them).
  currentFormulation: null,   // "max" | "cf" | "mcf" | "hybrid"
  currentAccNorm: null,       // "max" | "acc" | "acc_norm" | "acc_mutual_info"
  checkedTasks: new Set(),
};
