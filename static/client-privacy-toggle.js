(function () {
  "use strict";

  function bindToggle(buttonId, valueSelector) {
    var toggle = document.getElementById(buttonId);
    if (!toggle) return;
    var key = "kryx_client_reveal_" + buttonId;
    function apply(reveal) {
      document.querySelectorAll(valueSelector).forEach(function (el) {
        el.textContent = reveal ? el.getAttribute("data-full") || "" : el.getAttribute("data-masked") || "";
      });
      toggle.setAttribute("aria-pressed", reveal ? "true" : "false");
      toggle.textContent = reveal ? "Hide query values" : "Show query values";
      try {
        localStorage.setItem(key, reveal ? "1" : "0");
      } catch (_e) {}
    }
    var stored = false;
    try {
      stored = localStorage.getItem(key) === "1";
    } catch (_e2) {}
    apply(stored);
    toggle.addEventListener("click", function () {
      apply(toggle.getAttribute("aria-pressed") !== "true");
    });
  }

  bindToggle("client-logs-reveal-toggle", ".client-log-query-value[data-masked]");
  bindToggle("client-dashboard-reveal-toggle", ".client-recent-value[data-masked]");
  bindToggle("client-team-reveal-toggle", ".client-recent-value[data-masked]");
})();
