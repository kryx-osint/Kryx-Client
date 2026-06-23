(function () {
  "use strict";

  var dismissMs = { error: 9000, info: 5500, default: 6000 };

  function dismissToast(toast) {
    if (!toast || toast.classList.contains("client-toast--leaving")) return;
    toast.classList.add("client-toast--leaving");
    window.setTimeout(function () {
      toast.remove();
      var stack = document.querySelector(".client-toast-stack");
      if (stack && !stack.children.length) stack.remove();
    }, 220);
  }

  function bindToast(toast) {
    if (!toast || toast.dataset.bound === "1") return;
    toast.dataset.bound = "1";
    var btn = toast.querySelector(".client-toast-dismiss");
    if (btn) {
      btn.addEventListener("click", function () {
        dismissToast(toast);
      });
    }
    var category = "default";
    if (toast.classList.contains("client-toast--error")) category = "error";
    else if (toast.classList.contains("client-toast--info")) category = "info";
    window.setTimeout(function () {
      dismissToast(toast);
    }, dismissMs[category] || dismissMs.default);
  }

  function init() {
    document.querySelectorAll("[data-client-toast]").forEach(bindToast);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
