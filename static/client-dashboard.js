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

  function readSystemConfig() {
    var el = document.getElementById("client-system-stats-config");
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || "{}");
    } catch (e) {
      return null;
    }
  }

  function formatSampleTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function initSystemCharts() {
    var cfg = readSystemConfig();
    if (!cfg || !window.Chart) return;

    var pollMs = 5000;
    var maxPoints = 60;
    var lineScale = {
      min: 0,
      max: 100,
      ticks: {
        callback: function (value) {
          return value + "%";
        },
      },
      grid: { color: "rgba(255,255,255,0.06)" },
    };
    var linePlugins = {
      legend: { position: "top", labels: { boxWidth: 12, padding: 12 } },
      tooltip: {
        callbacks: {
          label: function (ctx) {
            return "Used: " + ctx.parsed.y.toFixed(1) + "%";
          },
        },
      },
    };
    var lineOptsBase = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          grid: { color: "rgba(255,255,255,0.06)" },
          ticks: { maxRotation: 0, maxTicksLimit: 8 },
        },
        y: lineScale,
      },
    };

    var memoryCanvas = document.getElementById("client-chart-memory");
    var memoryLive = document.getElementById("client-memory-live");
    if (memoryCanvas && memoryLive && cfg.memory_url) {
      var memoryLabels = [];
      var memorySeries = [];
      var memoryChart = new Chart(memoryCanvas, {
        type: "line",
        data: {
          labels: memoryLabels,
          datasets: [
            {
              label: "Memory used (%)",
              data: memorySeries,
              borderColor: "#3080ff",
              backgroundColor: "rgba(48, 128, 255, 0.12)",
              fill: true,
              tension: 0.25,
              pointRadius: 0,
              pointHoverRadius: 3,
            },
          ],
        },
        options: Object.assign({}, lineOptsBase, { plugins: linePlugins }),
      });

      function pollMemory() {
        fetch(cfg.memory_url, {
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
              memoryLive.textContent =
                (result.body && result.body.error) || "Unable to read system memory.";
              return;
            }
            var payload = result.body;
            memoryLabels.push(formatSampleTime(payload.timestamp));
            memorySeries.push(Number(payload.percent) || 0);
            if (memoryLabels.length > maxPoints) {
              memoryLabels.shift();
              memorySeries.shift();
            }
            memoryLive.textContent =
              payload.used_gb.toFixed(2) +
              " GB used · " +
              payload.available_gb.toFixed(2) +
              " GB free · " +
              payload.total_gb.toFixed(2) +
              " GB total · " +
              Number(payload.percent).toFixed(1) +
              "%";
            memoryChart.update("none");
          })
          .catch(function () {
            memoryLive.textContent = "Unable to read system memory.";
          });
      }

      pollMemory();
      setInterval(pollMemory, pollMs);
    }

    var cpuCanvas = document.getElementById("client-chart-cpu");
    var cpuLive = document.getElementById("client-cpu-live");
    if (cpuCanvas && cpuLive && cfg.cpu_url) {
      var cpuLabels = [];
      var cpuSeries = [];
      var cpuSampleCount = 0;
      var cpuChart = new Chart(cpuCanvas, {
        type: "line",
        data: {
          labels: cpuLabels,
          datasets: [
            {
              label: "CPU used (%)",
              data: cpuSeries,
              borderColor: "#00d2ef",
              backgroundColor: "rgba(0, 210, 239, 0.12)",
              fill: true,
              tension: 0.25,
              pointRadius: 0,
              pointHoverRadius: 3,
            },
          ],
        },
        options: Object.assign({}, lineOptsBase, { plugins: linePlugins }),
      });

      function pollCpu() {
        fetch(cfg.cpu_url, {
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
              cpuLive.textContent =
                (result.body && result.body.error) || "Unable to read system CPU.";
              return;
            }
            var payload = result.body;
            cpuSampleCount += 1;
            if (cpuSampleCount === 1) {
              cpuLive.textContent = "Collecting baseline…";
              return;
            }
            cpuLabels.push(formatSampleTime(payload.timestamp));
            cpuSeries.push(Number(payload.percent) || 0);
            if (cpuLabels.length > maxPoints) {
              cpuLabels.shift();
              cpuSeries.shift();
            }
            var coresLabel =
              payload.logical_cpus != null ? payload.logical_cpus + " logical cores · " : "";
            cpuLive.textContent =
              coresLabel + Number(payload.percent).toFixed(1) + "% CPU in use (since last sample)";
            cpuChart.update("none");
          })
          .catch(function () {
            cpuLive.textContent = "Unable to read system CPU.";
          });
      }

      pollCpu();
      setInterval(pollCpu, pollMs);
    }
  }

  function boot() {
    if (!window.Chart) return;
    initSystemCharts();

    var C = readData();
    if (!C) return;

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
