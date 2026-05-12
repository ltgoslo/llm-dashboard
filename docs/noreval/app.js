// NorEval base-model comparison dashboard.
//
// Most logic lives in shared/comparison.js. This file just supplies the
// dashboard-specific configuration (defaults, title prefix for downloads).

import { initComparison } from "../shared/comparison.js";

initComparison({
  filenamePrefix: "noreval-chart",
  defaultShot: "5",
  defaultSizeMin: 6,
  defaultSizeMax: 24,
  sizeRangeMin: 1,
  sizeRangeMax: 73,
});
