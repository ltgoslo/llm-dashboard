// NorEval base-model comparison dashboard.
//
// Most logic lives in shared/comparison.js. This file just supplies the
// dashboard-specific configuration (defaults, title prefix for downloads).

import { initComparison } from "../shared/comparison.js";

initComparison({
  filenamePrefix: "noreval-chart",
  defaultShot: "5",
  defaultSizeMin: 6,
  defaultSizeMax: 20,
  sizeRangeMin: 1,
  sizeRangeMax: 700,
  // Unchecking tasks in the default category-average view keeps averaging
  // by category; "Select all" from there returns to the default view.
  keepCategoryAverage: true,
});
