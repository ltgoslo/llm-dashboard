// HPLT-E quality filter — used only by the multisynt dashboard.
//
// For each benchmark, each criterion is computed per-model on the trajectory
// inside the configured window, then the median across models is taken
// (matching the original HPLT-E paper). The "consistency" criterion is
// cross-model: at each shared checkpoint, models are ranked, and Kendall's τ
// is computed between successive checkpoint rankings.
//
// All filter math runs on raw percentage-scale scores (×100 for unit metrics,
// identity for percent metrics) rather than on baseline-normalized scores.

import { state } from "./state.js";
import { attachTooltip } from "./ui.js";

// Module-level filter state. `initFilter()` resets criteria and uiConfig.
export const filter = {
  criteria: {},                 // {name: {enabled, min, max, threshold, direction, label, description, tooltip}}
  results: {},                  // {bench: {criterionName: {value, pass}}}
  allBenchmarks: new Set(),     // Universe of benchmarks the filter considers
  uiConfig: null,               // {criterionOrder, criterionHeaders, onChange}
  panelRendered: false,
  panelExpanded: false,
};

// ─────────────────────────────────────────────────────────────
// Math utilities
// ─────────────────────────────────────────────────────────────

function computeSpearmanRank(x, y) {
  if (x.length < 3) return null;
  const n = x.length;
  function rankArray(arr) {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j < n - 1 && sorted[j + 1].v === sorted[j].v) j++;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[sorted[k].i] = avgRank;
      i = j + 1;
    }
    return ranks;
  }
  const rx = rankArray(x), ry = rankArray(y);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mx, dy = ry[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

function computeKendallTau(x, y) {
  const n = x.length;
  if (n < 2) return null;
  let concordant = 0, discordant = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = x[i] - x[j], dy = y[i] - y[j];
      if (dx * dy > 0) concordant++;
      else if (dx * dy < 0) discordant++;
    }
  }
  const pairs = n * (n - 1) / 2;
  return pairs === 0 ? 0 : (concordant - discordant) / pairs;
}

function evaluateThreshold(name, value, threshold) {
  if (value === null || value === undefined) return null;
  const lowerIsBetter = { cv: true, mad: true, promptSwitch: true };
  return lowerIsBetter[name] ? value <= threshold : value >= threshold;
}

function medianOf(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Convert a raw score to percentage scale (×100 for unit metrics). */
function rawToPercent(rawScore, benchmark) {
  const info = state.metricsSetup[benchmark];
  return info.metric_scale === "unit" ? rawScore * 100 : rawScore;
}

/** Scale factor to convert raw prompt_sd/prompt_mad into percentage units. */
function noiseScaleFactor(benchmark) {
  const info = state.metricsSetup[benchmark];
  return info.metric_scale === "unit" ? 100 : 1;
}

/** Linearly interpolate a model's score at an x-axis value not on its grid. */
function interpolateScore(progressData, xValues, target, benchmark, shot, metric) {
  const exact = progressData[String(target)]?.[benchmark]?.[shot]?.[metric];
  if (exact !== undefined && exact !== null) {
    return typeof exact === "number" ? exact : exact[state.currentPromptAgg];
  }
  let lo = null, hi = null;
  for (const v of xValues) {
    if (v <= target) lo = v;
    if (v >= target && hi === null) hi = v;
  }
  if (lo === null || hi === null || lo === hi) return null;
  const loObj = progressData[String(lo)]?.[benchmark]?.[shot]?.[metric];
  const hiObj = progressData[String(hi)]?.[benchmark]?.[shot]?.[metric];
  if (!loObj || !hiObj) return null;
  const loScore = typeof loObj === "number" ? loObj : loObj[state.currentPromptAgg];
  const hiScore = typeof hiObj === "number" ? hiObj : hiObj[state.currentPromptAgg];
  if (loScore == null || hiScore == null) return null;
  return loScore + (target - lo) / (hi - lo) * (hiScore - loScore);
}

// ─────────────────────────────────────────────────────────────
// Per-benchmark criterion evaluation
// ─────────────────────────────────────────────────────────────

/** Compute all criteria for one benchmark. Returns {criterionName: {value, pass}}.
 *  `models` is the multisynt list of {name, color, progress, checkpoints()}. */
function computeFilterCriteriaForBench(bench, shot, models) {
  const info = state.metricsSetup[bench];
  if (!info) return {};
  const mainMetric = info.main_metric;
  const noiseFactor = noiseScaleFactor(bench);
  const baselinePct = rawToPercent(info.random_baseline || 0, bench);
  const results = {};

  for (const [name, cfg] of Object.entries(filter.criteria)) {
    // Cross-model criterion: Kendall τ between successive checkpoint rankings.
    if (name === "consistency") {
      if (models.length < 2) {
        results[name] = { value: null, pass: null };
        continue;
      }
      const allX = new Set();
      const modelX = new Map();
      for (const m of models) {
        const xs = m.checkpoints();
        modelX.set(m, xs);
        for (const x of xs) allX.add(x);
      }
      const windowX = [...allX].filter((x) => x >= cfg.min && x <= cfg.max).sort((a, b) => a - b);
      if (windowX.length < 2) { results[name] = { value: null, pass: null }; continue; }

      const rankings = [];
      for (const xv of windowX) {
        const scores = [];
        let valid = true;
        for (const m of models) {
          const raw = interpolateScore(m.progress, modelX.get(m), xv, bench, shot, mainMetric);
          if (raw == null) { valid = false; break; }
          scores.push(rawToPercent(raw, bench));
        }
        if (valid) rankings.push(scores);
      }
      if (rankings.length < 2) { results[name] = { value: null, pass: null }; continue; }

      const taus = [];
      for (let i = 0; i < rankings.length - 1; i++) {
        const t = computeKendallTau(rankings[i], rankings[i + 1]);
        taus.push(t != null ? t : 0);
      }
      const value = taus.reduce((a, b) => a + b, 0) / taus.length;
      results[name] = { value, pass: evaluateThreshold(name, value, cfg.threshold) };
      continue;
    }

    // Per-model criteria — compute on each model, then take the median.
    const perModelValues = [];
    for (const m of models) {
      const checkpoints = m.checkpoints();
      const windowCkpts = checkpoints.filter((x) => x >= cfg.min && x <= cfg.max);
      const pairs = [];
      for (const x of windowCkpts) {
        const obj = m.progress[String(x)]?.[bench]?.[shot]?.[mainMetric];
        if (!obj) continue;
        const rawScore = typeof obj === "number" ? obj : obj[state.currentPromptAgg];
        if (rawScore == null) continue;
        pairs.push({ x, score: rawToPercent(rawScore, bench), obj: typeof obj === "object" ? obj : {} });
      }
      if (pairs.length < 3 && name !== "nonRandom") continue;
      if (pairs.length < 1) continue;

      let value = null;
      switch (name) {
        case "monotonicity":
          value = computeSpearmanRank(pairs.map((p) => p.x), pairs.map((p) => p.score));
          break;
        case "snr": {
          const scores = pairs.map((p) => p.score);
          const noiseVals = state.currentPromptAgg === "median"
            ? pairs.map((p) => 1.4826 * (p.obj.prompt_mad || 0) * noiseFactor)
            : pairs.map((p) => (p.obj.prompt_sd || 0) * noiseFactor);
          const meanSignal = Math.max(0, scores.reduce((a, b) => a + b, 0) / scores.length - baselinePct);
          const meanNoise = noiseVals.reduce((a, b) => a + b, 0) / noiseVals.length;
          value = meanNoise > 1e-10 ? meanSignal / (meanNoise + 1e-8) : (meanSignal > 0 ? Infinity : 0);
          break;
        }
        case "cv": {
          const scores = pairs.map((p) => p.score);
          const n = scores.length;
          const mean = scores.reduce((a, b) => a + b, 0) / n;
          const stdDev = n > 1
            ? Math.sqrt(scores.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1))
            : 0;
          value = Math.abs(mean) > 1e-10 ? (stdDev / Math.abs(mean)) * 100 : (stdDev > 0 ? Infinity : 0);
          break;
        }
        case "mad": {
          const mads = pairs.map((p) => p.obj.prompt_mad).filter((v) => v != null);
          if (mads.length === 0) break;
          const scaled = mads.map((v) => v * noiseFactor).sort((a, b) => a - b);
          value = scaled.length % 2 === 0
            ? (scaled[scaled.length / 2 - 1] + scaled[scaled.length / 2]) / 2
            : scaled[Math.floor(scaled.length / 2)];
          break;
        }
        case "promptSwitch": {
          const indices = pairs.map((p) => p.obj.max_prompt_idx);
          if (indices.some((v) => v == null)) break;
          let switches = 0;
          for (let i = 1; i < indices.length; i++) if (indices[i] !== indices[i - 1]) switches++;
          value = indices.length > 1 ? (switches / (indices.length - 1)) * 100 : 0;
          break;
        }
        case "nonRandom": {
          const scores = pairs.map((p) => p.score);
          const maxScore = Math.max(...scores);
          value = Math.max(0, maxScore - baselinePct);
          break;
        }
      }
      if (value != null) perModelValues.push(value);
    }

    const medianValue = medianOf(perModelValues);
    results[name] = { value: medianValue, pass: evaluateThreshold(name, medianValue, cfg.threshold) };
  }
  return results;
}

// ─────────────────────────────────────────────────────────────
// Run + render
// ─────────────────────────────────────────────────────────────

/** Compute filterResults and refresh state.checkedTasks to the passing benchmarks. */
export function runFilter(models, shot) {
  filter.results = {};
  for (const bench of filter.allBenchmarks) {
    filter.results[bench] = computeFilterCriteriaForBench(bench, shot, models);
  }
  state.checkedTasks = new Set();
  for (const bench of filter.allBenchmarks) {
    let passes = true;
    const res = filter.results[bench] || {};
    for (const [name, cfg] of Object.entries(filter.criteria)) {
      if (!cfg.enabled) continue;
      const r = res[name];
      if (r && r.pass === false) { passes = false; break; }
    }
    if (passes) state.checkedTasks.add(bench);
  }
  renderFilterTable();
}

function renderFilterPanel() {
  const grid = document.getElementById("filter-criteria-grid");
  if (!grid) return;
  grid.innerHTML = "";
  const { criterionOrder, onChange } = filter.uiConfig;
  for (const name of criterionOrder) {
    const cfg = filter.criteria[name];
    if (!cfg) continue;
    const card = document.createElement("div");
    card.className = "filter-criterion" + (cfg.enabled ? "" : " disabled");

    const header = document.createElement("div");
    header.className = "filter-criterion-header";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = cfg.enabled; cb.id = "filter-cb-" + name;
    cb.addEventListener("change", () => {
      cfg.enabled = cb.checked;
      card.classList.toggle("disabled", !cfg.enabled);
      onChange();
    });
    const label = document.createElement("label");
    label.className = "criterion-label"; label.htmlFor = cb.id;
    label.textContent = cfg.label;
    if (cfg.tooltip) {
      label.style.cursor = "help";
      label.style.textDecoration = "underline";
      label.style.textDecorationStyle = "dotted";
      label.style.textUnderlineOffset = "3px";
      attachTooltip(label, () => ({ title: cfg.label, body: cfg.tooltip, footer: "" }));
    }
    const desc = document.createElement("span");
    desc.className = "criterion-desc"; desc.textContent = cfg.description;
    header.appendChild(cb); header.appendChild(label); header.appendChild(desc);
    card.appendChild(header);

    const controls = document.createElement("div");
    controls.className = "filter-criterion-controls";
    const minLabel = document.createElement("label");
    minLabel.textContent = "Tokens (B): ";
    const minInput = document.createElement("input");
    minInput.type = "number"; minInput.value = cfg.min; minInput.min = 0; minInput.max = 120; minInput.step = 1;
    minInput.addEventListener("change", () => {
      cfg.min = parseFloat(minInput.value) || 0;
      onChange();
    });
    minLabel.appendChild(minInput); controls.appendChild(minLabel);
    const dash = document.createElement("span");
    dash.textContent = "–"; dash.style.color = "var(--fg-muted)";
    controls.appendChild(dash);
    const maxInput = document.createElement("input");
    maxInput.type = "number"; maxInput.value = cfg.max; maxInput.min = 0; maxInput.max = 120; maxInput.step = 1;
    maxInput.addEventListener("change", () => {
      cfg.max = parseFloat(maxInput.value) || 0;
      onChange();
    });
    controls.appendChild(maxInput);
    const threshLabel = document.createElement("label");
    threshLabel.textContent = "Threshold " + cfg.direction + " ";
    const threshInput = document.createElement("input");
    threshInput.type = "number"; threshInput.className = "threshold-input";
    threshInput.value = cfg.threshold;
    threshInput.step = (name === "monotonicity" || name === "consistency") ? 0.1 : 1;
    threshInput.addEventListener("change", () => {
      cfg.threshold = parseFloat(threshInput.value) || 0;
      onChange();
    });
    threshLabel.appendChild(threshInput); controls.appendChild(threshLabel);
    card.appendChild(controls); grid.appendChild(card);
  }
}

function renderFilterTable() {
  const table = document.getElementById("filter-table");
  const summary = document.getElementById("filter-summary");
  if (!table) return;
  table.innerHTML = "";
  const { criterionOrder, criterionHeaders } = filter.uiConfig;

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const benchTh = document.createElement("th");
  benchTh.textContent = "Benchmark";
  headerRow.appendChild(benchTh);
  for (let i = 0; i < criterionOrder.length; i++) {
    const name = criterionOrder[i];
    const cfg = filter.criteria[name];
    if (!cfg) continue;
    const th = document.createElement("th");
    th.textContent = criterionHeaders[i] || cfg.label;
    if (!cfg.enabled) th.style.opacity = "0.4";
    if (cfg.tooltip) {
      th.style.cursor = "help";
      th.style.textDecoration = "underline";
      th.style.textDecorationStyle = "dotted";
      th.style.textUnderlineOffset = "3px";
      attachTooltip(th, () => ({ title: cfg.label + " (median across models)", body: cfg.tooltip, footer: "" }));
    }
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow); table.appendChild(thead);

  const tbody = document.createElement("tbody");
  let passCount = 0;
  const ms = state.metricsSetup;
  const sorted = [...filter.allBenchmarks].sort((a, b) =>
    (ms[a]?.pretty_name || a).localeCompare(ms[b]?.pretty_name || b));
  for (const bench of sorted) {
    const passes = state.checkedTasks.has(bench);
    if (passes) passCount++;
    const tr = document.createElement("tr");
    tr.className = passes ? "pass-row" : "fail-row";
    const nameTd = document.createElement("td");
    nameTd.textContent = ms[bench]?.pretty_name || bench;
    tr.appendChild(nameTd);
    const res = filter.results[bench] || {};
    for (const name of criterionOrder) {
      const cfg = filter.criteria[name];
      if (!cfg) continue;
      const r = res[name];
      const td = document.createElement("td");
      if (!r || r.value === null || r.value === undefined) {
        td.className = "na"; td.textContent = "N/A";
      } else {
        td.textContent = r.value === Infinity ? "∞" : r.value.toFixed(2);
        td.className = cfg.enabled ? (r.pass ? "pass" : "fail") : "na";
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  if (summary) summary.textContent = passCount + " / " + filter.allBenchmarks.size + " benchmarks pass";
}

export function showFilterUI() {
  const panel = document.getElementById("filter-panel");
  if (panel) panel.style.display = "";
  const heading = document.querySelector("#task-checkboxes .checkbox-header h3");
  if (heading) heading.textContent = "Tasks eligible for quality filtering";
  if (!filter.panelRendered) {
    renderFilterPanel();
    filter.panelRendered = true;
    const toggleBtn = document.getElementById("filter-panel-toggle");
    const panelContent = document.getElementById("filter-panel-content");
    if (toggleBtn && panelContent) {
      panelContent.style.display = filter.panelExpanded ? "" : "none";
      toggleBtn.textContent = filter.panelExpanded ? "Hide signal criteria" : "Show signal criteria";
      toggleBtn.onclick = () => {
        filter.panelExpanded = !filter.panelExpanded;
        panelContent.style.display = filter.panelExpanded ? "" : "none";
        toggleBtn.textContent = filter.panelExpanded ? "Hide signal criteria" : "Show signal criteria";
      };
    }
  }
}

export function hideFilterUI() {
  const panel = document.getElementById("filter-panel");
  if (panel) panel.style.display = "none";
  filter.panelRendered = false;
  const heading = document.querySelector("#task-checkboxes .checkbox-header h3");
  if (heading) heading.textContent = "Tasks included in aggregation";
}

/** Initialize the filter module — pass criteria definitions and UI config.
 *  uiConfig.criterionOrder is the display order; uiConfig.criterionHeaders are
 *  the column headers (parallel to criterionOrder); uiConfig.onChange is called
 *  whenever a criterion's enabled state, window, or threshold changes. */
export function initFilter(criteria, uiConfig) {
  filter.criteria = criteria;
  filter.uiConfig = uiConfig;
  filter.panelRendered = false;
  filter.panelExpanded = false;
}

/** Force a re-render of the criteria UI on next showFilterUI (used when
 *  language changes and per-language defaults are reapplied). */
export function resetFilterPanel() {
  filter.panelRendered = false;
}

/** Serialize current criteria settings for download. */
export function serializeCriteria() {
  const out = {};
  for (const [name, cfg] of Object.entries(filter.criteria)) {
    out[name] = { enabled: cfg.enabled, min: cfg.min, max: cfg.max, threshold: cfg.threshold };
  }
  return out;
}

/** Merge uploaded criteria settings into the live config.
 *  Accepts both the new {min, max} keys and the legacy {minTokens, maxTokens}
 *  keys used by the old filter-criteria-*.json files. */
export function deserializeCriteria(data) {
  for (const [name, vals] of Object.entries(data)) {
    if (!filter.criteria[name]) continue;
    const cfg = filter.criteria[name];
    if (typeof vals.enabled === "boolean") cfg.enabled = vals.enabled;
    if (typeof vals.min === "number") cfg.min = vals.min;
    if (typeof vals.max === "number") cfg.max = vals.max;
    if (typeof vals.threshold === "number") cfg.threshold = vals.threshold;
    if (typeof vals.minTokens === "number") cfg.min = vals.minTokens;
    if (typeof vals.maxTokens === "number") cfg.max = vals.maxTokens;
  }
  filter.panelRendered = false;
}
