(function () {
  "use strict";

  var VALID = ["username", "name", "phone", "email", "plate_number", "passport_number"];
  var TYPE_LABELS = {
    username: "Username",
    name: "Name",
    phone: "Phone",
    email: "Email",
    plate_number: "Plate",
    passport_number: "Passport",
  };
  var EMPTY_MESSAGES = {
    username: "Enter a username for this search.",
    name: "Enter both first name and last name.",
    phone: "Enter a phone number.",
    email: "Enter an email address.",
    plate_number: "Enter a plate number.",
    passport_number: "Enter a passport number.",
  };
  var LAST_SEARCH_KEY = "kryx-last-search";
  var SUCCESS_REDIRECT_MS = 450;
  var ESTIMATE_DELAY_MS = 5000;

  var SOCIAL_PLATFORMS = (function () {
    var fallback = ["gov.ph", "facebook.com", "instagram.com", "linkedin.com", "twitter.com"];
    var el = document.getElementById("search-crawl-hosts-data");
    if (!el) return fallback;
    try {
      var parsed = JSON.parse(el.textContent || "[]");
      if (Array.isArray(parsed)) {
        var hosts = parsed.filter(function (host) {
          return typeof host === "string" && host.trim();
        });
        if (hosts.length > 0) return hosts;
      }
    } catch (err) {
      /* use fallback */
    }
    return fallback;
  })();

  var SOCIAL_PHASES = ["indexed", "matching", "linking", "scanning", "probing", "queued"];

  var reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function randomPick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function randomHostAvoid(prev, visible) {
    var h;
    var guard = 0;
    var taken = visible || [];
    do {
      h = randomPick(SOCIAL_PLATFORMS);
      guard += 1;
    } while (
      guard < 24 &&
      SOCIAL_PLATFORMS.length > 1 &&
      (h === prev || taken.indexOf(h) >= 0)
    );
    return h;
  }

  function redactValue(value, type) {
    var v = (value || "").trim();
    if (!v) return "—";
    if (type === "email") {
      var at = v.indexOf("@");
      if (at > 1) return v.charAt(0) + "***" + v.slice(at);
      return v.charAt(0) + "***";
    }
    if (type === "phone") {
      var digits = v.replace(/\D/g, "");
      if (digits.length <= 4) return "***";
      return digits.slice(0, 2) + "***" + digits.slice(-3);
    }
    if (type === "name") {
      return v
        .split(/\s+/)
        .filter(Boolean)
        .map(function (part) {
          return part.charAt(0) + "***";
        })
        .join(" ");
    }
    if (v.length <= 2) return "***";
    return v.charAt(0) + "***" + v.charAt(v.length - 1);
  }

  var root = document.querySelector("[data-search-tabs]");
  if (!root) return;
  var form = root.closest("form");
  if (!form) return;

  var hiddenType = document.getElementById("search-type-input");
  var tabs = root.querySelectorAll("[data-search-tab]");
  var panels = root.querySelectorAll("[data-search-panel]");
  var hints = root.querySelectorAll("[data-hint]");
  var inlineError = document.getElementById("search-inline-error");
  var lastSearchWrap = document.getElementById("search-last-query");
  var lastSearchBtn = document.getElementById("search-last-query-btn");

  function activePanel() {
    var i;
    for (i = 0; i < panels.length; i += 1) {
      if (!panels[i].hidden) return panels[i];
    }
    return null;
  }

  function setTab(type, shouldFocus) {
    if (VALID.indexOf(type) < 0) type = "username";

    tabs.forEach(function (btn) {
      var on = btn.getAttribute("data-search-tab") === type;
      btn.setAttribute("aria-selected", on ? "true" : "false");
      btn.tabIndex = on ? 0 : -1;
    });

    panels.forEach(function (panel) {
      var on = panel.getAttribute("data-search-panel") === type;
      panel.hidden = !on;
      panel.querySelectorAll("input, textarea, select, button").forEach(function (el) {
        el.disabled = !on;
      });
    });

    hints.forEach(function (hint) {
      hint.hidden = hint.getAttribute("data-hint") !== type;
    });

    if (hiddenType) hiddenType.value = type;
    clearInlineError();

    if (shouldFocus !== false) {
      var panel = activePanel();
      if (panel) {
        var focusInput = panel.querySelector(".landing-preview-bar-input");
        if (focusInput) focusInput.focus();
      }
    }
  }

  tabs.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setTab(btn.getAttribute("data-search-tab"));
    });
  });

  setTab((hiddenType && hiddenType.value) || "username", false);

  function clearInlineError() {
    if (!inlineError) return;
    inlineError.hidden = true;
    inlineError.textContent = "";
    var panel = activePanel();
    if (panel) panel.classList.remove("search-panel--invalid");
  }

  function showInlineError(message) {
    if (inlineError) {
      inlineError.hidden = false;
      inlineError.textContent = message;
    }
    var panel = activePanel();
    if (panel) {
      panel.classList.add("search-panel--invalid");
      if (!reducedMotion) {
        panel.classList.remove("search-panel--shake");
        void panel.offsetWidth;
        panel.classList.add("search-panel--shake");
      }
      var focusInput = panel.querySelector(".landing-preview-bar-input");
      if (focusInput) focusInput.focus();
    }
  }

  function searchFieldsValid(searchType) {
    if (searchType === "name") {
      var first = (document.getElementById("search-first-name") || {}).value || "";
      var last = (document.getElementById("search-last-name") || {}).value || "";
      return Boolean(first.trim() && last.trim());
    }
    if (searchType === "username") {
      return Boolean(((document.getElementById("search-username") || {}).value || "").trim());
    }
    if (searchType === "phone") {
      return Boolean(((document.getElementById("search-phone") || {}).value || "").trim());
    }
    if (searchType === "email") {
      return Boolean(((document.getElementById("search-email") || {}).value || "").trim());
    }
    if (searchType === "plate_number") {
      return Boolean(((document.getElementById("search-plate-number") || {}).value || "").trim());
    }
    if (searchType === "passport_number") {
      return Boolean(((document.getElementById("search-passport-number") || {}).value || "").trim());
    }
    return true;
  }

  function validateBeforeSubmit() {
    clearInlineError();
    var searchType = (hiddenType && hiddenType.value) || "username";
    if (!searchFieldsValid(searchType)) {
      showInlineError(EMPTY_MESSAGES[searchType] || "Enter a search value.");
      return false;
    }
    var policy = form.querySelector('input[name="accept_policy"]');
    if (policy && !policy.checked) {
      showInlineError("Accept the Terms and Privacy Policy before searching.");
      return false;
    }
    return true;
  }

  function getRawQueryValue(searchType) {
    if (searchType === "name") {
      var first = ((document.getElementById("search-first-name") || {}).value || "").trim();
      var last = ((document.getElementById("search-last-name") || {}).value || "").trim();
      return (first + " " + last).trim();
    }
    if (searchType === "username") {
      return ((document.getElementById("search-username") || {}).value || "").trim();
    }
    if (searchType === "phone") {
      return ((document.getElementById("search-phone") || {}).value || "").trim();
    }
    if (searchType === "email") {
      return ((document.getElementById("search-email") || {}).value || "").trim();
    }
    if (searchType === "plate_number") {
      return ((document.getElementById("search-plate-number") || {}).value || "").trim();
    }
    if (searchType === "passport_number") {
      return ((document.getElementById("search-passport-number") || {}).value || "").trim();
    }
    return "";
  }

  function getQuerySummary() {
    var searchType = (hiddenType && hiddenType.value) || "username";
    var label = TYPE_LABELS[searchType] || "Search";
    return label + " · " + redactValue(getRawQueryValue(searchType), searchType);
  }

  function saveLastSearch() {
    try {
      var searchType = (hiddenType && hiddenType.value) || "username";
      sessionStorage.setItem(
        LAST_SEARCH_KEY,
        JSON.stringify({
          type: searchType,
          value: getRawQueryValue(searchType),
        })
      );
    } catch (err) {
      /* ignore */
    }
  }

  function restoreLastSearchUi() {
    if (!lastSearchWrap || !lastSearchBtn) return;
    try {
      var raw = sessionStorage.getItem(LAST_SEARCH_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!saved || VALID.indexOf(saved.type) < 0 || !(saved.value || "").trim()) return;
      lastSearchWrap.hidden = false;
      lastSearchBtn.textContent =
        "Repeat · " + TYPE_LABELS[saved.type] + " · " + redactValue(saved.value, saved.type);
      lastSearchBtn.onclick = function () {
        setTab(saved.type, false);
        if (saved.type === "name") {
          var parts = (saved.value || "").trim().split(/\s+/);
          var firstEl = document.getElementById("search-first-name");
          var lastEl = document.getElementById("search-last-name");
          if (firstEl) firstEl.value = parts.shift() || "";
          if (lastEl) lastEl.value = parts.join(" ") || "";
        } else {
          var fieldMap = {
            username: "search-username",
            phone: "search-phone",
            email: "search-email",
            plate_number: "search-plate-number",
            passport_number: "search-passport-number",
          };
          var input = document.getElementById(fieldMap[saved.type] || "");
          if (input) input.value = saved.value || "";
        }
        clearInlineError();
        form.requestSubmit();
      };
    } catch (err) {
      /* ignore */
    }
  }

  restoreLastSearchUi();

  var img = document.getElementById("search-captcha-img");
  var refresh = document.getElementById("search-captcha-refresh");
  if (img && refresh) {
    refresh.addEventListener("click", function () {
      img.src = refresh.getAttribute("data-captcha-url") + "?t=" + Date.now();
    });
  }

  var overlay = document.getElementById("search-loading-overlay");
  var overlayCard = document.getElementById("search-loading-overlay-card");
  var socialHostEls = [
    document.getElementById("search-social-host-a"),
    document.getElementById("search-social-host-b"),
    document.getElementById("search-social-host-c"),
  ];
  var socialPhaseEls = [
    document.getElementById("search-social-phase-a"),
    document.getElementById("search-social-phase-b"),
    document.getElementById("search-social-phase-c"),
  ];
  var progressWrap = document.getElementById("search-crawl-progress");
  var progressBar = document.getElementById("search-crawl-progress-bar");
  var queryEl = document.getElementById("search-job-query");
  var subtitleEl = document.getElementById("search-job-subtitle");
  var estimateEl = document.getElementById("search-job-estimate");
  var errorWrap = document.getElementById("search-job-error");
  var errorMessageEl = document.getElementById("search-job-error-message");
  var retryBtn = document.getElementById("search-job-retry");
  var copyErrorBtn = document.getElementById("search-job-copy-error");
  var stepsEl = document.getElementById("search-job-steps");
  var socialCrawl = document.getElementById("search-social-crawl");
  var lastErrorMessage = "";

  var lastHosts = ["", "", ""];
  var socialTickTimer = null;
  var estimateTimer = null;
  var isLocked = false;
  var osintDispose = null;
  var escapeHandler = null;
  var clickHandler = null;

  function pollJobUrl(jobId) {
    var base = (form.getAttribute("data-search-jobs-url") || "/app/search/jobs").replace(/\/$/, "");
    return base + "/" + encodeURIComponent(jobId);
  }

  function startOsintBg() {
    if (!overlay || osintDispose) return;
    var host = overlay.querySelector("[data-hero-osint-defer]");
    if (!host || !window.KryxHeroOsint || typeof window.KryxHeroOsint.initHost !== "function") return;
    osintDispose = window.KryxHeroOsint.initHost(host);
  }

  function clearSocialTick() {
    if (socialTickTimer) {
      clearTimeout(socialTickTimer);
      socialTickTimer = null;
    }
  }

  function clearEstimateTimer() {
    if (estimateTimer) {
      clearTimeout(estimateTimer);
      estimateTimer = null;
    }
  }

  function tickSocialCrawl() {
    var visible = [];
    var i;
    for (i = 0; i < socialHostEls.length; i += 1) {
      if (socialHostEls[i]) {
        lastHosts[i] = randomHostAvoid(lastHosts[i], visible);
        visible.push(lastHosts[i]);
        socialHostEls[i].textContent = lastHosts[i];
      }
      if (socialPhaseEls[i]) {
        socialPhaseEls[i].textContent = randomPick(SOCIAL_PHASES);
      }
    }
  }

  function startSocialCrawl() {
    clearSocialTick();
    var hasAny = socialHostEls.some(function (el) {
      return Boolean(el);
    });
    if (!hasAny) return;
    tickSocialCrawl();
    if (reducedMotion) return;
    function scheduleNext() {
      socialTickTimer = setTimeout(function () {
        tickSocialCrawl();
        scheduleNext();
      }, 2200 + Math.floor(Math.random() * 1800));
    }
    scheduleNext();
  }

  function setProgress(phase) {
    if (!progressWrap || !progressBar) return;
    if (phase === "queued") {
      progressWrap.setAttribute("data-progress-mode", "indeterminate");
      progressWrap.setAttribute("data-progress", "12");
    } else if (phase === "scanning") {
      progressWrap.setAttribute("data-progress-mode", "determinate");
      progressWrap.setAttribute("data-progress", "66");
    } else if (phase === "report") {
      progressWrap.setAttribute("data-progress-mode", "determinate");
      progressWrap.setAttribute("data-progress", "100");
    } else if (phase === "failed") {
      progressWrap.setAttribute("data-progress-mode", "determinate");
      progressWrap.setAttribute("data-progress", "0");
    }
  }

  function setSteps(phase) {
    if (!stepsEl) return;
    stepsEl.setAttribute("data-active-step", phase);
    var stepNodes = stepsEl.querySelectorAll(".search-loading-overlay-step");
    stepNodes.forEach(function (node) {
      var step = node.getAttribute("data-step");
      var done = false;
      var active = false;
      if (phase === "report") {
        done = step !== "report";
        active = step === "report";
      } else if (phase === "scanning") {
        done = step === "queued";
        active = step === "scanning";
      } else if (phase === "queued") {
        active = step === "queued";
      } else if (phase === "failed") {
        active = false;
        done = step === "queued";
      }
      node.classList.toggle("is-done", done);
      node.classList.toggle("is-active", active);
    });
  }

  function setJobStatus(status, upstreamStatus) {
    var badge = document.getElementById("search-job-status");
    var valueEl = document.getElementById("search-job-status-value");
    var phase = "queued";
    var label = "Queued";
    var subtitle = "Preparing your investigation…";

    if (status === "done") {
      phase = "report";
      label = "Complete — opening report";
      subtitle = "Report ready — redirecting…";
    } else if (status === "failed") {
      phase = "failed";
      label = "Failed";
      subtitle = "Something went wrong.";
    } else if (status === "running" && upstreamStatus === "queued") {
      phase = "queued";
      label = "Queued on search service";
      subtitle = "Waiting for a search slot…";
    } else if (status === "running") {
      phase = "scanning";
      label = "Scanning sources";
      subtitle = "Cross-referencing indexed sources…";
    }

    if (badge) badge.setAttribute("data-status", status || "queued");
    if (valueEl) valueEl.textContent = label;
    if (subtitleEl) subtitleEl.textContent = subtitle;
    if (overlayCard) {
      overlayCard.setAttribute("aria-label", label + ", step " + (phase === "report" ? "3" : phase === "scanning" ? "2" : "1") + " of 3");
    }
    setSteps(phase);
    setProgress(phase);

    if (status === "running" && !estimateTimer && estimateEl) {
      estimateTimer = setTimeout(function () {
        estimateEl.hidden = false;
      }, ESTIMATE_DELAY_MS);
    }
  }

  function hideSearchError() {
    if (errorWrap) errorWrap.hidden = true;
    if (errorMessageEl) errorMessageEl.textContent = "";
    if (socialCrawl) socialCrawl.hidden = false;
    lastErrorMessage = "";
  }

  function showSearchError(message) {
    lastErrorMessage = message || "Search failed.";
    setJobStatus("failed");
    if (errorWrap) errorWrap.hidden = false;
    if (errorMessageEl) errorMessageEl.textContent = lastErrorMessage;
    if (socialCrawl) socialCrawl.hidden = true;
    if (overlay) overlay.setAttribute("aria-busy", "false");
    isLocked = false;
    if (escapeHandler) {
      document.removeEventListener("keydown", escapeHandler, true);
      escapeHandler = null;
    }
    if (clickHandler) {
      document.removeEventListener("click", clickHandler, true);
      clickHandler = null;
    }
  }

  function resetSearchPanelUi() {
    form.classList.remove("search-form--loading");
    var panel = activePanel();
    if (panel) {
      panel.classList.remove("is-searching");
      var barSubmit = panel.querySelector(".landing-preview-bar-submit");
      if (barSubmit) {
        barSubmit.disabled = false;
        barSubmit.classList.remove("is-submitting");
        barSubmit.setAttribute("aria-busy", "false");
        var spinner = barSubmit.querySelector(".landing-preview-bar-submit-spinner");
        var icon = barSubmit.querySelector(".landing-preview-bar-submit-icon");
        if (spinner) spinner.hidden = true;
        if (icon) icon.hidden = false;
      }
    }
    if (overlay) {
      overlay.hidden = true;
      overlay.classList.remove("is-visible");
      overlay.setAttribute("aria-busy", "false");
    }
    if (document.body) document.body.classList.remove("search-page--loading");
    clearSocialTick();
    clearEstimateTimer();
    if (estimateEl) estimateEl.hidden = true;
    hideSearchError();
    if (typeof osintDispose === "function") {
      osintDispose();
      osintDispose = null;
    }
  }

  function unlockSearchUi() {
    isLocked = false;
    resetSearchPanelUi();
  }

  function lockInteractions() {
    if (isLocked) return;
    isLocked = true;
    escapeHandler = function (event) {
      if (!isLocked) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (window.confirm("Leave search in progress? You may need to run the query again.")) {
          unlockSearchUi();
        }
      }
    };
    clickHandler = function (event) {
      if (!isLocked) return;
      var card = document.getElementById("search-loading-overlay-card");
      if (card && card.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", escapeHandler, true);
    document.addEventListener("click", clickHandler, true);
  }

  function beginSearchOverlay() {
    hideSearchError();
    saveLastSearch();
    if (queryEl) {
      queryEl.textContent = getQuerySummary();
      queryEl.hidden = false;
    }
    form.classList.add("search-form--loading");
    var panel = activePanel();
    if (panel) {
      panel.classList.add("is-searching");
      var barSubmit = panel.querySelector(".landing-preview-bar-submit");
      if (barSubmit) {
        barSubmit.disabled = true;
        barSubmit.classList.add("is-submitting");
        barSubmit.setAttribute("aria-busy", "true");
        var spinner = barSubmit.querySelector(".landing-preview-bar-submit-spinner");
        var icon = barSubmit.querySelector(".landing-preview-bar-submit-icon");
        if (spinner) spinner.hidden = false;
        if (icon) icon.hidden = true;
      }
    }
    if (overlay) {
      overlay.hidden = false;
      overlay.setAttribute("aria-busy", "true");
      if (!reducedMotion) {
        requestAnimationFrame(function () {
          overlay.classList.add("is-visible");
        });
      } else {
        overlay.classList.add("is-visible");
      }
    }
    if (document.body) document.body.classList.add("search-page--loading");
    startOsintBg();
    startSocialCrawl();
    lockInteractions();
  }

  function pollSearchJob(jobId) {
    var pollMs = 1500;
    function tick() {
      fetch(pollJobUrl(jobId), {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      })
        .then(function (res) {
          return res.json().then(function (body) {
            return { ok: res.ok, body: body };
          });
        })
        .then(function (result) {
          if (!result.ok || !result.body || !result.body.ok) {
            throw new Error((result.body && result.body.error) || "Could not read search status.");
          }
          var data = result.body;
          setJobStatus(data.status, data.upstream_status);
          if (data.status === "done" && data.redirect) {
            setTimeout(function () {
              window.location.href = data.redirect;
            }, SUCCESS_REDIRECT_MS);
            return;
          }
          if (data.status === "failed") {
            throw new Error(data.error || "Search failed.");
          }
          setTimeout(tick, pollMs);
        })
        .catch(function (err) {
          showSearchError(err.message || "Search failed.");
        });
    }
    tick();
  }

  function startAsyncSearch() {
    var jobsUrl = form.getAttribute("data-search-jobs-url");
    if (!jobsUrl || typeof window.fetch !== "function") {
      beginSearchOverlay();
      setJobStatus("running");
      return;
    }

    beginSearchOverlay();
    setJobStatus("queued");

    var formData = new FormData(form);
    var csrfToken = formData.get("csrf_token") || "";

    fetch(jobsUrl, {
      method: "POST",
      body: formData,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "X-CSRF-Token": csrfToken,
      },
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok || !result.body || !result.body.ok || !result.body.job_id) {
          throw new Error((result.body && result.body.error) || "Search could not start.");
        }
        setJobStatus(result.body.status || "queued");
        pollSearchJob(result.body.job_id);
      })
      .catch(function (err) {
        showSearchError(err.message || "Search could not start.");
      });
  }

  if (retryBtn) {
    retryBtn.addEventListener("click", function () {
      unlockSearchUi();
    });
  }

  if (copyErrorBtn) {
    copyErrorBtn.addEventListener("click", function () {
      var text = lastErrorMessage || (errorMessageEl && errorMessageEl.textContent) || "";
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () {
          window.prompt("Copy error message:", text);
        });
      } else {
        window.prompt("Copy error message:", text);
      }
    });
  }

  form.addEventListener("submit", function (event) {
    if (!validateBeforeSubmit()) {
      event.preventDefault();
      return;
    }

    var jobsUrl = form.getAttribute("data-search-jobs-url");
    if (!jobsUrl || typeof window.fetch !== "function") {
      beginSearchOverlay();
      setJobStatus("running");
      return;
    }

    event.preventDefault();
    startAsyncSearch();
  });
})();
