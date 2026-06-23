(function () {
  "use strict";

  function readLiveConfig() {
    var el = document.getElementById("client-dashboard-live-config");
    if (!el) return {};
    try {
      return JSON.parse(el.textContent || "{}");
    } catch (e) {
      return {};
    }
  }

  var liveConfig = readLiveConfig();
  var liveUrl = liveConfig.live_url || "/dashboard/api/live";
  var teamMode = liveUrl.indexOf("/my-dashboard/") !== -1;

  var banner = document.getElementById("client-api-banner");
  var bannerText = document.getElementById("client-api-banner-text");
  var healthBanner = document.getElementById("client-search-health-banner");
  var healthText = document.getElementById("client-search-health-text");
  var jobsSection = document.getElementById("client-dashboard-jobs");
  var jobsList = document.getElementById("client-dashboard-jobs-list");
  var creditsEl = document.getElementById("team-stat-credits");
  var periodEl = document.getElementById("team-stat-period");
  var pollMs = 30000;
  var busy = false;

  function applyApiError(error) {
    if (!banner) return;
    if (error) {
      banner.hidden = false;
      if (bannerText) bannerText.textContent = error;
    } else {
      banner.hidden = true;
    }
  }

  function applySearchHealth(data) {
    if (!healthBanner) return;
    var degraded = !data || !data.reachable || data.degraded;
    healthBanner.hidden = !degraded;
    if (healthText && data) {
      if (!data.reachable) {
        healthText.textContent =
          "Could not reach Kryx search health endpoint. Kryx API may work but upstream searches could still fail.";
      } else {
        healthText.textContent =
          (data.live_count || 0) +
          " of " +
          (data.total_count || 0) +
          " search servers live. Investigations may be slow or fail until upstream recovers.";
      }
    }
  }

  function applyAccount(account) {
    if (!account) return;
    if (creditsEl) creditsEl.textContent = String(account.credits != null ? account.credits : "—");
    if (periodEl) {
      var limit = Number(account.monthly_search_limit) || 0;
      periodEl.textContent = limit
        ? String(account.monthly_search_used || 0) + " / " + String(limit)
        : "—";
    }
  }

  function renderJobs(jobs) {
    if (!jobsList || !jobsSection) return;
    jobsList.innerHTML = "";
    if (!Array.isArray(jobs) || !jobs.length) {
      jobsSection.hidden = true;
      return;
    }
    jobsSection.hidden = false;
    jobs.forEach(function (job) {
      if (!job) return;
      var li = document.createElement("li");
      li.className = "client-job-item";
      var meta = teamMode
        ? (job.search_type || "search").replace(/_/g, " ") + " · " + (job.age_label || "—")
        : (job.actor || "user") +
          " · " +
          (job.search_type || "search").replace(/_/g, " ") +
          " · " +
          (job.age_label || "—");
      li.innerHTML =
        '<span class="client-job-status client-job-status--' +
        (job.status || "queued") +
        '">' +
        (job.status || "queued") +
        "</span>" +
        "<span>" +
        meta +
        "</span>" +
        (job.error ? '<span class="client-job-error">' + job.error + "</span>" : "") +
        '<a href="/search?type=' +
        encodeURIComponent(job.search_type || "username") +
        '" class="link-animated link-animated-cyan text-sm">Open search</a>';
      jobsList.appendChild(li);
    });
  }

  function refreshLive() {
    if (busy) return;
    busy = true;
    fetch(liveUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (body) {
        if (!body || !body.ok) return;
        applyApiError(body.api_error || "");
        applySearchHealth(body.search_health);
        applyAccount(body.account);
        renderJobs(body.active_jobs);
      })
      .catch(function () {})
      .finally(function () {
        busy = false;
      });
  }

  var refreshBtn = document.getElementById("client-dashboard-refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", refreshLive);
  if (jobsSection || banner || healthBanner || creditsEl) {
    refreshLive();
    setInterval(refreshLive, pollMs);
  }
})();
