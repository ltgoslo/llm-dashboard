// NorEval Instruct dashboard: generative NorEval for instruction-tuned
// models, every response graded by an LLM judge (build_data.py
// build_instruct_data). The comparison pages' logic with one setting:
// zero-shot chat prompts, and a task's score already averages over its
// prompts (the judge's mean grade over random draws of items and prompts),
// so the page has no Shots or Prompt aggregation controls; every task is
// graded the same way, from 0 to 5 points, so none for rescaling either:
// the scores are the mean grades as they are. For now it has no model-size
// or fully-open filter either: every model shows, as ranked bars (the size
// range below spans them all). A task's details show the model's responses
// and the judge's assessments.

import { initComparison } from "../shared/comparison.js";
import { state } from "../shared/state.js";

await initComparison({
  filenamePrefix: "noreval-instruct-chart",
  defaultShot: "0",
  promptAgg: "mean",
  normalization: "none",
  decimals: 2,
  scoreTop: 5,
  // Generation first: what instruction-tuned models are for.
  categoryOrder: ["generation & summarization", "linguistic knowledge", "language understanding",
    "world knowledge & reasoning", "translation"],
  // The details without the average over all tasks: the chart shows it.
  detailAverage: false,
  defaultSizeMin: 1,
  defaultSizeMax: 700,
  sizeRangeMin: 1,
  sizeRangeMax: 700,
});

// The About section's judge prompt, as the judge gets it: its instructions
// and examples, then the case ({prompt}, {reference}, {response} filled
// in) and the output format.
const judgePrompt = state.DATA?.instruct?.judge_prompt;
const pre = document.getElementById("judge-prompt");
if (judgePrompt && pre) pre.textContent = judgePrompt.prefix + judgePrompt.case + "\n" + judgePrompt.output_format;
