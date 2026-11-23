/**
 * When the sign-in for this window has ended, LFG's API answers 401. Without this, each
 * feature shows its own vague error ("Failed to delete conversation. Please try again.")
 * and background updates fail silently. Here every 401 from LFG's API shows one notice
 * that says what happened and how to sign back in.
 */
(function () {
  if (window.__lfgSessionGuard) return;
  window.__lfgSessionGuard = true;
  window.lfgSignedOut = false;

  function isLfgApi(input) {
    try {
      var raw = typeof input === "string" ? input : (input && input.url) || "";
      var url = new URL(raw, window.location.href);
      return url.origin === window.location.origin &&
        url.pathname.indexOf("/api/") === 0 && url.pathname.indexOf("/api/auth/") !== 0;
    } catch (e) { return false; }
  }

  function showNotice() {
    if (window.lfgSignedOut) return;
    window.lfgSignedOut = true;
    var next = window.location.pathname + window.location.search;
    var bar = document.createElement("div");
    bar.setAttribute("role", "alert");
    bar.id = "lfg-signed-out";
    bar.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483000;" +
      "display:flex;gap:12px;align-items:center;max-width:calc(100% - 32px);padding:12px 16px;border-radius:10px;" +
      "background:#0f172a;color:#f8fafc;font:14px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)";
    var text = document.createElement("span");
    text.textContent = "You've been signed out of LFG, so changes can't be saved.";
    var link = document.createElement("a");
    link.href = "/auth/login?next=" + encodeURIComponent(next);
    link.textContent = "Sign in again";
    link.style.cssText = "color:#fff;background:#4f46e5;padding:6px 12px;border-radius:6px;text-decoration:none;white-space:nowrap;font-weight:600";
    bar.appendChild(text);
    bar.appendChild(link);
    (document.body || document.documentElement).appendChild(bar);
  }

  var originalFetch = window.fetch;
  if (typeof originalFetch !== "function") return;
  window.fetch = function (input) {
    var api = isLfgApi(input);
    return originalFetch.apply(this, arguments).then(function (response) {
      if (api && response.status === 401) {
        if (document.body) showNotice();
        else document.addEventListener("DOMContentLoaded", showNotice, { once: true });
      }
      return response;
    });
  };
})();
