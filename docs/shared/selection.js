// Shared task-selection logic for the NorEval-shaped dashboards
// (noreval, noreval-gen, norolmo): resolving a task-dropdown value to a
// benchmark list, populating the dropdown, collapsing checkbox changes back
// to a selection, and the control listeners those dashboards share.
//
// multisynt keeps its own small variants — its task universe (per-language
// metrics_setup, no groups/languages/eval-types) and its "__filtered__"
// mode behave differently.

import { state } from "./state.js";
import { capitalize, isAggregateSelection } from "./core.js";
import { syncTaskCheckboxStates } from "./ui.js";

export function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

/** Benchmarks covered by a task-selection value (dropdown option / URL). */
export function getBenchmarksForSelection(sel) {
  if (sel === "__all__" || sel === "__all_macro__" || sel === "__filtered__") return Object.keys(state.metricsSetup);
  if (sel === "__custom__") return [];
  if (sel.startsWith("__cat__")) {
    const c = sel.slice(7);
    return Object.keys(state.metricsSetup).filter((b) => state.metricsSetup[b].category === c);
  }
  if (sel.startsWith("__eval__")) {
    const e = sel.slice(8);
    return Object.keys(state.metricsSetup).filter((b) => state.metricsSetup[b].evaluation_type === e);
  }
  if (sel === "__lang__nno") {
    const nno = new Set(state.DATA.nno_benchmarks || []);
    for (const b of (state.DATA.nob_nno_translation_benchmarks || [])) nno.add(b);
    for (const b of (state.DATA.shared_language_benchmarks || [])) nno.add(b);
    return [...nno];
  }
  if (sel === "__lang__nob") {
    const nnoOnly = new Set(state.DATA.nno_benchmarks || []);
    const smeOnly = new Set(state.DATA.sme_benchmarks || []);
    const nobNno = new Set(state.DATA.nob_nno_translation_benchmarks || []);
    const shared = new Set(state.DATA.shared_language_benchmarks || []);
    return Object.keys(state.metricsSetup).filter((b) =>
      (!nnoOnly.has(b) && !smeOnly.has(b)) || nobNno.has(b) || shared.has(b));
  }
  if (sel === "__lang__sme") return state.DATA.sme_benchmarks || [];
  if (sel.startsWith("__group__")) {
    const g = state.DATA.task_groups[sel.slice(9)];
    return g ? g.benchmarks : [];
  }
  if (state.metricsSetup[sel]) return [sel];
  return [];
}

/** Dropdown value that shows `bench`: its pair-group if it belongs to one,
 *  itself if it's a standalone option, else null. */
export function findDropdownValueForBench(bench) {
  for (const [gn, g] of Object.entries(state.DATA.task_groups || {})) {
    if (g.benchmarks.includes(bench)) return "__group__" + gn;
  }
  if (state.DATA.standalone_benchmarks?.includes(bench)) return bench;
  return null;
}

/** Apply the selection-dependent default normalization (baseline for
 *  aggregate views, none for individual tasks) and sync the <select>. */
export function autoSetNormalization() {
  state.currentNormalization = isAggregateSelection(state.currentTaskSelection) ? "baseline" : "none";
  document.getElementById("norm-select").value = state.currentNormalization;
}

/** Populate the task <select> with the category / eval-type / language
 *  aggregate optgroups and the individual tasks (pair groups + standalones). */
export function populateTaskDropdown() {
  const select = document.getElementById("task-select");

  const categories = {};
  for (const [bench, info] of Object.entries(state.metricsSetup)) {
    (categories[info.category] = categories[info.category] || []).push(bench);
  }
  const catGroup = document.createElement("optgroup");
  catGroup.label = "Aggregate by category";
  for (const catName of Object.keys(categories).sort()) {
    const opt = document.createElement("option");
    opt.value = "__cat__" + catName;
    opt.textContent = capitalize(catName);
    catGroup.appendChild(opt);
  }
  select.appendChild(catGroup);

  const evalTypes = {};
  for (const [bench, info] of Object.entries(state.metricsSetup)) {
    if (info.evaluation_type) (evalTypes[info.evaluation_type] = evalTypes[info.evaluation_type] || []).push(bench);
  }
  if (Object.keys(evalTypes).length > 0) {
    const evalGroup = document.createElement("optgroup");
    evalGroup.label = "Aggregate by evaluation type";
    for (const etName of Object.keys(evalTypes).sort()) {
      const opt = document.createElement("option");
      opt.value = "__eval__" + etName;
      opt.textContent = capitalize(etName);
      evalGroup.appendChild(opt);
    }
    select.appendChild(evalGroup);
  }

  const langGroup = document.createElement("optgroup");
  langGroup.label = "Aggregate by language";
  for (const [val, label] of [["__lang__nob", "Bokmål"], ["__lang__nno", "Nynorsk"], ["__lang__sme", "Northern Sámi"]]) {
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = label;
    langGroup.appendChild(opt);
  }
  select.appendChild(langGroup);

  const taskGroup = document.createElement("optgroup");
  taskGroup.label = "Individual tasks";
  const entries = [];
  for (const groupName of Object.keys(state.DATA.task_groups || {})) {
    entries.push({ value: "__group__" + groupName, label: capitalize(groupName) });
  }
  const standalones = state.DATA.standalone_benchmarks || Object.keys(state.metricsSetup);
  for (const bench of standalones) {
    const info = state.metricsSetup[bench];
    if (info) entries.push({ value: bench, label: capitalize(info.pretty_name) });
  }
  entries.sort((a, b) => a.label.localeCompare(b.label));
  for (const entry of entries) {
    const opt = document.createElement("option");
    opt.value = entry.value; opt.textContent = entry.label;
    taskGroup.appendChild(opt);
  }
  select.appendChild(taskGroup);
}

/** Handle a task-checkbox change: collapse the checked set back to a single
 *  benchmark or a 2-benchmark pair group when it matches one (so the
 *  dropdown, metric selector, and title follow), else "__custom__". */
export function onTaskCheckboxChange(render) {
  if (state.checkedTasks.size === 1) {
    const bench = [...state.checkedTasks][0];
    state.currentTaskSelection = bench;
    const ddVal = findDropdownValueForBench(bench);
    if (ddVal) document.getElementById("task-select").value = ddVal;
    autoSetNormalization();
    render();
    return;
  }
  if (state.checkedTasks.size === 2 && state.DATA.task_groups) {
    const arr = [...state.checkedTasks];
    for (const [gn, g] of Object.entries(state.DATA.task_groups)) {
      if (g.benchmarks.length === 2 && g.benchmarks.includes(arr[0]) && g.benchmarks.includes(arr[1])) {
        state.currentTaskSelection = "__group__" + gn;
        document.getElementById("task-select").value = state.currentTaskSelection;
        autoSetNormalization();
        render();
        return;
      }
    }
  }
  state.currentTaskSelection = "__custom__";
  document.getElementById("task-select").value = "__custom__";
  autoSetNormalization();
  render();
}

/** Bind the control listeners shared by the NorEval dashboards: shot buttons,
 *  prompt-aggregation / normalization / metric selects, the task dropdown,
 *  and the task "Select all" / "Select none" buttons. */
export function bindTaskControls(render) {
  document.querySelectorAll(".shot-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelector(".shot-btn.active")?.classList.remove("active");
      btn.classList.add("active");
      state.currentShot = btn.dataset.shot;
      render();
    });
  });

  document.getElementById("prompt-agg-select").addEventListener("change", (e) => {
    state.currentPromptAgg = e.target.value;
    render();
  });
  document.getElementById("norm-select").addEventListener("change", (e) => {
    state.currentNormalization = e.target.value;
    render();
  });
  document.getElementById("metric-select").addEventListener("change", (e) => {
    state.currentMetric = e.target.value;
    render();
  });

  document.getElementById("task-select").addEventListener("change", (e) => {
    state.currentTaskSelection = e.target.value;
    const benchmarks = getBenchmarksForSelection(state.currentTaskSelection);
    if (benchmarks.length > 0) state.checkedTasks = new Set(benchmarks);
    syncTaskCheckboxStates(() => state.checkedTasks);
    autoSetNormalization();
    render();
  });

  document.getElementById("select-all-btn").addEventListener("click", () => {
    state.checkedTasks = new Set(Object.keys(state.metricsSetup));
    state.currentTaskSelection = "__all__";
    document.getElementById("task-select").value = "__all__";
    syncTaskCheckboxStates(() => state.checkedTasks);
    autoSetNormalization();
    render();
  });
  document.getElementById("select-none-btn").addEventListener("click", () => {
    state.checkedTasks.clear();
    syncTaskCheckboxStates(() => state.checkedTasks);
    render();
  });
}

/** After urlState.load(): if `task` was specified but `tasks` was not, derive
 *  checkedTasks from the task selection (mirrors the dropdown change handler).
 *  Without this, checkedTasks stays at the initial "all tasks" value, which
 *  both shows wrong results and pollutes the URL with an explicit tasks= list
 *  on the next save. */
export function restoreCheckedTasksFromSelection(urlState) {
  if (urlState.has("task") && !urlState.has("tasks")) {
    const benchmarks = getBenchmarksForSelection(state.currentTaskSelection);
    if (benchmarks.length > 0) state.checkedTasks = new Set(benchmarks);
  }
}

/** Sync the shared controls' DOM state from `state` (after a URL restore). */
export function syncTaskControlsFromState() {
  document.getElementById("task-select").value = state.currentTaskSelection;
  document.getElementById("prompt-agg-select").value = state.currentPromptAgg;
  document.getElementById("norm-select").value = state.currentNormalization;
  document.querySelectorAll(".shot-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.shot === state.currentShot));
  syncTaskCheckboxStates(() => state.checkedTasks);
}
