// Sliding thumb and hover tint of the segmented button groups
// (.shot-toggle: the shot, error-band and WSM-window toggles). The group's
// stylesheet draws a white thumb (::before) and a hover tint (::after) as
// pseudo-elements positioned by custom properties; this module keeps the
// thumb's on the active button, so it slides when another segment becomes
// .active, and the tint's on the hovered or keyboard-focused one. The
// buttons themselves and the code toggling their .active class are
// untouched: a MutationObserver watches the class changes, a
// ResizeObserver re-measures when the group's size changes (web font
// arriving, viewport resize, the group becoming visible).

export function enhanceSegmentedControls({ root = document } = {}) {
  for (const group of root.querySelectorAll(".shot-toggle")) enhanceSegmentedControl(group);
}

export function enhanceSegmentedControl(group) {
  if (group.dataset.segmented) return;
  group.dataset.segmented = "true";

  const place = () => {
    const active = group.querySelector(".active");
    group.style.setProperty("--thumb-left", `${active ? active.offsetLeft : 0}px`);
    group.style.setProperty("--thumb-width", `${active ? active.offsetWidth : 0}px`);
  };

  // Hover tint (the track's ::after, see style.css): under the hovered or
  // keyboard-focused button, unless that is the active one; hidden when
  // the pointer leaves the group or focus moves on.
  // (The class is only touched when it changes: even a no-op classList
  // add/remove rewrites the attribute, which the MutationObserver below
  // would see and re-run this, without end.)
  const showHover = (btn) => {
    const show = !!btn && !btn.classList.contains("active");
    if (show) {
      group.style.setProperty("--hover-left", `${btn.offsetLeft}px`);
      group.style.setProperty("--hover-width", `${btn.offsetWidth}px`);
    }
    if (show !== group.classList.contains("segmented-hover")) {
      group.classList.toggle("segmented-hover", show);
    }
  };
  // The tinted button: the hovered one, else the keyboard-focused one (a
  // mouse click focuses the segment it activates, where the tint is
  // hidden anyway). Re-evaluated on every pointer / focus change and on
  // every class change, e.g. the click that makes the tinted button active.
  const focused = () => (group.contains(document.activeElement) ? document.activeElement.closest("button") : null);
  const update = () => showHover(group.querySelector("button:hover") || focused());
  group.addEventListener("mouseover", update);
  group.addEventListener("mouseleave", update);
  group.addEventListener("focusin", update);
  group.addEventListener("focusout", () => requestAnimationFrame(update));   // once focus has moved on

  new MutationObserver(() => {
    place();
    update();
  }).observe(group, {
    attributes: true, attributeFilter: ["class"], subtree: true, childList: true,
  });
  new ResizeObserver(place).observe(group);
  place();
  // Transitions only after the first placement, so the thumb appears in
  // place instead of sliding in from the left edge.
  requestAnimationFrame(() => requestAnimationFrame(() => group.classList.add("segmented-ready")));
}
