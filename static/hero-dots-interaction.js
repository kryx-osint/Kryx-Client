(function () {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  var hosts = document.querySelectorAll(".hero-section, .page-dots-shell");
  if (!hosts.length) {
    return;
  }

  var blurRadiusPx = 120;
  var rafId = 0;

  hosts.forEach(function (host) {
    var surface = host.querySelector("[data-hero-dots]");
    if (!surface) {
      return;
    }

    function setSpot(clientX, clientY) {
      var rect = host.getBoundingClientRect();
      var x = clientX - rect.left;
      var y = clientY - rect.top;
      surface.style.setProperty("--hero-dots-x", x + "px");
      surface.style.setProperty("--hero-dots-y", y + "px");
      surface.style.setProperty("--hero-dots-r", blurRadiusPx + "px");
      surface.classList.add("is-active");
    }

    host.addEventListener(
      "mousemove",
      function (event) {
        var x = event.clientX;
        var y = event.clientY;
        if (rafId) {
          cancelAnimationFrame(rafId);
        }
        rafId = requestAnimationFrame(function () {
          rafId = 0;
          setSpot(x, y);
        });
      },
      { passive: true }
    );

    host.addEventListener("mouseleave", function () {
      surface.classList.remove("is-active");
    });
  });
})();
