(function () {
  function readData() {
    var el = document.getElementById("client-dashboard-data");
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || "{}");
    } catch (e) {
      return null;
    }
  }

  function boot() {
    var C = readData();
    if (!C || !window.Chart) return;

    var creditsEl = document.getElementById("chart-credits");
    if (creditsEl) {
      var wallet = Number(C.credits_remaining) || 0;
      var monthlyRem = Number(C.monthly_remaining) || 0;
      new Chart(creditsEl, {
        type: "doughnut",
        data: {
          labels: ["Wallet credits", "Period cap remaining"],
          datasets: [
            {
              data: [wallet, monthlyRem],
              backgroundColor: ["rgba(0, 210, 239, 0.85)", "rgba(136, 136, 160, 0.45)"],
              borderWidth: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: "bottom" } },
        },
      });
    }

    var dailyEl = document.getElementById("chart-daily");
    if (dailyEl) {
      new Chart(dailyEl, {
        type: "line",
        data: {
          labels: C.day_labels || [],
          datasets: [
            {
              label: "Searches",
              data: C.day_counts || [],
              borderColor: "rgba(0, 210, 239, 0.9)",
              backgroundColor: "rgba(0, 210, 239, 0.15)",
              fill: true,
              tension: 0.25,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true, ticks: { precision: 0 } },
          },
        },
      });
    }

    var monthlyEl = document.getElementById("chart-monthly");
    if (monthlyEl) {
      new Chart(monthlyEl, {
        type: "bar",
        data: {
          labels: C.month_labels || [],
          datasets: [
            {
              label: "Searches",
              data: C.month_counts || [],
              backgroundColor: "rgba(5, 223, 114, 0.75)",
              borderRadius: 6,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        },
      });
    }

    var actorsEl = document.getElementById("chart-actors");
    if (actorsEl && (C.actor_labels || []).length) {
      new Chart(actorsEl, {
        type: "bar",
        data: {
          labels: C.actor_labels || [],
          datasets: [
            {
              label: "Searches",
              data: C.actor_counts || [],
              backgroundColor: "rgba(252, 187, 0, 0.8)",
              borderRadius: 6,
            },
          ],
        },
        options: {
          indexAxis: "y",
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
        },
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
