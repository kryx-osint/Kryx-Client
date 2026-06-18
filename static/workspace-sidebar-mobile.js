(function () {
  "use strict";

  var MOBILE_MAX_WIDTH = 768;

  function isMobile() {
    return window.innerWidth <= MOBILE_MAX_WIDTH;
  }

  function initWorkspaceSidebar() {
    var layout = document.querySelector(".workspace-layout");
    var toggle = document.getElementById("workspace-sidebar-toggle");
    var panel = document.getElementById("workspace-sidebar-panel");
    var backdrop = document.getElementById("workspace-sidebar-backdrop");
    if (!layout || !toggle || !panel || !backdrop) return;

    function setOpen(open) {
      layout.classList.toggle("workspace-layout--nav-open", open);
      toggle.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Close workspace menu" : "Open workspace menu");
      backdrop.hidden = !open;
      document.body.classList.toggle("workspace-nav-open", open && isMobile());
    }

    function closeMenu() {
      setOpen(false);
    }

    function openMenu() {
      if (!isMobile()) return;
      setOpen(true);
    }

    toggle.addEventListener("click", function () {
      if (!isMobile()) return;
      setOpen(!layout.classList.contains("workspace-layout--nav-open"));
    });

    backdrop.addEventListener("click", closeMenu);

    panel.addEventListener("click", function (event) {
      if (!isMobile()) return;
      if (event.target.closest("a")) closeMenu();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeMenu();
    });

    window.addEventListener("resize", function () {
      if (!isMobile()) closeMenu();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initWorkspaceSidebar);
  } else {
    initWorkspaceSidebar();
  }
})();
