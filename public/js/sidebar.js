document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.getElementById('sidebar');
    const appContainer = document.querySelector('.app-container');
    const minimizeBtn = document.getElementById('minimize-btn');
    const userInfo = document.getElementById('user-info');
    const userInfoButton = document.getElementById('user-info-button');
    const userDropdown = document.getElementById('user-dropdown');

    // Persist current project ID to localStorage so it survives navigation
    const currentProjectId = sidebar?.dataset.currentProjectId;
    if (currentProjectId) {
        localStorage.setItem('currentProjectId', currentProjectId);
    }

    // Restore sidebar state from localStorage
    if (localStorage.getItem('sidebarMinimized') === 'true' && sidebar && appContainer) {
        sidebar.classList.add('minimized');
        appContainer.classList.add('sidebar-minimized');
    }

    // Toggle sidebar minimized state
    function toggleMinimized() {
        const isMinimized = sidebar.classList.contains('minimized');
        if (isMinimized) {
            sidebar.classList.remove('minimized');
            appContainer.classList.remove('sidebar-minimized');
            localStorage.setItem('sidebarMinimized', 'false');
        } else {
            sidebar.classList.add('minimized');
            appContainer.classList.add('sidebar-minimized');
            localStorage.setItem('sidebarMinimized', 'true');
            userInfo?.classList.remove('open');
        }
    }
    
    // Minimize button click handler
    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', toggleMinimized);
    }
    
    // Logo click handler in minimized state
    const logoSection = document.querySelector('.logo-section');
    if (logoSection) {
        logoSection.addEventListener('click', () => {
            if (sidebar.classList.contains('minimized')) {
                toggleMinimized();
            }
        });
    }
    
    // User dropdown toggle
    if (userInfoButton) {
        userInfoButton.addEventListener('click', (e) => {
            e.stopPropagation();
            userInfo.classList.toggle('open');
        });
    }
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!userInfo.contains(e.target)) {
            userInfo.classList.remove('open');
        }
    });
    
    // Prevent dropdown from closing when clicking inside it
    if (userDropdown) {
        userDropdown.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    // Project dropdown toggle
    const projectDropdownTrigger = document.getElementById('projectDropdownTrigger');
    const projectDropdownContainer = document.getElementById('projectDropdownContainer');
    const projectDropdown = document.getElementById('projectDropdown');

    if (projectDropdownTrigger && projectDropdownContainer) {
        projectDropdownTrigger.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            projectDropdownContainer.classList.toggle('open');
            // Close user dropdown if open
            userInfo?.classList.remove('open');
        });
    }

    // Close project dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (projectDropdownContainer && !projectDropdownContainer.contains(e.target)) {
            projectDropdownContainer.classList.remove('open');
        }
    });

    // Prevent project dropdown from closing when clicking inside it
    if (projectDropdown) {
        projectDropdown.addEventListener('click', (e) => {
            // Don't stop propagation for links - let them navigate
            if (!e.target.closest('a')) {
                e.stopPropagation();
            }
        });
    }

    // Handle window resize
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (window.innerWidth <= 768) {
                sidebar.classList.add('minimized');
                appContainer.classList.add('sidebar-minimized');
            }
        }, 250);
    });
    
    // Keyboard shortcut (Ctrl/Cmd + B to toggle minimized)
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
            e.preventDefault();
            toggleMinimized();
        }
    });
    
});
/* ── "More" in the rail ──────────────────────────────────────────────────────
   Epics, Docs, Inbox and Environment live behind a chevron so the rail stays
   short. The open/closed state is remembered — it's a drawer you set once, not a
   thing to keep reopening. Lives here because sidebar.js loads on every page that
   has a rail. */
(function () {
  "use strict";
  var KEY = "lfgSidebarMoreOpen";
  function init() {
    var btn = document.querySelector(".sidebar-more-toggle");
    var items = document.getElementById("sidebar-more-items");
    if (!btn || !items) return;

    function set(open) {
      items.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", String(open));
      try { localStorage.setItem(KEY, open ? "1" : ""); } catch (e) {}
    }

    var remembered = "";
    try { remembered = localStorage.getItem(KEY) || ""; } catch (e) {}
    // Open it when the page you're on lives inside it, so the rail doesn't hide
    // where you already are.
    // Mark the page you're actually on. Nothing did this before, so the only thing
    // that ever looked "selected" in here was whatever the mouse happened to be over.
    var here = window.location.pathname + window.location.search;
    var containsCurrent = false;
    Array.prototype.forEach.call(items.querySelectorAll("a"), function (a) {
      var href = a.getAttribute("href") || "";
      if (!href) return;
      var path = href.split("?")[0];
      var tab = (href.split("?")[1] || "").match(/tab=([\w-]+)/);
      var hereTab = (window.location.search.match(/tab=([\w-]+)/) || [])[1];
      // A tabbed destination matches only when the tab matches; an ordinary page
      // (Epics) matches on its path.
      var isCurrent = tab
        ? (window.location.pathname === path && hereTab === tab[1])
        : (window.location.pathname === path);
      a.classList.toggle("active", isCurrent);
      if (isCurrent) containsCurrent = true;
    });
    set(!!remembered || containsCurrent);

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      set(!items.classList.contains("is-open"));
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
