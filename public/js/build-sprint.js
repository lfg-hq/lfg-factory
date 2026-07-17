(function () {
  "use strict";

  var config = window.LFG_BUILD_SPRINT || {};
  var form = document.getElementById("blueprint-form");
  var submitButton = document.getElementById("blueprint-submit");
  var formError = document.getElementById("form-error");
  var modal = document.getElementById("verify-modal");
  var verifyForm = document.getElementById("verify-form");
  var verifyInput = document.getElementById("verify-code");
  var verifyButton = document.getElementById("verify-submit");
  var verifyError = document.getElementById("verify-error");
  var requestId = sessionStorage.getItem("lfg_blueprint_request_id") || "";
  var requestEmail = sessionStorage.getItem("lfg_blueprint_email") || "";
  var turnstileToken = "";
  var turnstileWidget = null;
  var formStarted = false;
  var storageKey = "lfg_build_sprint_form_v1";

  function track(eventName, properties) {
    var payload = Object.assign({
      event: eventName,
      page: "build-sprint",
      timestamp: new Date().toISOString()
    }, properties || {});
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(payload);
    window.dispatchEvent(new CustomEvent("lfg:analytics", { detail: payload }));
  }

  track("landing_page_visit", {
    path: window.location.pathname,
    referrer: document.referrer || "direct",
    device: window.matchMedia("(max-width: 740px)").matches ? "mobile" : "desktop"
  });

  document.querySelectorAll("[data-track]").forEach(function (link) {
    link.addEventListener("click", function () {
      track("cta_click", { placement: link.getAttribute("data-track") });
    });
  });

  var header = document.querySelector(".site-header");
  function updateHeader() {
    header.classList.toggle("scrolled", window.scrollY > 20);
  }
  updateHeader();
  window.addEventListener("scroll", updateHeader, { passive: true });

  var menuButton = document.querySelector(".menu-button");
  var mobileNav = document.querySelector(".mobile-nav");
  if (menuButton && mobileNav) {
    menuButton.addEventListener("click", function () {
      var open = mobileNav.classList.toggle("open");
      menuButton.setAttribute("aria-expanded", String(open));
    });
    mobileNav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        mobileNav.classList.remove("open");
        menuButton.setAttribute("aria-expanded", "false");
      });
    });
  }

  var revealElements = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: "0px 0px -35px" });
    revealElements.forEach(function (element) { observer.observe(element); });
  } else {
    revealElements.forEach(function (element) { element.classList.add("visible"); });
  }

  function createIcons() {
    if (window.lucide) window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
  }
  if (document.readyState === "complete") createIcons();
  else window.addEventListener("load", createIcons);

  function attribution() {
    var params = new URLSearchParams(window.location.search);
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem("lfg_attribution") || "{}"); } catch (_) {}
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach(function (key) {
      if (params.get(key)) saved[key] = params.get(key);
    });
    saved.referrer = saved.referrer || document.referrer || "direct";
    saved.landing_variant = "build-sprint-a";
    localStorage.setItem("lfg_attribution", JSON.stringify(saved));
    return saved;
  }

  var attributionData = attribution();
  Object.keys(attributionData).forEach(function (key) {
    var input = form && form.querySelector('[name="' + key + '"]');
    if (input) input.value = attributionData[key];
  });

  function restoreForm() {
    if (!form) return;
    var saved;
    try { saved = JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch (_) { saved = {}; }
    Object.keys(saved).forEach(function (key) {
      var field = form.elements.namedItem(key);
      if (field && !String(key).startsWith("utm_") && key !== "referrer") field.value = saved[key];
    });
  }

  function saveForm() {
    if (!form) return;
    var data = new FormData(form);
    var saved = {};
    data.forEach(function (value, key) {
      if (key !== "email" && !String(key).startsWith("utm_") && key !== "referrer") saved[key] = value;
    });
    localStorage.setItem(storageKey, JSON.stringify(saved));
  }

  restoreForm();
  if (form) {
    form.addEventListener("input", function () {
      saveForm();
      if (!formStarted) {
        formStarted = true;
        track("form_start");
      }
    });
  }

  function renderTurnstile() {
    if (!config.turnstileSiteKey || turnstileWidget !== null || !window.turnstile) return;
    var target = document.getElementById("blueprint-turnstile");
    if (!target) return;
    turnstileWidget = window.turnstile.render(target, {
      sitekey: config.turnstileSiteKey,
      theme: "light",
      callback: function (token) { turnstileToken = token; },
      "expired-callback": function () { turnstileToken = ""; },
      "error-callback": function () { turnstileToken = ""; }
    });
  }

  if (config.turnstileSiteKey) {
    var turnstileAttempts = 0;
    var turnstileTimer = setInterval(function () {
      turnstileAttempts += 1;
      if (window.turnstile || turnstileAttempts > 40) {
        clearInterval(turnstileTimer);
        renderTurnstile();
      }
    }, 250);
  }

  function showError(element, message) {
    element.textContent = message || "";
  }

  function validateForm() {
    var firstInvalid = null;
    form.querySelectorAll("[required]").forEach(function (field) {
      var valid = field.checkValidity();
      field.setAttribute("aria-invalid", valid ? "false" : "true");
      if (!valid && !firstInvalid) firstInvalid = field;
    });
    var idea = form.elements.namedItem("project_idea");
    if (idea && idea.value.trim().length < 30) {
      idea.setAttribute("aria-invalid", "true");
      firstInvalid = firstInvalid || idea;
    }
    if (firstInvalid) {
      firstInvalid.focus();
      showError(formError, "Please complete the highlighted required field.");
      return false;
    }
    if (config.turnstileSiteKey && !turnstileToken) {
      showError(formError, "Please complete the bot check before continuing.");
      return false;
    }
    return true;
  }

  function openModal(email) {
    document.getElementById("verify-email").textContent = email;
    modal.hidden = false;
    document.body.classList.add("modal-open");
    setTimeout(function () { verifyInput.focus(); }, 50);
    track("form_step_completed", { step: "project_details" });
  }

  function closeModal() {
    modal.hidden = true;
    document.body.classList.remove("modal-open");
  }

  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      showError(formError, "");
      if (!validateForm() || submitButton.disabled) return;

      var data = new FormData(form);
      var details = {};
      data.forEach(function (value, key) { details[key] = String(value).trim(); });
      submitButton.disabled = true;
      submitButton.firstChild.textContent = "Sending verification code ";

      fetch("/api/free-prd/request-code", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: details.email,
          project_idea: details.project_idea,
          turnstile_token: turnstileToken,
          campaign: "build-sprint",
          details: details
        })
      }).then(function (response) {
        return response.json().then(function (body) { return { ok: response.ok, body: body }; });
      }).then(function (result) {
        if (!result.ok || !result.body.success) throw new Error(result.body.error || "Unable to send the verification code.");
        requestId = result.body.request_id;
        requestEmail = details.email;
        sessionStorage.setItem("lfg_blueprint_request_id", requestId);
        sessionStorage.setItem("lfg_blueprint_email", requestEmail);
        openModal(requestEmail);
      }).catch(function (error) {
        showError(formError, error.message || "Unable to continue. Please try again.");
        if (window.turnstile && turnstileWidget !== null) window.turnstile.reset(turnstileWidget);
        turnstileToken = "";
      }).finally(function () {
        submitButton.disabled = false;
        submitButton.firstChild.textContent = "Generate my free Blueprint ";
      });
    });
  }

  if (verifyInput) {
    verifyInput.addEventListener("input", function () {
      verifyInput.value = verifyInput.value.replace(/\D/g, "").slice(0, 6);
    });
  }

  if (verifyForm) {
    verifyForm.addEventListener("submit", function (event) {
      event.preventDefault();
      showError(verifyError, "");
      var code = verifyInput.value.trim();
      if (!requestId || code.length !== 6 || verifyButton.disabled) {
        showError(verifyError, "Enter the 6-digit code from your email.");
        return;
      }
      verifyButton.disabled = true;
      verifyButton.firstChild.textContent = "Verifying ";
      fetch("/api/free-prd/verify-code", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId, code: code })
      }).then(function (response) {
        return response.json().then(function (body) { return { ok: response.ok, body: body }; });
      }).then(function (result) {
        if (!result.ok || !result.body.success) throw new Error(result.body.error || "The code was not accepted.");
        track("email_verified", { request_id: requestId });
        localStorage.removeItem(storageKey);
        sessionStorage.removeItem("lfg_blueprint_request_id");
        sessionStorage.removeItem("lfg_blueprint_email");
        window.location.href = result.body.prd_url || ("/prd/" + requestId);
      }).catch(function (error) {
        showError(verifyError, error.message || "Verification failed. Please try again.");
        verifyButton.disabled = false;
        verifyButton.firstChild.textContent = "Verify and create Blueprint ";
      });
    });
  }

  var resendButton = document.getElementById("resend-code");
  if (resendButton) {
    resendButton.addEventListener("click", function () {
      showError(verifyError, "");
      if (!requestId || resendButton.disabled) return;
      resendButton.disabled = true;
      resendButton.textContent = "Sending…";
      fetch("/api/free-prd/resend-code", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId })
      }).then(function (response) {
        return response.json().then(function (body) { return { ok: response.ok, body: body }; });
      }).then(function (result) {
        if (!result.ok || !result.body.success) throw new Error(result.body.error || "Unable to resend the code.");
        resendButton.textContent = "New code sent";
        setTimeout(function () { resendButton.textContent = "Didn’t receive it? Resend code"; }, 2500);
      }).catch(function (error) {
        showError(verifyError, error.message || "Unable to resend the code.");
        resendButton.textContent = "Didn’t receive it? Resend code";
      }).finally(function () { resendButton.disabled = false; });
    });
  }

  document.querySelector(".modal-close").addEventListener("click", closeModal);
  modal.addEventListener("click", function (event) { if (event.target === modal) closeModal(); });
  document.addEventListener("keydown", function (event) { if (event.key === "Escape" && !modal.hidden) closeModal(); });

  if (requestId && requestEmail) openModal(requestEmail);
})();
