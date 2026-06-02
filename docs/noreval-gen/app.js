// NorEval instruction-tuned model comparison dashboard.
//
// Same logic as /noreval, but reads instruct-model data and defaults to
// 0-shot evaluation with the full 1–700B size range.

import { initComparison } from "../shared/comparison.js";

initComparison({
  filenamePrefix: "noreval-gen-chart",
  defaultShot: "0",
  defaultSizeMin: 1,
  defaultSizeMax: 700,
  sizeRangeMin: 1,
  sizeRangeMax: 700,
});
