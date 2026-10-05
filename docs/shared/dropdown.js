// Custom dropdown — the dashboards' own listbox in place of the operating
// system's <select> popup, so the controls look the same on every system.
// Select-only combobox pattern, after the figure dropdowns of
// davidsamuel.no (js/viz-select.js): focus stays on the closed control,
// the open list is driven by mouse or arrow keys / Home / End / Enter /
// Escape / typing the first letters of an option.
//
// Progressive enhancement: the native <select> stays in the DOM, hidden, as
// the single source of truth. The rest of the code keeps populating it,
// assigning and reading `.value` and listening for 'change' exactly as
// before. enhanceSelect() places a sibling root (div.ui-select) after the
// select that mirrors its options and current choice:
//   • option-list and attribute changes (innerHTML, appendChild, hidden,
//     disabled, title) are picked up by a MutationObserver;
//   • programmatic `.value` / `.selectedIndex` assignments by a
//     per-instance property hook (setting `option.selected` directly is
//     not mirrored — no dashboard does that);
//   • choosing an option sets the native value and dispatches a bubbling
//     'change' event on the native select.
// The open list is appended to <body> and positioned under the root
// (fixed), so no ancestor's overflow or clip-path can cut it off; it flips
// above the root when there is more room there.

let uid = 0;

/** Enhance every <select> under `root` (default: the document) that is
 *  not enhanced yet. `tooltip` is an optional { attach(el, contentFn),
 *  hide() } pair used to show an option's `title` with the page's own
 *  tooltip instead of the browser's. */
export function enhanceSelects({ root = document, tooltip = null } = {}) {
  for (const select of root.querySelectorAll("select")) enhanceSelect(select, { tooltip });
}

/** Enhance one <select>; returns its root (div.ui-select). */
export function enhanceSelect(select, { tooltip = null } = {}) {
  if (select.uiSelect) return select.uiSelect;
  if (select.multiple) return null;

  const root = document.createElement("div");
  root.className = "ui-select";
  root.tabIndex = 0;
  root.setAttribute("role", "combobox");
  root.setAttribute("aria-haspopup", "listbox");
  root.setAttribute("aria-expanded", "false");

  const label = document.createElement("span");
  label.className = "ui-select-label";
  root.appendChild(label);

  const list = document.createElement("ul");
  list.className = "ui-select-options";
  list.id = `ui-select-list-${uid++}`;
  list.setAttribute("role", "listbox");
  list.hidden = true;
  // A press on the list itself (scrollbar, group heading) must not blur the
  // root, which would close the list before the click lands.
  list.addEventListener("mousedown", (e) => e.preventDefault());
  root.setAttribute("aria-controls", list.id);

  // The page's <label for=…> names the root and focuses it when clicked.
  const pageLabel = select.id ? document.querySelector(`label[for="${select.id}"]`) : null;
  if (pageLabel) {
    if (!pageLabel.id) pageLabel.id = `${select.id}-label`;
    root.setAttribute("aria-labelledby", pageLabel.id);
    list.setAttribute("aria-labelledby", pageLabel.id);
    pageLabel.addEventListener("click", (e) => { e.preventDefault(); root.focus(); });
  } else if (select.getAttribute("aria-label")) {
    root.setAttribute("aria-label", select.getAttribute("aria-label"));
  }

  select.classList.add("ui-select-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  select.insertAdjacentElement("afterend", root);
  select.uiSelect = root;

  let items = [];   // visible options, in list order: { option, li }
  let active = -1;  // index into items of the highlighted row, -1 when closed
  let typed = "";   // type-ahead buffer
  let typedTimer = null;

  // ── mirroring the native select ──

  function rebuild() {
    close();
    list.innerHTML = "";
    items = [];
    for (const child of select.children) {
      if (child.tagName === "OPTGROUP") {
        if (child.hidden) continue;
        const heading = document.createElement("li");
        heading.className = "ui-select-group";
        heading.setAttribute("role", "presentation");
        heading.textContent = child.label;
        list.appendChild(heading);
        for (const opt of child.children) addOption(opt, true);
      } else if (child.tagName === "OPTION") {
        addOption(child, false);
      }
    }
    syncSelected();
    syncDisabled();
  }

  function addOption(option, grouped) {
    if (option.hidden) return;
    const index = items.length;
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.id = `ui-select-option-${uid++}`;
    li.textContent = option.textContent;
    if (grouped) li.classList.add("ui-select-grouped");
    if (option.disabled) li.setAttribute("aria-disabled", "true");
    li.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus on the root
    li.addEventListener("click", () => { if (!option.disabled) commit(index); });
    li.addEventListener("mousemove", () => { if (!option.disabled) setActive(index); });
    if (tooltip && option.title) tooltip.attach(li, () => ({ body: option.title }));
    list.appendChild(li);
    items.push({ option, li });
  }

  function currentOption() {
    return select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
  }

  function syncSelected() {
    const current = currentOption();
    label.textContent = current ? current.textContent : "";
    for (const { option, li } of items) {
      if (option === current) li.setAttribute("aria-selected", "true");
      else li.removeAttribute("aria-selected");
    }
  }

  function syncDisabled() {
    root.classList.toggle("disabled", select.disabled);
    if (select.disabled) root.setAttribute("aria-disabled", "true");
    else root.removeAttribute("aria-disabled");
  }

  new MutationObserver(() => rebuild()).observe(select, {
    childList: true, subtree: true, attributes: true, characterData: true,
  });

  for (const prop of ["value", "selectedIndex"]) {
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(select, prop, {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); syncSelected(); },
    });
  }

  // ── the open list ──

  function enabledIndex(from, step) {
    for (let i = from; i >= 0 && i < items.length; i += step) {
      if (!items[i].option.disabled) return i;
    }
    return -1;
  }

  function setActive(index) {
    if (index === active) return; // mousemove fires per pixel
    if (active >= 0) items[active].li.classList.remove("active");
    active = index;
    if (index >= 0) {
      items[index].li.classList.add("active");
      root.setAttribute("aria-activedescendant", items[index].li.id);
    } else {
      root.removeAttribute("aria-activedescendant");
    }
  }

  function revealActive() {
    if (active >= 0) items[active].li.scrollIntoView({ block: "nearest" });
  }

  function position() {
    const r = root.getBoundingClientRect();
    const gap = 5, edge = 8;
    list.style.minWidth = `${r.width}px`;
    list.style.maxHeight = "";
    list.style.left = `${r.left}px`;
    list.style.top = `${r.bottom + gap}px`;
    const below = window.innerHeight - r.bottom - gap - edge;
    const above = r.top - gap - edge;
    const height = list.offsetHeight; // natural height, capped by the stylesheet
    if (height > below && above > below) {
      const h = Math.min(height, above);
      list.style.maxHeight = `${h}px`;
      list.style.top = `${r.top - gap - h}px`;
    } else {
      list.style.maxHeight = `${Math.min(height, Math.max(below, 0))}px`;
    }
    const overflow = r.left + list.offsetWidth - (window.innerWidth - edge);
    if (overflow > 0) list.style.left = `${Math.max(edge, r.left - overflow)}px`;
  }

  function onScroll(e) {
    if (!list.contains(e.target)) close();
  }

  function open() {
    if (!list.hidden || select.disabled || items.length === 0) return;
    document.body.appendChild(list);
    list.hidden = false;
    root.setAttribute("aria-expanded", "true");
    position();
    const current = currentOption();
    const selected = items.findIndex((it) => it.option === current && !current.disabled);
    setActive(selected >= 0 ? selected : enabledIndex(0, +1));
    revealActive();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
  }

  function close() {
    if (list.hidden) return;
    list.hidden = true;
    list.remove();
    root.setAttribute("aria-expanded", "false");
    setActive(-1);
    if (tooltip) tooltip.hide();
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", close);
  }

  function commit(index) {
    const { option } = items[index];
    const changed = option !== currentOption();
    if (changed) option.selected = true;
    syncSelected();
    close();
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Jump to the next enabled option whose text starts with the letters
   *  typed in quick succession (repeating one letter cycles through its
   *  options, as the native control does). */
  function typeAhead(key) {
    clearTimeout(typedTimer);
    typedTimer = setTimeout(() => { typed = ""; }, 700);
    const repeated = typed.length > 0 && typed === key.repeat(typed.length);
    typed += key;
    const prefix = (repeated ? key : typed).toLowerCase();
    const start = (repeated || typed.length === 1) ? active + 1 : active;
    for (let n = 0; n < items.length; n++) {
      const i = (Math.max(start, 0) + n) % items.length;
      const { option } = items[i];
      if (!option.disabled && option.textContent.trim().toLowerCase().startsWith(prefix)) {
        setActive(i);
        return;
      }
    }
  }

  // ── events on the root ──

  root.addEventListener("click", () => (list.hidden ? open() : close()));
  root.addEventListener("blur", close);

  root.addEventListener("keydown", (e) => {
    const k = e.key;
    const isChar = k.length === 1 && k !== " " && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (list.hidden) {
      if (k === "Enter" || k === " " || k === "ArrowDown" || k === "ArrowUp" || isChar) {
        e.preventDefault();
        open();
        if (isChar) { typeAhead(k); revealActive(); }
      }
      return;
    }
    if (k === "ArrowDown") { const i = enabledIndex(active + 1, +1); if (i >= 0) setActive(i); }
    else if (k === "ArrowUp") { const i = enabledIndex(active - 1, -1); if (i >= 0) setActive(i); }
    else if (k === "Home") setActive(enabledIndex(0, +1));
    else if (k === "End") setActive(enabledIndex(items.length - 1, -1));
    else if (k === "Enter" || k === " ") { if (active >= 0) commit(active); }
    else if (k === "Escape") close();
    else if (k === "Tab") { close(); return; } // and let focus move on
    else if (isChar) typeAhead(k);
    else return;
    e.preventDefault();
    revealActive();
  });

  rebuild();
  return root;
}
