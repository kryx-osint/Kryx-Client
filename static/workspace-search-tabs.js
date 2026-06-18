(function () {
  "use strict";

  var VALID = ["username", "name", "phone", "email", "plate_number", "passport_number"];

  /** Hostnames shown during loading (decorative; not real requests to these sites from this UI). */
  var SOCIAL_PLATFORMS = [
    "gxx.ph",
    "oxx.gxx.ph",
    "cxxxxxxx.gxx.ph",
    "cxx.gxx.ph",
    "cxx.gxx.ph",
    "sxxxxx.gxx.ph",
    "cxxxxxxx.gxx.ph",
    "jxxxxxxxx.gxx.ph",
    "dxx.gxx.ph",
    "dxx.gxx.ph",
    "dxxx.gxx.ph",
    "dxx.gxx.ph",
    "dxxxx.gxx.ph",
    "dxx.gxx.ph",
    "dx.gxx.ph",
    "dxx.gxx.ph",
    "dxx.gxx.ph",
    "dxx.gxx.ph",
    "dxx.gxx.ph",
    "dxx.gxx.ph",
    "dxxx.gxx.ph",
    "dxxx.gxx.ph",
    "dxxx.gxx.ph",
    "dxxx.gxx.ph",
    "dxxx.gxx.ph",
    "dxxx.gxx.ph",
    "txxxxxx.gxx.ph",
    "dxxx.gxx.ph",
    "dxxxx.gxx.ph",
    "dxx.gxx.ph",
    "bxx.gxx.ph",
    "nxxx.gxx.ph",
    "txxxxxxx.gxx.ph",
    "sxx.gxx.ph",
    "axx.mxx.ph",
    "axxx.mxx.ph",
    "nxxx.mxx.ph",
    "pxx.mxx.ph",
    "pxx.gxx.ph",
    "nxxx.gxx.ph",
    "sxx.gxx.ph",
    "pxxxxxxxxx.gxx.ph",
    "pxxxxxxxxxx.gxx.ph",
    "gxxx.gxx.ph",
    "pxx.gxx.ph",
    "ixxxxxxxxxx.gxx.ph",
    "cxxxxxx.gxx.ph",
    "fxx.gxx.ph",
    "pxx.gxx.ph",
    "mxx.ph",
    "fxxxxxxx.cxx",
    "ixxxxxxxx.cxx",
    "txxxxxx.nxx",
    "x.cxx",
    "lxxxxxxx.cxx",
    "rxxxxx.cxx",
    "txxxxx.cxx",
    "yxxxxxx.cxx",
    "txxxxxxx.oxx",
    "dxxxxxx.cxx",
    "sxxxxxxx.cxx",
    "pxxxxxxxx.cxx",
    "vx.cxx",
    "wxxxx.cxx",
    "mxxxxxxx.sxxxxx",
    "bxxxxxx.axx",
    "qxxxx.cxx",
    "mxxxxx.cxx",
    "gxxxxx.cxx",
    "gxxxxx.cxx",
    "bxxxxxxxx.oxx",
    "txxxxx.tx",
    "kxxx.cxx",
    "rxxxxx.cxx",
    "bxxxxxx.cxx",
    "dxxxxxxxxx.cxx",
    "vxxxx.cxx",
    "txxxx.lxxx",
    "bxxx.tx",
    "sxxxxx.oxx",
    "wxxxxxxx.cxx",
    "mxxxxxxxx.cxx",
    "lxxx.mx",
    "vxxxx.cxx",
    "wxxxxxx.cxx",
    "kxxxx.cxx",
    "ixx.ix",
    "wxxx.cxx",
    "exxxxxx.ix",
    "sxxxxxxxxx.cxx",
    "txxxxxx.cxx",
    "qx.cxx",
    "ox.rx",
    "txxxxxxxxxx.cxx",
    "pxxxxx.cxx",
    "gxx.cxx",
    "lxxxx.vxxxx",
    "cxxxxxxxx.cxx",
    "fxxxxxx.cxx",
    "dxxxxxxxxx.cxx",
    "bxxxxxx.nxx",
    "dxxxxxxx.cxx",
    "sxxxxxxx.cxx",
    "pxxxxxx.cxx",
    "oxxxxxxxx.cxx",
    "mxxxxx.cxx",
    "nxxxxxxx.cxx",
    "dxxxxxx.gx",
  ];

  var SOCIAL_PHASES = [
    "connecting",
    "resolving",
    "routing",
    "handshake",
    "fetching",
    "scanning",
    "queued",
    "matching",
    "indexed",
    "probing",
  ];

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

  var root = document.querySelector("[data-search-tabs]");
  if (!root) return;
  var form = root.closest("form");

  var hiddenType = document.getElementById("search-type-input");
  var tabs = root.querySelectorAll("[data-search-tab]");
  var panels = root.querySelectorAll("[data-search-panel]");
  var hints = root.querySelectorAll("[data-hint]");

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

  function searchFieldsValid(searchType) {
    if (searchType === "name") {
      var first = (document.getElementById("search-first-name") || {}).value || "";
      var last = (document.getElementById("search-last-name") || {}).value || "";
      return Boolean(first.trim() && last.trim());
    }
    if (searchType === "username") {
      var username = (document.getElementById("search-username") || {}).value || "";
      return Boolean(username.trim());
    }
    if (searchType === "phone") {
      var phone = (document.getElementById("search-phone") || {}).value || "";
      return Boolean(phone.trim());
    }
    if (searchType === "email") {
      var email = (document.getElementById("search-email") || {}).value || "";
      return Boolean(email.trim());
    }
    if (searchType === "plate_number") {
      var plate = (document.getElementById("search-plate-number") || {}).value || "";
      return Boolean(plate.trim());
    }
    if (searchType === "passport_number") {
      var passport = (document.getElementById("search-passport-number") || {}).value || "";
      return Boolean(passport.trim());
    }
    return true;
  }

  var img = document.getElementById("search-captcha-img");
  var refresh = document.getElementById("search-captcha-refresh");
  if (img && refresh) {
    refresh.addEventListener("click", function () {
      img.src = refresh.getAttribute("data-captcha-url") + "?t=" + Date.now();
    });
  }

  if (form) {
    var overlay = document.getElementById("search-loading-overlay");
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
    var lastHosts = ["", "", ""];
    var socialTickTimer = null;
    var isLocked = false;

    function clearSocialTick() {
      if (socialTickTimer) {
        clearTimeout(socialTickTimer);
        socialTickTimer = null;
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
      var hasAny = false;
      var j;
      for (j = 0; j < socialHostEls.length; j += 1) {
        if (socialHostEls[j]) {
          hasAny = true;
          break;
        }
      }
      if (!hasAny) return;
      tickSocialCrawl();
      function scheduleNext() {
        socialTickTimer = setTimeout(function () {
          tickSocialCrawl();
          scheduleNext();
        }, 320 + Math.floor(Math.random() * 520));
      }
      scheduleNext();
    }

    function lockInteractions() {
      if (isLocked) return;
      isLocked = true;
      document.addEventListener(
        "keydown",
        function (event) {
          if (!isLocked) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
          }
        },
        true
      );
      document.addEventListener(
        "click",
        function (event) {
          if (!isLocked) return;
          event.preventDefault();
          event.stopPropagation();
        },
        true
      );
    }

    form.addEventListener("submit", function (event) {
      var searchType = (hiddenType && hiddenType.value) || "username";
      if (!searchFieldsValid(searchType)) {
        event.preventDefault();
        return;
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
      }
      if (document.body) {
        document.body.classList.add("search-page--loading");
      }
      startSocialCrawl();
      lockInteractions();
    });
  }
})();
