/**
 * Shared demo data + contextual intelligence HTML builder.
 * Loaded before dashboard-preview.js and contextual-page.js
 */
(function () {
  "use strict";

  var CONTEXT_ALIASES = ["Juan Dela Cruz", "JuanDC", "juandc", "@juandelacruz"];
  var CONTEXT_STATS = [
    { key: "Platforms Found", value: "8", accent: "text-cyan-400" },
    { key: "Breach Exposure", value: "2", accent: "text-red-400" },
    { key: "Earliest Activity", value: "2019", accent: "text-amber-400" },
    { key: "Most Active", value: "Telegram", accent: "text-green-400" },
  ];
  var LINKED_ACCOUNTS = [
    { platform: "Telegram", handle: "@juandelacruz" },
    { platform: "GitHub", handle: "@juandelacruz" },
    { platform: "Discord", handle: "juandelacruz" },
    { platform: "TikTok", handle: "@juandelacruz" },
    { platform: "LinkedIn", handle: "juandelacruz" },
    { platform: "X", handle: "@juandelacruz" },
    { platform: "Bluesky", handle: "@juandelacruz.bsky.social" },
    { platform: "Threads", handle: "@juandelacruz" },
  ];
  var TIMELINE = [
    { date: "2019-03-15", event: "Telegram account created", source: "Telegram", category: "account" },
    { date: "2020-06-22", event: "GitHub profile registered", source: "GitHub", category: "account" },
    { date: "2021-01-10", event: "LinkedIn profile created", source: "LinkedIn", category: "account" },
    { date: "2022-08-05", event: "Appeared in data breach", source: "Breach Database", category: "breach" },
    { date: "2023-04-18", event: "TikTok account registered", source: "TikTok", category: "account" },
    { date: "2024-01-15", event: "Bluesky profile created", source: "Bluesky", category: "account" },
    { date: "2024-11-30", event: "Appeared in credential leak", source: "Breach Database", category: "breach" },
  ];

  var TIMELINE_DOT = { account: "tl-dot-account", activity: "tl-dot-activity", breach: "tl-dot-breach", infrastructure: "tl-dot-infra" };
  var TIMELINE_BADGE = {
    account: "tl-badge-account",
    activity: "tl-badge-activity",
    breach: "tl-badge-breach",
    infrastructure: "tl-badge-infra",
  };

  var GRAPH_ORBIT = [
    { label: "Telegram", x: 20, y: 15, color: "#22c55e" },
    { label: "GitHub", x: 80, y: 15, color: "#22c55e" },
    { label: "Discord", x: 90, y: 50, color: "#22c55e" },
    { label: "TikTok", x: 80, y: 85, color: "#22c55e" },
    { label: "Breach", x: 20, y: 85, color: "#ef4444" },
    { label: "LinkedIn", x: 10, y: 50, color: "#22c55e" },
  ];

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function buildContextualHTML() {
    var aliases = CONTEXT_ALIASES.map(function (a) {
      return '<span class="ctx-alias">' + escapeHtml(a) + "</span>";
    }).join("");
    var stats = CONTEXT_STATS.map(function (s) {
      return (
        '<div class="stat-cell"><p class="text-10px font-mono uppercase tracking-wider text-muted-foreground">' +
        escapeHtml(s.key) +
        '</p><p class="text-lg font-bold ' +
        s.accent +
        '">' +
        escapeHtml(s.value) +
        "</p></div>"
      );
    }).join("");
    var linked = LINKED_ACCOUNTS.map(function (l) {
      return (
        '<span class="ctx-linked-chip"><span class="ctx-linked-dot"></span>' +
        escapeHtml(l.platform) +
        '<span class="text-muted-foreground">' +
        escapeHtml(l.handle) +
        "</span></span>"
      );
    }).join("");
    var timeline = TIMELINE.map(function (ev) {
      var d = new Date(ev.date);
      var ds = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      return (
        '<div class="ctx-tl-row">' +
        '<div class="ctx-tl-dot ' +
        (TIMELINE_DOT[ev.category] || "tl-dot-infra") +
        '"></div>' +
        '<div class="ctx-tl-body">' +
        '<div class="ctx-tl-meta"><span class="text-10px font-mono text-muted-foreground">' +
        escapeHtml(ds) +
        '</span><span class="ctx-tl-cat ' +
        (TIMELINE_BADGE[ev.category] || "") +
        '">' +
        escapeHtml(ev.category) +
        "</span></div>" +
        '<p class="text-xs text-foreground">' +
        escapeHtml(ev.event) +
        '</p><p class="text-10px text-muted-foreground font-mono">' +
        escapeHtml(ev.source) +
        "</p></div></div>"
      );
    }).join("");

    var graphLines = GRAPH_ORBIT.map(function (g) {
      return (
        "<line x1=\"50\" y1=\"50\" x2=\"" +
        g.x +
        "\" y2=\"" +
        g.y +
        '" stroke="#585b70" stroke-width="0.35" opacity="0.4"/>'
      );
    }).join("");
    var graphNodes = GRAPH_ORBIT.map(function (g) {
      return (
        '<div class="ctx-graph-node" style="left:' +
        g.x +
        "%;top:" +
        g.y +
        '%"><div class="ctx-graph-orb" style="background:' +
        g.color +
        "15;border-color:" +
        g.color +
        '50"><span style="color:' +
        g.color +
        ';font-size:7px;font-family:JetBrains Mono,monospace;font-weight:700">' +
        escapeHtml(g.label.slice(0, 2).toUpperCase()) +
        '</span></div><p class="ctx-graph-lbl">' +
        escapeHtml(g.label) +
        "</p></div>"
      );
    }).join("");

    return (
      '<div class="ctx-card dashboard-shell">' +
      '<div class="px-5 py-3 border-b"><span class="text-xs font-mono uppercase tracking-wider text-cyan-400">Contextual Intelligence</span></div>' +
      '<div class="px-5 py-4 border-b">' +
      '<div class="ctx-identity-row">' +
      '<div class="ctx-avatar"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>' +
      '<div class="flex-1 min-w-0">' +
      '<div class="flex items-center gap-2 mb-1 flex-wrap">' +
      '<span class="text-lg font-bold">juandelacruz</span>' +
      '<span class="ctx-badge ctx-badge-cyan">username</span>' +
      '<span class="ctx-badge ctx-badge-red">2 BREACHES</span></div>' +
      '<div class="flex flex-wrap gap-1-5 mt-2">' +
      aliases +
      "</div></div></div>" +
      '<div class="stat-grid">' +
      stats +
      "</div></div>" +
      '<div class="px-5 py-4 border-b">' +
      '<p class="text-10px font-mono uppercase tracking-wider text-muted-foreground mb-3">Linked Accounts (' +
      LINKED_ACCOUNTS.length +
      ")</p>" +
      '<div class="ctx-linked-row">' +
      linked +
      "</div></div>" +
      '<div class="ctx-two-col">' +
      '<div class="ctx-tl-col border-r">' +
      '<p class="text-10px font-mono uppercase tracking-wider text-muted-foreground mb-3">Timeline (' +
      TIMELINE.length +
      ' events)</p>' +
      '<div class="ctx-tl-track">' +
      '<div class="ctx-tl-line"></div>' +
      timeline +
      "</div></div>" +
      '<div class="ctx-graph-col">' +
      '<p class="text-10px font-mono uppercase tracking-wider text-muted-foreground mb-3">Relationship Graph</p>' +
      '<div class="ctx-graph-stage">' +
      '<svg class="ctx-graph-line-svg" viewBox="0 0 100 100" preserveAspectRatio="none">' +
      graphLines +
      "</svg>" +
      '<div class="ctx-graph-center">' +
      '<div class="ctx-graph-center-ring"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-cyan-400"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div></div>' +
      graphNodes +
      "</div>" +
      '<div class="ctx-graph-legend">' +
      '<div class="ctx-leg"><span class="ctx-leg-dot bg-cyan"></span><span class="text-9px text-muted-foreground font-mono">Entity</span></div>' +
      '<div class="ctx-leg"><span class="ctx-leg-dot bg-green"></span><span class="text-9px text-muted-foreground font-mono">Platform</span></div>' +
      '<div class="ctx-leg"><span class="ctx-leg-dot bg-red"></span><span class="text-9px text-muted-foreground font-mono">Breach</span></div>' +
      "</div></div></div></div>"
    );
  }

  window.KryxPreview = {
    escapeHtml: escapeHtml,
    buildContextualHTML: buildContextualHTML,
  };
})();
