// Sliding thumb for the segmented button groups (.shot-toggle: the shot
// and error-band toggles). The group's stylesheet draws a white thumb as
// a ::before pseudo-element positioned by two custom properties; this
// module keeps those properties on the active button, so the thumb slides
// when another segment becomes .active. The buttons themselves and the
// code toggling their .active class are untouched: a MutationObserver
// watches the class changes, a ResizeObserver re-measures when the
// group's size changes (web font arriving, viewport resize, the group
// becoming visible).

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

  new MutationObserver(place).observe(group, {
    attributes: true, attributeFilter: ["class"], subtree: true, childList: true,
  });
  new ResizeObserver(place).observe(group);
  place();
  // Transitions only after the first placement, so the thumb appears in
  // place instead of sliding in from the left edge.
  requestAnimationFrame(() => requestAnimationFrame(() => group.classList.add("segmented-ready")));
}
