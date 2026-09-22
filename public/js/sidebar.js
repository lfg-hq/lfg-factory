// Shared inbox stays available across projects and conversations.
(() => {
    const script = document.createElement('script');
    script.src = '/public/js/build-notifications.js?v=4';
    document.head.appendChild(script);
})();

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

    // Hand off the first-paint state only after the real sidebar state is installed.
    requestAnimationFrame(() => document.documentElement.classList.remove('sidebar-minimized-preload'));

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
    
    // The account menu is a full-width popover even when the rail is collapsed.
    function positionAccountMenu() {
        if (!userInfoButton || !userDropdown) return;
        const rect = userInfoButton.getBoundingClientRect();
        userDropdown.style.setProperty('--account-menu-left', Math.max(8, Math.min(rect.left + 10, innerWidth - 248)) + 'px');
        userDropdown.style.setProperty('--account-menu-bottom', Math.max(8, innerHeight - rect.top + 8) + 'px');
    }
    function closeAccountMenu() {
        userInfo?.classList.remove('open');
        userInfoButton?.setAttribute('aria-expanded', 'false');
    }
    if (userInfoButton && userDropdown) {
        userInfoButton.setAttribute('aria-expanded', 'false');
        userInfoButton.setAttribute('aria-controls', 'user-dropdown');
        userInfoButton.setAttribute('aria-label', 'Account settings and appearance');
        userInfoButton.addEventListener('click', (e) => {
            e.stopPropagation();
            positionAccountMenu();
            const open = userInfo.classList.toggle('open');
            userInfoButton.setAttribute('aria-expanded', String(open));
        });
        // Move the existing toggle, preserving the theme switcher's event binding.
        const themeToggle = sidebar.querySelector('[data-theme-toggle]');
        if (themeToggle) {
            const formerGroup = themeToggle.parentElement;
            themeToggle.classList.remove('nav-link', 'theme-toggle-sidebar');
            themeToggle.classList.add('dropdown-item', 'account-theme-toggle');
            userDropdown.insertBefore(themeToggle, userDropdown.querySelector('.dropdown-divider'));
            if (formerGroup.classList.contains('bottom-nav') && !formerGroup.children.length) formerGroup.remove();
            function updateAppearanceLabel() {
                const dark = document.documentElement.getAttribute('data-theme') !== 'light';
                const label = themeToggle.querySelector('.theme-text, .nav-text, span');
                if (label) label.textContent = dark ? 'Light mode' : 'Dark mode';
                themeToggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
                themeToggle.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
            }
            updateAppearanceLabel();
            window.addEventListener('themechange', updateAppearanceLabel);
        }
        userDropdown.addEventListener('click', e => e.stopPropagation());
    }
    document.addEventListener('click', e => {
        if (userInfo && !userInfo.contains(e.target)) closeAccountMenu();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && userInfo?.classList.contains('open')) {
            closeAccountMenu(); userInfoButton.focus();
        }
    });
    window.addEventListener('resize', positionAccountMenu);

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
