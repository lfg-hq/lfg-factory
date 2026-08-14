/**
 * Artifacts tab-bar overflow.
 *
 * The artifacts panel is resizable, so at narrow widths the tab row runs out of
 * room. Rather than let tabs scroll out of reach, the ones that don't fit are
 * collapsed — last one first — into a ⋯ menu next to the row.
 *
 * Markup contract (see chat.tsx):
 *   #artifacts-tabs-list   the flex row of .tab-button elements
 *   #tab-overflow          wrapper, gets .has-items when something is hidden
 *   #tab-overflow-btn      the ⋯ button
 *   #tab-overflow-menu     the dropdown, filled with .tab-overflow-item buttons
 */
(function () {
  const $ = (id) => document.getElementById(id);
  let list = null, wrap = null, btn = null, menu = null;

  function tabs() {
    return Array.from(list.querySelectorAll(".tab-button"));
  }

  function closeMenu() {
    if (!menu) return;
    menu.hidden = true;
    btn?.setAttribute("aria-expanded", "false");
  }

  function buildMenu(hidden) {
    menu.innerHTML = hidden
      .map((t) => {
        const id = t.getAttribute("data-tab");
        const active = t.classList.contains("active") ? " active" : "";
        return '<button class="tab-overflow-item' + active + '" data-tab="' + id + '">' + t.textContent.trim() + "</button>";
      })
      .join("");
  }

  function layout() {
    if (!list || !wrap) return;
    const all = tabs();
    if (!all.length) return;
    if (!list.clientWidth) return; // panel collapsed/hidden — nothing to measure yet

    // Start from "everything visible, no ⋯" and measure from there.
    all.forEach((t) => t.classList.remove("tab-hidden"));
    wrap.classList.remove("has-items");

    if (list.scrollWidth <= list.clientWidth + 1) {
      closeMenu();
      wrap.classList.remove("holds-active");
      return;
    }

    // Something overflows: show the ⋯ (it eats width of its own, so measure
    // again after) and hide trailing tabs until the row fits.
    wrap.classList.add("has-items");
    const hidden = [];
    for (let i = all.length - 1; i > 0; i--) {
      if (list.scrollWidth <= list.clientWidth + 1) break;
      all[i].classList.add("tab-hidden");
      hidden.unshift(all[i]);
    }

    if (!hidden.length) {
      wrap.classList.remove("has-items");
      wrap.classList.remove("holds-active");
      closeMenu();
      return;
    }

    buildMenu(hidden);
    // The active tab may now be inside the menu — mark the ⋯ so the panel still
    // shows which tab you're on.
    wrap.classList.toggle("holds-active", hidden.some((t) => t.classList.contains("active")));
  }

  function init() {
    list = $("artifacts-tabs-list");
    wrap = $("tab-overflow");
    btn = $("tab-overflow-btn");
    menu = $("tab-overflow-menu");
    if (!list || !wrap || !btn || !menu) return;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    });

    menu.addEventListener("click", (e) => {
      const item = e.target.closest(".tab-overflow-item");
      if (!item) return;
      const tabId = item.getAttribute("data-tab");
      closeMenu();
      if (window.switchTab) window.switchTab(tabId);
      else list.querySelector('.tab-button[data-tab="' + tabId + '"]')?.click();
      layout();
    });

    document.addEventListener("click", (e) => {
      if (!menu.hidden && !wrap.contains(e.target)) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMenu();
    });

    // Clicking a visible tab can move the active marker in or out of the menu.
    list.addEventListener("click", () => setTimeout(layout, 0));

    if (window.ResizeObserver) new ResizeObserver(layout).observe(list.parentElement);
    window.addEventListener("resize", layout);
    layout();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
