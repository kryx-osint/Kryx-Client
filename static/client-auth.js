(function () {
  "use strict";

  var TAGLINES = [
    "Shared investigations for your agency network.",
    "Deploy once — your team signs in on the LAN.",
    "Credits, reports, and audit logs in one place.",
    "Built for owner-led investigation teams.",
  ];

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function initTaglineRotator() {
    var el = document.getElementById("client-login-tagline-text");
    if (!el || TAGLINES.length < 2 || prefersReducedMotion()) return;
    var idx = 0;
    el.textContent = TAGLINES[0];
    setInterval(function () {
      idx = (idx + 1) % TAGLINES.length;
      el.classList.add("is-fading");
      setTimeout(function () {
        el.textContent = TAGLINES[idx];
        el.classList.remove("is-fading");
      }, 280);
    }, 4200);
  }

  function initReveal() {
    var root = document.getElementById("client-login-root");
    if (!root) return;
    requestAnimationFrame(function () {
      root.classList.add("client-login-grid--ready");
    });
  }

  function initFormSubmit() {
    var form = document.getElementById("client-login-form");
    var btn = document.getElementById("client-login-submit");
    if (!form || !btn) return;
    form.addEventListener("submit", function () {
      btn.classList.add("is-submitting");
      btn.setAttribute("aria-busy", "true");
      var spinner = btn.querySelector(".client-login-submit-spinner");
      if (spinner) spinner.hidden = false;
    });
  }

  function initInputGlow() {
    document.querySelectorAll(".client-login-input-wrap .login-input").forEach(function (input) {
      var wrap = input.closest(".client-login-input-wrap");
      if (!wrap) return;
      input.addEventListener("focus", function () {
        wrap.classList.add("is-focused");
      });
      input.addEventListener("blur", function () {
        wrap.classList.remove("is-focused");
      });
    });
  }

  function boot() {
    initReveal();
    initTaglineRotator();
    initFormSubmit();
    initInputGlow();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
