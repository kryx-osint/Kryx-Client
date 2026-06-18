(function () {
  "use strict";
  var INTEL_SCANNED_TOTAL = 169;
  var FIELD_LABELS = {
    firstname: "First Name",
    lastname: "Last Name",
    mobileno: "Mobile Number",
    plateno: "Plate Number",
    passportno: "Passport Number",
    sourceurl: "Source URL",
    source_url: "Source URL",
    birthdate: "Birth Date",
    fullname: "Full Name",
    addressline: "Address",
  };

  function byId(id) {
    return document.getElementById(id);
  }

  var SELECTION_STORAGE_KEY = "kryx_intel_report_inclusions";
  var workspacePayload = null;
  var workspaceReportKey = "";
  var workspaceEntries = [];
  var workspaceProfileSource = {};
  var activeProfileKey = "";
  var intelImageViewEnabled = false;
  var intelImageProxyPrefix = "";
  var intelImageOrigin = "";

  var IMAGE_FIELD_RE =
    /(^|_)(img|image|images|photo|photos|picture|pictures|avatar|avatars|profile_pic|profile_picture|profile_image|pic|thumbnail|photo_url|image_url|img_url|picture_url|avatar_url)(_|$)/i;

  function canViewIntelImages() {
    return intelImageViewEnabled;
  }

  function isImageLikeFieldKey(key) {
    var k = String(key || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!k) return false;
    return IMAGE_FIELD_RE.test(k);
  }

  function reportStorageKey(payload) {
    var meta = (payload && payload.meta) || {};
    return String(meta.report_id || meta.created_at || "active-report");
  }

  function readSelectionStore() {
    try {
      var raw = localStorage.getItem(SELECTION_STORAGE_KEY);
      if (!raw) {
        raw = sessionStorage.getItem(SELECTION_STORAGE_KEY);
        if (raw) {
          localStorage.setItem(SELECTION_STORAGE_KEY, raw);
          sessionStorage.removeItem(SELECTION_STORAGE_KEY);
        }
      }
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function writeSelectionStore(store) {
    try {
      localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      /* ignore quota */
    }
  }

  function loadPrintInclusionsFromUrl() {
    try {
      var params = new URLSearchParams(window.location.search);
      if (params.get("intel_customized") !== "1") return null;
      var raw = params.get("intel_records");
      if (!raw) return null;
      var included = JSON.parse(raw);
      if (!included || typeof included !== "object") return null;
      return { customized: true, included: included };
    } catch (e) {
      return null;
    }
  }

  function appendPrintInclusionsToUrl(href, state) {
    try {
      var url = new URL(href, window.location.href);
      if (state.customized) {
        url.searchParams.set("intel_customized", "1");
        url.searchParams.set("intel_records", JSON.stringify(state.included));
      } else {
        url.searchParams.delete("intel_customized");
        url.searchParams.delete("intel_records");
      }
      return url.toString();
    } catch (e) {
      return href;
    }
  }

  function getSelectionState(reportKey) {
    var store = readSelectionStore();
    var entry = store[reportKey];
    if (!entry || !entry.customized) {
      return { customized: false, included: {} };
    }
    return { customized: true, included: entry.included || {} };
  }

  function setSelectionState(reportKey, state) {
    var store = readSelectionStore();
    store[reportKey] = state;
    writeSelectionStore(store);
  }

  function isRecordIncluded(recordId, state) {
    if (!state || !state.customized) return true;
    return !!state.included[recordId];
  }

  function isProfileSeparatorLabel(label) {
    return /^Profile \d+:/i.test(String(label || ""));
  }

  function recordIdFor(profileKey, recordIndex) {
    return encodeURIComponent(String(profileKey)) + "::rec::" + String(recordIndex);
  }

  function listRecordIds(rows) {
    var ids = [];
    rows.forEach(function (row) {
      if (row.separator && row.recordId && ids.indexOf(row.recordId) === -1) {
        ids.push(row.recordId);
      }
    });
    return ids;
  }

  function assignRecordIds(profileKey, rows) {
    var hasRecordSeparator = rows.some(function (row) {
      return row.separator && !isProfileSeparatorLabel(row.label);
    });
    var recordIndex = 0;
    var currentRecordId = null;
    var mapped = rows.map(function (row) {
      if (row.separator) {
        if (isProfileSeparatorLabel(row.label)) {
          currentRecordId = null;
          return row;
        }
        currentRecordId = recordIdFor(profileKey, recordIndex);
        recordIndex += 1;
        return Object.assign({}, row, { recordId: currentRecordId });
      }
      if (currentRecordId) {
        return Object.assign({}, row, { recordId: currentRecordId });
      }
      if (!hasRecordSeparator) {
        return Object.assign({}, row, { recordId: recordIdFor(profileKey, 0) });
      }
      return row;
    });
    if (!hasRecordSeparator && mapped.some(function (row) { return !row.separator; })) {
      return [{ separator: true, label: "Record 1", recordId: recordIdFor(profileKey, 0) }].concat(
        mapped
      );
    }
    return mapped;
  }

  var CDR_CONSO_KEY = "cdrconso";
  var CDR_PHONE_FIELD_SETS = [
    ["PhoneID_1", "phoneid_1", "phone_id_1", "PhoneId_1"],
    ["PhoneID_2", "phoneid_2", "phone_id_2", "PhoneId_2"],
  ];
  var CDR_IMSI_FIELD_SETS = [
    ["IMSI_1", "imsi_1", "Imsi_1"],
    ["IMSI_2", "imsi_2", "Imsi_2"],
  ];
  var CDR_IMEI_FIELD_SETS = [
    ["IMEI_1", "imei_1", "Imei_1"],
    ["IMEI_2", "imei_2", "Imei_2"],
  ];
  var CDR_LINK_MAX_PHONES = 24;
  var CDR_LINK_MAX_NODES = 80;
  var CDR_PHONE_R = 20;
  var CDR_IDENTITY_R = 10;
  var CDR_MAX_IMSI_PER_PHONE = 3;
  var CDR_MAX_IMEI_PER_PHONE = 3;
  var CDR_IMSI_OFFSET_X = 150;
  var CDR_IMEI_OFFSET_X = 150;
  var CDR_IDENTITY_ROW_GAP = 86;
  var CDR_NODE_MIN_GAP = 92;
  var CDR_GRAPH_MARGIN = 120;

  function isCdrConsoProfileKey(key) {
    var nk = normalizedKey(key);
    if (!nk) return false;
    return nk === CDR_CONSO_KEY || nk.indexOf(CDR_CONSO_KEY) >= 0;
  }

  function cdrPhoneDigits(value) {
    return String(value == null ? "" : value).replace(/\D/g, "");
  }

  function cdrPhoneMatchesQuery(phone, query) {
    var p = cdrPhoneDigits(phone);
    var q = cdrPhoneDigits(query);
    if (!p || !q) return false;
    if (p === q) return true;
    if (p.length >= q.length && p.slice(-q.length) === q) return true;
    if (q.length >= p.length && q.slice(-p.length) === p) return true;
    return false;
  }

  function cdrFieldValue(obj, names) {
    if (!isObject(obj)) return "";
    var i;
    for (i = 0; i < names.length; i += 1) {
      if (obj[names[i]] != null && String(obj[names[i]]).trim()) {
        return String(obj[names[i]]).trim();
      }
    }
    var lower = {};
    Object.keys(obj).forEach(function (k) {
      lower[k.toLowerCase()] = obj[k];
    });
    for (i = 0; i < names.length; i += 1) {
      var hit = lower[names[i].toLowerCase()];
      if (hit != null && String(hit).trim()) return String(hit).trim();
    }
    return "";
  }

  function normalizeCdrPhoneId(value) {
    return String(value == null ? "" : value).trim();
  }

  function cdrIsEmptyIdentity(value) {
    var s = String(value == null ? "" : value).trim();
    if (!s) return true;
    var low = s.toLowerCase();
    return low === "\\n" || low === "n" || low === "null" || low === "none" || low === "-";
  }

  function cdrNodeId(type, value) {
    return type + ":" + String(value || "").trim();
  }

  function cdrSatelliteNodeId(type, phone, identity) {
    return cdrNodeId(type, String(phone || "").trim() + "|" + String(identity || "").trim());
  }

  function cdrParseNodeId(id) {
    var raw = String(id || "");
    var idx = raw.indexOf(":");
    if (idx < 0) return { type: "phone", value: raw };
    return { type: raw.slice(0, idx), value: raw.slice(idx + 1) };
  }

  function cdrIdentityValueFromNodeId(id) {
    var parsed = cdrParseNodeId(id);
    if (parsed.type !== "imsi" && parsed.type !== "imei") return parsed.value;
    var pipe = parsed.value.indexOf("|");
    return pipe >= 0 ? parsed.value.slice(pipe + 1) : parsed.value;
  }

  function unwrapProfileDetailValue(value) {
    if (isObject(value) && isObject(value.data) && Object.keys(value.data).length) {
      return value.data;
    }
    return value;
  }

  function resolveCdrConsoPayload(key, value) {
    var detailValue = unwrapProfileDetailValue(value);
    if (isCdrConsoProfileKey(key)) {
      if (Array.isArray(detailValue) && detailValue.length) return detailValue;
      if (isObject(detailValue)) {
        var childKeys = Object.keys(detailValue);
        var ci;
        for (ci = 0; ci < childKeys.length; ci += 1) {
          var child = detailValue[childKeys[ci]];
          if (Array.isArray(child) && child.length) return child;
        }
      }
      if (extractCdrPhonePairs(detailValue).length) return detailValue;
      return null;
    }
    if (isObject(detailValue)) {
      if (detailValue.cdr_conso != null) return detailValue.cdr_conso;
      if (detailValue.cdr_conso_data != null) return detailValue.cdr_conso_data;
      var keys = Object.keys(detailValue);
      var i;
      for (i = 0; i < keys.length; i += 1) {
        if (isCdrConsoProfileKey(keys[i])) return detailValue[keys[i]];
      }
    }
    if (Array.isArray(detailValue) && extractCdrPhonePairs(detailValue).length) {
      return detailValue;
    }
    return null;
  }

  function profileHasCdrConso(key, value) {
    return resolveCdrConsoPayload(key, value) != null;
  }

  function extractCdrGraphData(value) {
    var pairs = [];
    var identities = {};

    function ensurePhone(phone) {
      if (!identities[phone]) identities[phone] = { imsi: {}, imei: {} };
    }

    function attachIdentity(phone, imsi, imei) {
      if (!phone) return;
      ensurePhone(phone);
      if (!cdrIsEmptyIdentity(imsi)) {
        identities[phone].imsi[imsi] = (identities[phone].imsi[imsi] || 0) + 1;
      }
      if (!cdrIsEmptyIdentity(imei)) {
        identities[phone].imei[imei] = (identities[phone].imei[imei] || 0) + 1;
      }
    }

    function ingestRow(node) {
      var p1 = cdrFieldValue(node, CDR_PHONE_FIELD_SETS[0]);
      var p2 = cdrFieldValue(node, CDR_PHONE_FIELD_SETS[1]);
      if (!p1 || !p2 || p1 === p2) return;
      pairs.push({ a: p1, b: p2 });
      attachIdentity(
        p1,
        cdrFieldValue(node, CDR_IMSI_FIELD_SETS[0]),
        cdrFieldValue(node, CDR_IMEI_FIELD_SETS[0])
      );
      attachIdentity(
        p2,
        cdrFieldValue(node, CDR_IMSI_FIELD_SETS[1]),
        cdrFieldValue(node, CDR_IMEI_FIELD_SETS[1])
      );
    }

    function walk(node) {
      if (node == null) return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!isObject(node)) return;
      var p1 = cdrFieldValue(node, CDR_PHONE_FIELD_SETS[0]);
      var p2 = cdrFieldValue(node, CDR_PHONE_FIELD_SETS[1]);
      if (p1 && p2) {
        ingestRow(node);
        return;
      }
      Object.keys(node).forEach(function (childKey) {
        walk(node[childKey]);
      });
    }

    walk(value);
    return { pairs: pairs, identities: identities };
  }

  function extractCdrPhonePairs(value) {
    return extractCdrGraphData(value).pairs;
  }

  function topCdrIdentityKeys(map, limit) {
    return Object.keys(map || {})
      .sort(function (a, b) {
        return (map[b] || 0) - (map[a] || 0);
      })
      .slice(0, limit);
  }

  function buildCdrLinkGraph(graphData, focusPhone) {
    var pairs = graphData.pairs || [];
    var identities = graphData.identities || {};
    var callWeights = {};
    var phoneDegree = {};
    var i;

    for (i = 0; i < pairs.length; i += 1) {
      var a = pairs[i].a;
      var b = pairs[i].b;
      var ek = a < b ? a + "|" + b : b + "|" + a;
      callWeights[ek] = (callWeights[ek] || 0) + 1;
      phoneDegree[a] = (phoneDegree[a] || 0) + 1;
      phoneDegree[b] = (phoneDegree[b] || 0) + 1;
    }

    var phoneIds = Object.keys(phoneDegree);
    phoneIds.sort(function (x, y) {
      return (phoneDegree[y] || 0) - (phoneDegree[x] || 0);
    });

    var focus = normalizeCdrPhoneId(focusPhone);
    var truncated = false;
    if (phoneIds.length > CDR_LINK_MAX_PHONES) {
      truncated = true;
      var keep = {};
      var focusReserved = false;
      if (focus) {
        phoneIds.forEach(function (id) {
          if (cdrPhoneMatchesQuery(id, focus)) {
            keep[id] = true;
            focusReserved = true;
          }
        });
      }
      var limit = Math.max(0, CDR_LINK_MAX_PHONES - (focusReserved ? 1 : 0));
      phoneIds.slice(0, limit).forEach(function (id) {
        keep[id] = true;
      });
      phoneIds = phoneIds.filter(function (id) {
        return keep[id];
      });
    }

    var nodes = [];
    var edges = [];
    var nodeCount = { phone: 0, imsi: 0, imei: 0 };

    phoneIds.forEach(function (phone) {
      nodes.push({
        id: cdrNodeId("phone", phone),
        type: "phone",
        label: phone,
        degree: phoneDegree[phone] || 0,
        focus: !!(focus && cdrPhoneMatchesQuery(phone, focus)),
      });
      nodeCount.phone += 1;
    });

    phoneIds.forEach(function (phone) {
      var pid = cdrNodeId("phone", phone);
      var idents = identities[phone];
      if (!idents) return;
      topCdrIdentityKeys(idents.imsi, CDR_MAX_IMSI_PER_PHONE).forEach(function (imsi) {
        var nid = cdrSatelliteNodeId("imsi", phone, imsi);
        nodes.push({
          id: nid,
          type: "imsi",
          label: imsi,
          parentPhone: pid,
          degree: 0,
          focus: false,
        });
        edges.push({ a: pid, b: nid, weight: idents.imsi[imsi] || 1, kind: "imsi" });
        nodeCount.imsi += 1;
      });
      topCdrIdentityKeys(idents.imei, CDR_MAX_IMEI_PER_PHONE).forEach(function (imei) {
        var nid = cdrSatelliteNodeId("imei", phone, imei);
        nodes.push({
          id: nid,
          type: "imei",
          label: imei,
          parentPhone: pid,
          degree: 0,
          focus: false,
        });
        edges.push({ a: pid, b: nid, weight: idents.imei[imei] || 1, kind: "imei" });
        nodeCount.imei += 1;
      });
    });

    if (nodes.length > CDR_LINK_MAX_NODES) {
      truncated = true;
      var allowed = {};
      nodes.forEach(function (node) {
        if (node.type === "phone") allowed[node.id] = true;
      });
      nodes = nodes.filter(function (node) {
        return node.type === "phone" || allowed[node.parentPhone];
      });
      var allowedIds = {};
      nodes.forEach(function (node) {
        allowedIds[node.id] = true;
      });
      edges = edges.filter(function (edge) {
        return allowedIds[edge.a] && allowedIds[edge.b];
      });
      nodeCount = { phone: 0, imsi: 0, imei: 0 };
      nodes.forEach(function (node) {
        if (node.type === "phone") nodeCount.phone += 1;
        if (node.type === "imsi") nodeCount.imsi += 1;
        if (node.type === "imei") nodeCount.imei += 1;
      });
    }

    var nodeIdSet = {};
    nodes.forEach(function (node) {
      nodeIdSet[node.id] = true;
    });

    Object.keys(callWeights).forEach(function (ek) {
      var parts = ek.split("|");
      var na = cdrNodeId("phone", parts[0]);
      var nb = cdrNodeId("phone", parts[1]);
      if (!nodeIdSet[na] || !nodeIdSet[nb]) return;
      edges.push({ a: na, b: nb, weight: callWeights[ek], kind: "call" });
    });

    return {
      nodes: nodes,
      edges: edges,
      totalPhones: Object.keys(phoneDegree).length,
      totalImsi: Object.keys(identities).reduce(function (sum, phone) {
        return sum + Object.keys((identities[phone] && identities[phone].imsi) || {}).length;
      }, 0),
      totalImei: Object.keys(identities).reduce(function (sum, phone) {
        return sum + Object.keys((identities[phone] && identities[phone].imei) || {}).length;
      }, 0),
      totalCallEdges: Object.keys(callWeights).length,
      truncated: truncated,
      recordCount: pairs.length,
      nodeCount: nodeCount,
    };
  }

  function cdrPhoneShortLabel(phone) {
    var s = String(phone || "");
    if (s.length <= 10) return s;
    return "…" + s.slice(-8);
  }

  function cdrPhoneDisplayLabel(phone) {
    return String(phone == null ? "" : phone).trim();
  }

  function cdrMaxSatellitesPerPhone(graph) {
    var counts = {};
    var max = 1;
    (graph.nodes || []).forEach(function (n) {
      if (!n.parentPhone) return;
      counts[n.parentPhone] = (counts[n.parentPhone] || 0) + 1;
      if (counts[n.parentPhone] > max) max = counts[n.parentPhone];
    });
    return max;
  }

  function cdrComputeGraphSize(graph) {
    var phones = graph.nodeCount.phone || 0;
    var perPhone = cdrMaxSatellitesPerPhone(graph);
    var width = Math.max(900, 520 + phones * 320 + CDR_IMSI_OFFSET_X + CDR_IMEI_OFFSET_X);
    var height = Math.max(520, 400 + phones * 80 + perPhone * CDR_IDENTITY_ROW_GAP);
    return {
      width: Math.min(width, 1200),
      height: Math.min(height, 900),
    };
  }

  function layoutCdrPhoneNodes(phoneNodes, width, height) {
    var total = phoneNodes.length;
    if (!total) return [];
    var cx = width / 2;
    var cy = height / 2;
    var maxR = Math.min(cx - CDR_GRAPH_MARGIN, cy - CDR_GRAPH_MARGIN);
    var focusIdx = -1;
    var i;
    for (i = 0; i < phoneNodes.length; i += 1) {
      if (phoneNodes[i].focus) {
        focusIdx = i;
        break;
      }
    }
    if (total === 2) {
      var spread = maxR * (focusIdx >= 0 ? 0.78 : 0.82);
      if (focusIdx >= 0) {
        var focusNode = phoneNodes[focusIdx];
        var other = phoneNodes[focusIdx === 0 ? 1 : 0];
        return [
          { node: focusNode, x: cx, y: cy },
          { node: other, x: cx + spread, y: cy },
        ];
      }
      return [
        { node: phoneNodes[0], x: cx - spread, y: cy },
        { node: phoneNodes[1], x: cx + spread, y: cy },
      ];
    }
    if (focusIdx >= 0) {
      var focusNode2 = phoneNodes[focusIdx];
      var others2 = phoneNodes.filter(function (_, idx) {
        return idx !== focusIdx;
      });
      var placedFocus = [{ node: focusNode2, x: cx, y: cy }];
      var ringFocus = maxR * 0.76;
      others2.forEach(function (node, idx) {
        var angle = (Math.PI * 2 * idx) / Math.max(others2.length, 1) - Math.PI / 2;
        placedFocus.push({
          node: node,
          x: cx + Math.cos(angle) * ringFocus,
          y: cy + Math.sin(angle) * ringFocus,
        });
      });
      return placedFocus;
    }
    var radius = maxR * (total <= 4 ? 0.7 : 0.82);
    return phoneNodes.map(function (node, idx) {
      var angle = (Math.PI * 2 * idx) / total - Math.PI / 2;
      return {
        node: node,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      };
    });
  }

  function layoutCdrSatellitesForPhone(center, sats) {
    var imsi = sats.filter(function (n) {
      return n.type === "imsi";
    });
    var imei = sats.filter(function (n) {
      return n.type === "imei";
    });
    var placed = [];
    imsi.forEach(function (node, idx) {
      var dy = (idx - (imsi.length - 1) / 2) * CDR_IDENTITY_ROW_GAP;
      placed.push({
        node: node,
        x: center.x - CDR_IMSI_OFFSET_X,
        y: center.y + dy,
        parentPhone: node.parentPhone,
      });
    });
    imei.forEach(function (node, idx) {
      var dy = (idx - (imei.length - 1) / 2) * CDR_IDENTITY_ROW_GAP;
      placed.push({
        node: node,
        x: center.x + CDR_IMEI_OFFSET_X,
        y: center.y + dy,
        parentPhone: node.parentPhone,
      });
    });
    return placed;
  }

  function cdrResolveOverlaps(placed) {
    var i;
    var j;
    var iter;
    var changed = true;
    for (iter = 0; iter < 16 && changed; iter += 1) {
      changed = false;
      for (i = 0; i < placed.length; i += 1) {
        for (j = i + 1; j < placed.length; j += 1) {
          var dx = placed[j].x - placed[i].x;
          var dy = placed[j].y - placed[i].y;
          var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          if (dist < CDR_NODE_MIN_GAP) {
            var push = (CDR_NODE_MIN_GAP - dist) / 2;
            var ux = dx / dist;
            var uy = dy / dist;
            placed[i].x -= ux * push;
            placed[i].y -= uy * push;
            placed[j].x += ux * push;
            placed[j].y += uy * push;
            changed = true;
          }
        }
      }
    }
    return placed;
  }

  function layoutCdrGraphNodes(nodes, width, height) {
    var phoneNodes = nodes.filter(function (n) {
      return n.type === "phone";
    });
    var satellites = nodes.filter(function (n) {
      return n.type !== "phone";
    });
    var phonePlaced = layoutCdrPhoneNodes(phoneNodes, width, height);
    var posByPhoneId = {};
    phonePlaced.forEach(function (p) {
      posByPhoneId[p.node.id] = p;
    });

    var byParent = {};
    satellites.forEach(function (node) {
      var parent = node.parentPhone;
      if (!parent) return;
      if (!byParent[parent]) byParent[parent] = [];
      byParent[parent].push(node);
    });

    var placed = phonePlaced.map(function (p) {
      return { node: p.node, x: p.x, y: p.y, parentPhone: null };
    });

    Object.keys(byParent).forEach(function (parentId) {
      var center = posByPhoneId[parentId];
      if (!center) return;
      placed = placed.concat(layoutCdrSatellitesForPhone(center, byParent[parentId]));
    });

    return cdrResolveOverlaps(placed);
  }

  function cdrNodeRadius(type) {
    return type === "phone" ? CDR_PHONE_R : CDR_IDENTITY_R;
  }

  function cdrEdgeEndpoints(x1, y1, r1, x2, y2, r2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len;
    var uy = dy / len;
    return {
      x1: x1 + ux * r1,
      y1: y1 + uy * r1,
      x2: x2 - ux * r2,
      y2: y2 - uy * r2,
    };
  }

  function cdrParseTranslate(transform) {
    var tr = String(transform || "");
    var m = tr.match(/translate\(\s*([-\d.]+)\s*[, ]\s*([-\d.]+)\s*\)/);
    if (!m) return { x: 0, y: 0 };
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  }

  function cdrSvgNodeLabel(text, kind) {
    var label = escapeHtml(String(text || "").trim());
    var y = kind === "phone" ? 44 : 32;
    var maxW = kind === "phone" ? 168 : 156;
    var w = Math.min(maxW, Math.max(56, label.length * 5.4));
    return (
      '<rect class="cdr-link-svg-label-bg cdr-link-svg-label-bg--' +
      kind +
      '" x="' +
      (-w / 2).toFixed(1) +
      '" y="' +
      (y - 11).toFixed(1) +
      '" width="' +
      w.toFixed(1) +
      '" height="15" rx="4"/>' +
      '<text class="cdr-link-svg-label cdr-link-svg-label--' +
      kind +
      '" x="0" y="' +
      y +
      '" text-anchor="middle">' +
      label +
      "</text>"
    );
  }

  function cdrCallEdgeStrength(weight, maxWeight) {
    var t = weight / Math.max(maxWeight, 1);
    if (t >= 0.66) return "high";
    if (t >= 0.33) return "mid";
    return "low";
  }

  function cdrNodeEdgeType(nodeId) {
    if (nodeId.indexOf("imsi:") === 0) return "imsi";
    if (nodeId.indexOf("imei:") === 0) return "imei";
    return "phone";
  }

  function renderCdrNodeSvgGroup(p) {
    var node = p.node;
    var focus = node.focus ? " cdr-link-svg-node--focus" : "";
    var type = node.type || "phone";
    var label = node.label || cdrIdentityValueFromNodeId(node.id) || cdrParseNodeId(node.id).value;
    var hitR = type === "phone" ? CDR_PHONE_R + 12 : CDR_IDENTITY_R + 14;
    var orbR = type === "phone" ? CDR_PHONE_R : CDR_IDENTITY_R;
    var titleText = label;
    var transform =
      'transform="translate(' + p.x.toFixed(2) + "," + p.y.toFixed(2) + ')"';

    if (type === "phone") {
      titleText = label + " · " + node.degree + " call link" + (node.degree === 1 ? "" : "s");
      return (
        '<g class="cdr-link-svg-node cdr-link-svg-node--phone' +
        focus +
        '" data-node-id="' +
        escapeHtml(node.id) +
        '" ' +
        transform +
        ' tabindex="0" role="button" aria-label="Phone ' +
        escapeHtml(label) +
        '">' +
        '<title>' +
        escapeHtml(titleText) +
        "</title>" +
        '<circle class="cdr-link-svg-hit" r="' +
        hitR +
        '" cx="0" cy="0"/>' +
        '<circle class="cdr-link-svg-orb cdr-link-svg-orb--phone" r="' +
        orbR +
        '" cx="0" cy="0"/>' +
        '<g class="cdr-link-svg-icon" transform="translate(-8,-8)" aria-hidden="true">' +
        '<rect x="4" y="1" width="8" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.25"/>' +
        '<path d="M6 12.5h4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>' +
        '<circle cx="8" cy="9" r="0.8" fill="currentColor"/>' +
        "</g>" +
        cdrSvgNodeLabel(cdrPhoneDisplayLabel(label), "phone") +
        "</g>"
      );
    }

    if (type === "imsi") {
      return (
        '<g class="cdr-link-svg-node cdr-link-svg-node--imsi" data-node-id="' +
        escapeHtml(node.id) +
        '" ' +
        transform +
        ' tabindex="0" role="button" aria-label="IMSI ' +
        escapeHtml(label) +
        '">' +
        '<title>IMSI · ' +
        escapeHtml(label) +
        "</title>" +
        '<circle class="cdr-link-svg-hit" r="' +
        hitR +
        '" cx="0" cy="0"/>' +
        '<circle class="cdr-link-svg-orb cdr-link-svg-orb--imsi" r="' +
        orbR +
        '" cx="0" cy="0"/>' +
        '<text class="cdr-link-svg-badge" y="3.5" text-anchor="middle">IMSI</text>' +
        cdrSvgNodeLabel(label, "imsi") +
        "</g>"
      );
    }

    return (
      '<g class="cdr-link-svg-node cdr-link-svg-node--imei" data-node-id="' +
      escapeHtml(node.id) +
      '" ' +
      transform +
      ' tabindex="0" role="button" aria-label="IMEI ' +
      escapeHtml(label) +
      '">' +
      '<title>IMEI · ' +
      escapeHtml(label) +
      "</title>" +
      '<circle class="cdr-link-svg-hit" r="' +
      hitR +
      '" cx="0" cy="0"/>' +
      '<circle class="cdr-link-svg-orb cdr-link-svg-orb--imei" r="' +
      orbR +
      '" cx="0" cy="0"/>' +
      '<text class="cdr-link-svg-badge" y="3.5" text-anchor="middle">IMEI</text>' +
      cdrSvgNodeLabel(label, "imei") +
      "</g>"
    );
  }

  function cdrClientToSvg(svg, clientX, clientY) {
    var pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    var matrix = svg.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    var local = pt.matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  }

  function cdrFindNodeGroup(svg, nodeId) {
    var groups = svg.querySelectorAll(".cdr-link-svg-node[data-node-id]");
    var i;
    for (i = 0; i < groups.length; i += 1) {
      if (groups[i].getAttribute("data-node-id") === nodeId) return groups[i];
    }
    return null;
  }

  function cdrGetNodeCenter(svg, nodeId) {
    var group = cdrFindNodeGroup(svg, nodeId);
    if (!group) return null;
    return cdrParseTranslate(group.getAttribute("transform"));
  }

  function cdrUpdateNodeEdges(svg, nodeId, x, y) {
    svg.querySelectorAll(".cdr-link-svg-edge").forEach(function (line) {
      var fromId = line.getAttribute("data-from") || "";
      var toId = line.getAttribute("data-to") || "";
      if (fromId !== nodeId && toId !== nodeId) return;
      var fromCenter =
        fromId === nodeId ? { x: x, y: y } : cdrGetNodeCenter(svg, fromId);
      var toCenter = toId === nodeId ? { x: x, y: y } : cdrGetNodeCenter(svg, toId);
      if (!fromCenter || !toCenter) return;
      var r1 = cdrNodeRadius(cdrNodeEdgeType(fromId));
      var r2 = cdrNodeRadius(cdrNodeEdgeType(toId));
      var pts = cdrEdgeEndpoints(
        fromCenter.x,
        fromCenter.y,
        r1,
        toCenter.x,
        toCenter.y,
        r2
      );
      line.setAttribute("x1", pts.x1.toFixed(2));
      line.setAttribute("y1", pts.y1.toFixed(2));
      line.setAttribute("x2", pts.x2.toFixed(2));
      line.setAttribute("y2", pts.y2.toFixed(2));
    });
  }

  function bindCdrGraphInteraction(root) {
    if (!root) return;
    var stage = root.classList && root.classList.contains("cdr-link-graph-stage")
      ? root
      : root.querySelector(".cdr-link-graph-stage");
    if (!stage || stage.dataset.cdrBound === "1") return;
    var svg = stage.querySelector(".cdr-link-graph-svg");
    if (!svg) return;
    stage.dataset.cdrBound = "1";

    var drag = null;

    function nodeGroupFromTarget(target) {
      if (!target || !target.closest) return null;
      return target.closest(".cdr-link-svg-node[data-node-id]");
    }

    function endDrag(event) {
      if (!drag) return;
      drag.group.classList.remove("is-dragging");
      if (drag.group.releasePointerCapture && event && event.pointerId != null) {
        try {
          drag.group.releasePointerCapture(event.pointerId);
        } catch (e) {
          /* ignore */
        }
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      drag = null;
    }

    function onPointerMove(event) {
      if (!drag) return;
      event.preventDefault();
      var pt = cdrClientToSvg(svg, event.clientX, event.clientY);
      var x = pt.x - drag.offsetX;
      var y = pt.y - drag.offsetY;
      drag.group.setAttribute("transform", "translate(" + x.toFixed(2) + "," + y.toFixed(2) + ")");
      cdrUpdateNodeEdges(svg, drag.nodeId, x, y);
    }

    function onPointerDown(event) {
      var group = nodeGroupFromTarget(event.target);
      if (!group) return;
      event.preventDefault();
      var nodeId = group.getAttribute("data-node-id") || "";
      var pt = cdrClientToSvg(svg, event.clientX, event.clientY);
      var tr = cdrParseTranslate(group.getAttribute("transform"));
      drag = {
        group: group,
        nodeId: nodeId,
        offsetX: pt.x - tr.x,
        offsetY: pt.y - tr.y,
      };
      var nodesLayer = svg.querySelector(".cdr-link-svg-nodes");
      if (nodesLayer) nodesLayer.appendChild(group);
      group.classList.add("is-dragging");
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endDrag);
      window.addEventListener("pointercancel", endDrag);
      if (group.setPointerCapture && event.pointerId != null) {
        try {
          group.setPointerCapture(event.pointerId);
        } catch (e) {
          /* ignore */
        }
      }
    }

    svg.addEventListener("pointerdown", onPointerDown);
  }

  function renderCdrLinkAnalysisHtml(graph, queryValue) {
    if (!graph.nodes.length) {
      return (
        '<div class="cdr-link-analysis">' +
        '<p class="cdr-link-empty">No PhoneID_1 / PhoneID_2 links found in this Record consolidated result.</p>' +
        "</div>"
      );
    }

    var size = cdrComputeGraphSize(graph);
    var width = size.width;
    var height = size.height;
    var placed = layoutCdrGraphNodes(graph.nodes, width, height);
    var posById = {};
    placed.forEach(function (p) {
      posById[p.node.id] = p;
    });

    var maxCallWeight = 1;
    graph.edges.forEach(function (edge) {
      if (edge.kind === "call" && edge.weight > maxCallWeight) maxCallWeight = edge.weight;
    });

    function edgeLine(edge) {
      var pa = posById[edge.a];
      var pb = posById[edge.b];
      if (!pa || !pb) return "";
      var kind = edge.kind || "call";
      var r1 = cdrNodeRadius(pa.node.type);
      var r2 = cdrNodeRadius(pb.node.type);
      var pts = cdrEdgeEndpoints(pa.x, pa.y, r1, pb.x, pb.y, r2);
      if (kind === "call") {
        var strength = cdrCallEdgeStrength(edge.weight, maxCallWeight);
        return (
          '<line class="cdr-link-svg-edge cdr-link-svg-edge--call cdr-link-svg-edge--' +
          strength +
          '" data-from="' +
          escapeHtml(edge.a) +
          '" data-to="' +
          escapeHtml(edge.b) +
          '" data-from-r="' +
          r1 +
          '" data-to-r="' +
          r2 +
          '" x1="' +
          pts.x1.toFixed(2) +
          '" y1="' +
          pts.y1.toFixed(2) +
          '" x2="' +
          pts.x2.toFixed(2) +
          '" y2="' +
          pts.y2.toFixed(2) +
          '"/>'
        );
      }
      return (
        '<line class="cdr-link-svg-edge cdr-link-svg-edge--' +
        kind +
        '" data-from="' +
        escapeHtml(edge.a) +
        '" data-to="' +
        escapeHtml(edge.b) +
        '" data-from-r="' +
        r1 +
        '" data-to-r="' +
        r2 +
        '" x1="' +
        pts.x1.toFixed(2) +
        '" y1="' +
        pts.y1.toFixed(2) +
        '" x2="' +
        pts.x2.toFixed(2) +
        '" y2="' +
        pts.y2.toFixed(2) +
        '"/>'
      );
    }

    var callLines = graph.edges
      .filter(function (e) {
        return e.kind === "call";
      })
      .map(edgeLine)
      .join("");
    var identityLines = graph.edges
      .filter(function (e) {
        return e.kind !== "call";
      })
      .map(edgeLine)
      .join("");

    var nodeSvg = placed.map(renderCdrNodeSvgGroup).join("");

    var graphSvg =
      '<svg class="cdr-link-graph-svg" viewBox="0 0 ' +
      width +
      " " +
      height +
      '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Record phone link graph">' +
      '<g class="cdr-link-svg-edges cdr-link-svg-edges--call">' +
      callLines +
      "</g>" +
      '<g class="cdr-link-svg-edges cdr-link-svg-edges--identity">' +
      identityLines +
      "</g>" +
      '<g class="cdr-link-svg-nodes">' +
      nodeSvg +
      "</g>" +
      "</svg>";

    var topLinks = graph.edges
      .filter(function (edge) {
        return edge.kind === "call";
      })
      .slice()
      .sort(function (a, b) {
        return b.weight - a.weight;
      })
      .slice(0, 12)
      .map(function (edge) {
        var pa = cdrParseNodeId(edge.a);
        var pb = cdrParseNodeId(edge.b);
        return (
          '<li><span class="cdr-link-pair">' +
          escapeHtml(cdrPhoneDisplayLabel(pa.value)) +
          " ↔ " +
          escapeHtml(cdrPhoneDisplayLabel(pb.value)) +
          '</span><span class="cdr-link-weight">' +
          edge.weight +
          " record" +
          (edge.weight === 1 ? "" : "s") +
          "</span></li>"
        );
      })
      .join("");

    var truncNote = graph.truncated
      ? '<p class="cdr-link-truncated">Showing top ' +
        graph.nodeCount.phone +
        " of " +
        graph.totalPhones +
        " phone numbers (with linked IMSI/IMEI where space allows).</p>"
      : "";

    return (
      '<div class="cdr-link-analysis">' +
      '<div class="cdr-link-head">' +
      '<span class="cdr-link-eyebrow">Record link analysis</span>' +
      '<p class="cdr-link-desc">Solid lines = calls between phones. Dashed violet = that phone’s <strong>IMSI</strong>; dashed gold = that phone’s <strong>IMEI</strong> (same Record rows).</p>' +
      "</div>" +
      '<div class="cdr-link-stats">' +
      '<div class="cdr-link-stat"><span class="cdr-link-stat-val">' +
      graph.nodeCount.phone +
      '</span><span class="cdr-link-stat-lbl">Phones shown</span></div>' +
      '<div class="cdr-link-stat"><span class="cdr-link-stat-val">' +
      graph.nodeCount.imsi +
      '</span><span class="cdr-link-stat-lbl">IMSI nodes</span></div>' +
      '<div class="cdr-link-stat"><span class="cdr-link-stat-val">' +
      graph.nodeCount.imei +
      '</span><span class="cdr-link-stat-lbl">IMEI nodes</span></div>' +
      '<div class="cdr-link-stat"><span class="cdr-link-stat-val">' +
      graph.recordCount +
      '</span><span class="cdr-link-stat-lbl">Record rows</span></div>' +
      "</div>" +
      truncNote +
      '<div class="cdr-link-graph-panel">' +
      (document.body.classList.contains("page-intelligence-print")
        ? ""
        : '<p class="cdr-link-drag-hint">Drag any node to rearrange. IMSI left, IMEI right of each phone.</p>') +
      '<div class="cdr-link-graph-stage">' +
      graphSvg +
      "</div>" +
      '<div class="cdr-link-legend">' +
      '<span class="cdr-link-legend-item"><span class="cdr-link-legend-dot cdr-link-legend-dot--call"></span>Call link</span>' +
      '<span class="cdr-link-legend-item"><span class="cdr-link-legend-dot cdr-link-legend-dot--imsi"></span>IMSI (left)</span>' +
      '<span class="cdr-link-legend-item"><span class="cdr-link-legend-dot cdr-link-legend-dot--imei"></span>IMEI (right)</span>' +
      '<span class="cdr-link-legend-item"><span class="cdr-link-legend-dot cdr-link-legend-dot--focus"></span>Query number</span>' +
      "</div>" +
      "</div>" +
      (topLinks
        ? '<div class="cdr-link-top">' +
          '<p class="cdr-link-top-title">Strongest links</p>' +
          '<ul class="cdr-link-top-list">' +
          topLinks +
          "</ul></div>"
        : "") +
      "</div>"
    );
  }

  function collectAllRows(entries, profileSource) {
    var collected = [];
    entries.forEach(function (entry, idx) {
      var key = entry.id;
      collected.push({
        separator: true,
        label: "Profile " + (idx + 1) + ": " + (entry.crawlLabel || entry.label),
      });
      var value = profileSource[key];
      if (profileHasCdrConso(key, value)) {
        var cdrPayload = resolveCdrConsoPayload(key, value);
        var graph = buildCdrLinkGraph(
          extractCdrGraphData(cdrPayload),
          (workspacePayload && workspacePayload.query && workspacePayload.query.value) || ""
        );
        collected.push({
          key: "cdr_link_analysis",
          value:
            graph.nodeCount.phone +
            " phones, " +
            graph.nodeCount.imsi +
            " IMSI, " +
            graph.nodeCount.imei +
            " IMEI (" +
            graph.recordCount +
            " Record rows) — see Record link analysis below",
          recordId: recordIdFor(key, 0),
        });
        return;
      }
      var detailValue = unwrapProfileDetailValue(value);
      collected = collected.concat(assignRecordIds(key, normalizeRows(detailValue)));
    });
    if (!collected.length) {
      collected.push({ key: "info", value: "No records returned.", recordId: recordIdFor("_", 0) });
    }
    return collected;
  }

  function pruneSeparators(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (!row.separator) {
        out.push(row);
        continue;
      }
      var hasData = false;
      for (var j = i + 1; j < rows.length; j += 1) {
        if (rows[j].separator) break;
        hasData = true;
        break;
      }
      if (hasData) out.push(row);
    }
    return out;
  }

  function filterRowsForReport(rows, state) {
    if (!state.customized) return rows;
    var filtered = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (row.separator) {
        if (row.recordId) {
          if (isRecordIncluded(row.recordId, state)) filtered.push(row);
        } else {
          filtered.push(row);
        }
        continue;
      }
      if (row.recordId) {
        if (isRecordIncluded(row.recordId, state)) filtered.push(row);
      } else {
        filtered.push(row);
      }
    }
    return pruneSeparators(filtered);
  }

  function countIncludedRecords(rows, state) {
    var recordIds = listRecordIds(rows);
    var total = recordIds.length;
    var included = recordIds.filter(function (id) {
      return isRecordIncluded(id, state);
    }).length;
    return { included: included, total: total };
  }

  function countProfilesWithSelection(entries, profileSource, state) {
    var count = 0;
    entries.forEach(function (entry) {
      var key = entry.id;
      var value = profileSource[key];
      var detailValue = value;
      if (isObject(value) && isObject(value.data) && Object.keys(value.data).length) {
        detailValue = value.data;
      }
      var recordIds = listRecordIds(assignRecordIds(key, normalizeRows(detailValue)));
      if (!recordIds.length) return;
      if (!state.customized) {
        count += 1;
        return;
      }
      if (recordIds.some(function (id) {
        return isRecordIncluded(id, state);
      })) {
        count += 1;
      }
    });
    return count;
  }

  function updateReportSelectionStats(entries, profileSource, state) {
    var allRows = collectAllRows(entries, profileSource);
    var recordCounts = countIncludedRecords(allRows, state);
    var hitsValue = state.customized ? recordCounts.included : recordCounts.total;
    var profilesValue = countProfilesWithSelection(entries, profileSource, state);
    var hitsLabel = state.customized ? "Hits Selected" : "Hits";
    var matchLabel = state.customized ? "Match Selected" : "Match";
    var profilesLabel = state.customized ? "Profiles Selected" : "Profiles";
    var headerHitsLabel = state.customized ? "HITS SELECTED" : "HITS";
    var headerMatchLabel = state.customized ? "MATCH SELECTED" : "MATCH";

    if (byId("hits-count")) byId("hits-count").textContent = String(hitsValue);
    var hitsCountLabel = byId("hits-count-label");
    if (hitsCountLabel) hitsCountLabel.textContent = headerHitsLabel;
    if (byId("miss-count")) byId("miss-count").textContent = String(hitsValue);
    var missCountLabel = byId("miss-count-label");
    if (missCountLabel) missCountLabel.textContent = headerMatchLabel;

    var statHitsLabel = byId("stat-grid-hits-label");
    if (statHitsLabel) statHitsLabel.textContent = hitsLabel;
    if (byId("stat-grid-hits")) byId("stat-grid-hits").textContent = String(hitsValue);

    var statMatchLabel = byId("stat-grid-miss-label");
    if (statMatchLabel) statMatchLabel.textContent = matchLabel;
    if (byId("stat-grid-miss")) byId("stat-grid-miss").textContent = String(hitsValue);

    var platformsLabel = byId("stat-platforms-label");
    if (platformsLabel) platformsLabel.textContent = profilesLabel;
    if (byId("stat-platforms")) byId("stat-platforms").textContent = String(profilesValue);

    if (byId("discovered-count")) byId("discovered-count").textContent = String(hitsValue);
  }

  function updateSelectionUi(rows, state) {
    var bar = byId("intel-report-selection-bar");
    if (bar) bar.hidden = false;
    var counts = countIncludedRecords(rows, state);
    var countEl = byId("intel-selection-count");
    if (countEl) {
      countEl.textContent =
        counts.included + " of " + counts.total + " records selected for print";
    }
    updateReportSelectionStats(workspaceEntries, workspaceProfileSource, state);
  }

  function syncRecordExcludedUi(recordId, checked) {
    var sep = document.querySelector(
      '.intel-row-separator[data-intel-record-id="' + recordId + '"]'
    );
    if (sep) sep.classList.toggle("intel-row-separator--excluded", !checked);
    document
      .querySelectorAll('.intel-row[data-intel-record-id="' + recordId + '"]')
      .forEach(function (rowEl) {
        rowEl.classList.toggle("intel-record-field--excluded", !checked);
      });
  }

  function persistRecordCheckboxChange(recordId, checked) {
    var state = getSelectionState(workspaceReportKey);
    var allRows = collectAllRows(workspaceEntries, workspaceProfileSource);
    if (!state.customized) {
      state = { customized: true, included: {} };
      listRecordIds(allRows).forEach(function (id) {
        state.included[id] = true;
      });
    }
    if (checked) {
      state.included[recordId] = true;
    } else {
      delete state.included[recordId];
    }
    setSelectionState(workspaceReportKey, state);
    updateSelectionUi(allRows, state);
    syncRecordExcludedUi(recordId, checked);
  }

  function setProfileCheckboxes(checked) {
    var rowsWrap = byId("intel-rows");
    if (!rowsWrap) return;
    var state = getSelectionState(workspaceReportKey);
    var allRows = collectAllRows(workspaceEntries, workspaceProfileSource);
    if (!state.customized) {
      state = { customized: true, included: {} };
      listRecordIds(allRows).forEach(function (id) {
        state.included[id] = true;
      });
    }
    rowsWrap.querySelectorAll(".intel-record-include").forEach(function (input) {
      var recordId = input.getAttribute("data-intel-record-id");
      if (!recordId) return;
      input.checked = checked;
      if (checked) state.included[recordId] = true;
      else delete state.included[recordId];
      syncRecordExcludedUi(recordId, checked);
    });
    setSelectionState(workspaceReportKey, state);
    updateSelectionUi(allRows, state);
  }

  function setReportCheckboxes(checked) {
    var allRows = collectAllRows(workspaceEntries, workspaceProfileSource);
    if (!checked) {
      setSelectionState(workspaceReportKey, { customized: true, included: {} });
    } else {
      setSelectionState(workspaceReportKey, { customized: false, included: {} });
    }
    var state = getSelectionState(workspaceReportKey);
    updateSelectionUi(allRows, state);
    if (activeProfileKey) {
      var value = workspaceProfileSource[activeProfileKey];
      var detailValue = value;
      if (isObject(value) && isObject(value.data) && Object.keys(value.data).length) {
        detailValue = value.data;
      }
      var entry = workspaceEntries.find(function (e) {
        return e.id === activeProfileKey;
      });
      renderDetail(
        activeProfileKey,
        value,
        (workspacePayload && workspacePayload.query && workspacePayload.query.value) || "-",
        entry ? entry.crawlLabel : null
      );
    }
  }

  function bindSelectionControls() {
    var rowsWrap = byId("intel-rows");
    if (!rowsWrap || rowsWrap.dataset.selectionBound === "1") return;
    rowsWrap.dataset.selectionBound = "1";
    rowsWrap.addEventListener("change", function (event) {
      var input = event.target;
      if (!input || !input.classList || !input.classList.contains("intel-record-include")) return;
      persistRecordCheckboxChange(input.getAttribute("data-intel-record-id") || "", !!input.checked);
    });
    var allProfile = byId("intel-select-all-profile");
    var noneProfile = byId("intel-select-none-profile");
    var allReport = byId("intel-select-all-report");
    if (allProfile) allProfile.addEventListener("click", function () { setProfileCheckboxes(true); });
    if (noneProfile) noneProfile.addEventListener("click", function () { setProfileCheckboxes(false); });
    if (allReport) allReport.addEventListener("click", function () { setReportCheckboxes(true); });
    var printBtn = byId("workspace-intel-print-btn");
    if (printBtn) {
      if (!printBtn.dataset.printHref) {
        printBtn.dataset.printHref = printBtn.getAttribute("href") || "";
      }
      printBtn.addEventListener("click", function (event) {
        var state = getSelectionState(workspaceReportKey);
        var counts = countIncludedRecords(
          collectAllRows(workspaceEntries, workspaceProfileSource),
          state
        );
        if (state.customized && counts.included === 0) {
          event.preventDefault();
          window.alert("Select at least one record to include in the printed report.");
          return;
        }
        printBtn.setAttribute(
          "href",
          appendPrintInclusionsToUrl(printBtn.dataset.printHref, state)
        );
      });
    }
  }

  function renderSeparatorHtml(row, printMode, selectionState) {
    var body =
      '<span class="intel-row-separator-line" aria-hidden="true"></span>' +
      '<span class="intel-row-separator-label">' +
      escapeHtml(row.label) +
      "</span>" +
      '<span class="intel-row-separator-line" aria-hidden="true"></span>';
    if (!printMode && row.recordId) {
      var checked = isRecordIncluded(row.recordId, selectionState);
      return (
        '<div class="intel-row-separator intel-row-separator--selectable' +
        (checked ? "" : " intel-row-separator--excluded") +
        '" data-intel-record-id="' +
        escapeHtml(row.recordId) +
        '">' +
        '<label class="intel-record-check">' +
        '<input type="checkbox" class="intel-record-include" data-intel-record-id="' +
        escapeHtml(row.recordId) +
        '" ' +
        (checked ? "checked" : "") +
        ' aria-label="Include ' +
        escapeHtml(row.label) +
        ' in printed report" />' +
        "</label>" +
        '<div class="intel-row-separator-body">' +
        body +
        "</div>" +
        "</div>"
      );
    }
    return '<div class="intel-row-separator">' + body + "</div>";
  }

  function isUrlValue(value) {
    var v = String(value || "").trim();
    return /^https?:\/\//i.test(v) || /^mailto:/i.test(v);
  }

  function rawImageUrlFromRow(row) {
    if (!row || row.separator) return "";
    var value = String(row.value || "").trim();
    if (!value || value.indexOf("[Image hidden") === 0) return "";
    if (isImageLikeFieldKey(row.key) && valueLooksLikeImagePath(value)) {
      return resolveIntelImageUrl(value);
    }
    if (valueLooksLikeImagePath(value)) {
      return resolveIntelImageUrl(value);
    }
    return "";
  }

  function renderRestrictedImageHtml() {
    return (
      '<span class="intel-field-value-text intel-field-value-text--restricted">' +
      "Photos and images from crawled records are hidden on your current plan. Upgrade or apply for Agency package to display/view images." +
      "</span>"
    );
  }

  function renderFieldValueHtml(row, printMode) {
    if (!canViewIntelImages() && rawImageUrlFromRow(row)) {
      return renderRestrictedImageHtml();
    }
    var imageUrl = getImageUrlFromRow(row);
    if (imageUrl) return renderImageValueHtml(imageUrl, printMode);
    var raw = String(row.value == null ? "" : row.value);
    if (!raw.trim()) {
      return '<span class="intel-field-value-text intel-field-value-text--empty">—</span>';
    }
    if (isUrlValue(raw)) {
      var safe = escapeHtml(raw);
      if (printMode) {
        return '<span class="intel-field-value-text intel-field-link-text">' + safe + "</span>";
      }
      return (
        '<a href="' +
        safe +
        '" class="intel-field-link" target="_blank" rel="noopener noreferrer">' +
        safe +
        "</a>"
      );
    }
    return '<span class="intel-field-value-text">' + escapeHtml(raw) + "</span>";
  }

  function renderDataRowHtml(row, printMode, selectionState) {
    var valueHtml = renderFieldValueHtml(row, printMode);
    var recordAttr = row.recordId
      ? ' data-intel-record-id="' + escapeHtml(row.recordId) + '"'
      : "";
    var excluded = !printMode && row.recordId && !isRecordIncluded(row.recordId, selectionState);
    return (
      '<div class="intel-row intel-field' +
      (excluded ? " intel-record-field--excluded" : "") +
      '"' +
      recordAttr +
      ">" +
      '<div class="intel-field-label">' +
      escapeHtml(fieldLabel(row.key)) +
      "</div>" +
      '<div class="intel-field-value">' +
      valueHtml +
      "</div>" +
      "</div>"
    );
  }

  function renderRowsHtml(rows, printMode, selectionState) {
    var html = [];
    var i = 0;
    while (i < rows.length) {
      var row = rows[i];
      if (row.separator && row.recordId && !isProfileSeparatorLabel(row.label)) {
        html.push('<div class="intel-record-group">');
        html.push(renderSeparatorHtml(row, printMode, selectionState));
        i += 1;
        while (i < rows.length && !rows[i].separator) {
          html.push(renderDataRowHtml(rows[i], printMode, selectionState));
          i += 1;
        }
        html.push("</div>");
        continue;
      }
      if (row.separator) {
        html.push(
          '<div class="intel-profile-separator">' +
            renderSeparatorHtml(row, printMode, selectionState) +
            "</div>"
        );
      } else {
        html.push(renderDataRowHtml(row, printMode, selectionState));
      }
      i += 1;
    }
    return html.join("");
  }

  var DEFAULT_BLANK_IMAGE =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="#111827"/><rect x="20" y="20" width="120" height="120" rx="10" fill="#1f2937" stroke="#374151"/><path d="M44 102l22-24 16 16 14-14 20 22H44z" fill="#4b5563"/><circle cx="60" cy="56" r="8" fill="#6b7280"/></svg>'
    );

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function looksLikeImageField(key) {
    return isImageLikeFieldKey(key);
  }

  function looksLikeImageUrl(value) {
    return valueLooksLikeImagePath(value);
  }

  function valueLooksLikeImagePath(value) {
    var v = String(value || "").trim();
    if (!v || v.indexOf("[Image hidden") === 0) return false;
    if (/^data:image\//i.test(v)) return true;
    if (v.charAt(0) === "/") {
      return (
        /(\.png|\.jpe?g|\.gif|\.webp|\.bmp|\.svg)(\?.*)?$/i.test(v) ||
        /\/id-images\//i.test(v) ||
        /\/id_images\//i.test(v) ||
        /\/images?\//i.test(v)
      );
    }
    if (!/^https?:\/\//i.test(v)) return false;
    return /(\.png|\.jpe?g|\.gif|\.webp|\.bmp|\.svg)(\?.*)?$/i.test(v) || /\/image/i.test(v);
  }

  function resolveIntelImageUrl(value) {
    var v = String(value || "").trim();
    if (!v) return "";
    if (/^https?:\/\//i.test(v) || /^data:image\//i.test(v)) return v;
    if (v.charAt(0) === "/" && intelImageProxyPrefix) {
      return intelImageProxyPrefix + encodeURIComponent(v);
    }
    if (v.charAt(0) === "/" && intelImageOrigin) {
      return intelImageOrigin.replace(/\/$/, "") + v;
    }
    return v;
  }

  function getImageUrlFromRow(row) {
    if (!canViewIntelImages()) return "";
    return rawImageUrlFromRow(row);
  }

  function renderImageValueHtml(imageUrl, printMode) {
    if (!imageUrl) return "";
    var safe = escapeHtml(imageUrl);
    var fallback = escapeHtml(DEFAULT_BLANK_IMAGE);
    if (printMode) {
      return (
        '<img class="intel-image-print" src="' +
        safe +
        '" alt="Image value" loading="lazy" onerror="this.onerror=null;this.src=\'' +
        fallback +
        '\';" />'
      );
    }
    return (
      '<button type="button" class="intel-image-thumb-btn" data-intel-image-url="' +
      safe +
      '" title="Open image preview">' +
      '<img class="intel-image-thumb" src="' +
      safe +
      '" alt="Image preview thumbnail" loading="lazy" />' +
      "</button>"
    );
  }

  function ensureImageModal() {
    var existing = byId("intel-image-modal");
    if (existing) return existing;

    var modal = document.createElement("div");
    modal.id = "intel-image-modal";
    modal.className = "intel-image-modal";
    modal.hidden = true;
    modal.innerHTML =
      '<div class="intel-image-modal-backdrop" data-intel-image-close></div>' +
      '<div class="intel-image-modal-dialog" role="dialog" aria-modal="true" aria-label="Image preview">' +
      '<button type="button" class="intel-image-modal-close" data-intel-image-close aria-label="Close image preview">×</button>' +
      '<img id="intel-image-modal-img" class="intel-image-modal-img" alt="Image preview" />' +
      "</div>";
    document.body.appendChild(modal);

    modal.addEventListener("click", function (event) {
      var closeTarget = event.target && event.target.getAttribute("data-intel-image-close");
      if (closeTarget != null) {
        modal.hidden = true;
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !modal.hidden) {
        modal.hidden = true;
      }
    });

    return modal;
  }

  function openImageModal(url) {
    var modal = ensureImageModal();
    var img = byId("intel-image-modal-img");
    if (!img) return;
    img.src = url;
    modal.hidden = false;
  }

  function toTitle(value) {
    var s = String(value == null ? "" : value)
      .replace(/[_-]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .trim();
    if (!s) return "Result";
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function fieldLabel(value) {
    var raw = String(value == null ? "" : value);
    var key = raw.toLowerCase().replace(/[.\-\s]+/g, "_");
    if (FIELD_LABELS[key]) return FIELD_LABELS[key];
    return toTitle(raw);
  }

  function normalizedKey(value) {
    return String(value == null ? "" : value).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function valueFieldCount(value) {
    if (value == null) return 0;
    if (Array.isArray(value)) return value.length;
    if (typeof value === "object") return Object.keys(value).length ? 1 : 0;
    return String(value).trim() ? 1 : 0;
  }

  function flattenRows(value, prefix) {
    var out = [];
    var p = prefix || "";

    if (value == null) {
      out.push({ key: p || "value", value: "-" });
      return out;
    }

    if (Array.isArray(value)) {
      if (!value.length) {
        out.push({ key: p || "value", value: "[]" });
        return out;
      }
      value.forEach(function (item, idx) {
        var label = p ? p + " - Record " + (idx + 1) : "Record " + (idx + 1);
        out.push({ separator: true, label: label });
        if (isObject(item) || Array.isArray(item)) {
          var childRows = flattenRows(item, p);
          if (!childRows.length) {
            out.push({ key: "value", value: "-" });
          } else {
            out = out.concat(childRows);
          }
        } else {
          out.push({ key: "value", value: String(item) });
        }
      });
      return out;
    }

    if (typeof value === "object") {
      var keys = Object.keys(value);
      if (!keys.length) {
        out.push({ key: p || "value", value: "{}" });
        return out;
      }
      keys.forEach(function (k) {
        var next = p ? p + "." + k : k;
        out = out.concat(flattenRows(value[k], next));
      });
      return out;
    }

    out.push({ key: p || "value", value: String(value) });
    return out;
  }

  function normalizeRows(value) {
    return flattenRows(value, "");
  }

  function isObject(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  function isMetaKey(key) {
    var k = String(key || "").toLowerCase();
    return (
      k === "hits" ||
      k === "miss" ||
      k === "misses" ||
      k === "crawled_sites" ||
      k === "scanned" ||
      k === "total_sites" ||
      k === "status" ||
      k === "success" ||
      k === "message" ||
      k === "query" ||
      k === "meta" ||
      k === "errors"
    );
  }

  function objectFromArray(items) {
    var out = {};
    if (!Array.isArray(items)) return out;
    items.forEach(function (item, idx) {
      if (isObject(item)) {
        var key =
          item.platform ||
          item.site ||
          item.source ||
          item.name ||
          item.key ||
          "item_" + (idx + 1);
        out[String(key)] = item;
      } else {
        out["item_" + (idx + 1)] = item;
      }
    });
    return out;
  }

  function pickProfiles(result) {
    if (!isObject(result)) return {};

    var directCandidates = [
      result.profiles,
      result.results,
      result.records,
      result.matches,
      result.data,
      result.data && result.data.profiles,
      result.data && result.data.results,
      result.data && result.data.records,
      result.data && result.data.matches,
    ];

    for (var i = 0; i < directCandidates.length; i += 1) {
      var c = directCandidates[i];
      if (isObject(c) && Object.keys(c).length) return c;
      if (Array.isArray(c) && c.length) return objectFromArray(c);
    }

    var filtered = {};
    Object.keys(result).forEach(function (key) {
      if (!isMetaKey(key)) filtered[key] = result[key];
    });
    if (Object.keys(filtered).length) return filtered;

    if (isObject(result.data)) {
      var nested = {};
      Object.keys(result.data).forEach(function (key) {
        if (!isMetaKey(key)) nested[key] = result.data[key];
      });
      if (Object.keys(nested).length) return nested;
    }

    return {};
  }

  function getProfileSource(result) {
    return pickProfiles(result);
  }

  function getProfileEntries(profileSource) {
    var used = {};
    var entries = [];
    var crawlIndex = 0;
    Object.keys(profileSource).forEach(function (rawKey) {
      var nk = normalizedKey(rawKey);
      if (!nk || used[nk]) return;
      used[nk] = true;
      crawlIndex += 1;
      var profileValue = profileSource[rawKey];
      entries.push({
        id: rawKey,
        label: profileHasCdrConso(rawKey, profileValue)
          ? "Record Consolidated"
          : toTitle(rawKey),
        crawlLabel: "Web Crawled " + crawlIndex,
        value: profileValue,
      });
    });
    return entries;
  }

  function getNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      var n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function profileRecordCount(value) {
    if (value == null) return 0;
    if (Array.isArray(value)) return value.length;
    if (typeof value === "object") return Object.keys(value).length ? 1 : 0;
    return String(value).trim() ? 1 : 0;
  }

  function renderProfileList(entries, selected, onSelect) {
    var list = byId("profile-list");
    var select = byId("profile-list-select");
    if (!list && !select) return;
    if (list) list.innerHTML = "";

    if (select) {
      select.innerHTML = "";
      if (!entries.length) {
        var emptyOpt = document.createElement("option");
        emptyOpt.value = "";
        emptyOpt.textContent = "No profiles discovered";
        select.appendChild(emptyOpt);
        select.disabled = true;
      } else {
        select.disabled = false;
        entries.forEach(function (entry) {
          var opt = document.createElement("option");
          opt.value = entry.id;
          var label = entry.crawlLabel || entry.label || entry.id;
          var count = valueFieldCount(entry.value);
          opt.textContent = count ? label + " (" + count + ")" : label;
          if (entry.id === selected) opt.selected = true;
          select.appendChild(opt);
        });
        if (selected) select.value = selected;
      }
      if (select.dataset.bound !== "1") {
        select.dataset.bound = "1";
        select.addEventListener("change", function () {
          var key = select.value;
          if (key) onSelect(key);
        });
      }
    }

    if (!list) return;

    entries.forEach(function (entry) {
      var key = entry.id;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "profile-row" + (key === selected ? " profile-row--active" : "");
      btn.setAttribute("data-key", key);
      btn.innerHTML =
        '<span class="profile-avatar">' +
        escapeHtml(String(key).slice(0, 2).toUpperCase()) +
        "</span>" +
        '<span class="flex-1 min-w-0">' +
        '<span class="text-xs font-semibold block truncate">' +
        escapeHtml(entry.crawlLabel || entry.label) +
        "</span>" +
        '<span class="profile-handle text-muted-foreground">' +
        escapeHtml("(" + String(valueFieldCount(entry.value)) + ")") +
        "</span>" +
        "</span>";
      btn.addEventListener("click", function () {
        onSelect(key);
      });
      list.appendChild(btn);
    });
  }

  function renderDetail(key, value, queryValue, crawlLabel) {
    var detail = byId("profile-detail");
    var avatar = byId("detail-avatar");
    var plat = byId("detail-plat");
    var cat = byId("detail-cat");
    var name = byId("detail-name");
    var handle = byId("detail-handle");
    var badge = byId("view-profile-badge");
    var rowsWrap = byId("intel-rows");
    var fieldCount = byId("intel-field-count");
    var sourceBlock = byId("source-url-block");
    var sourceText = byId("source-url-text");

    if (!rowsWrap) return;
    if (detail) detail.classList.add("profile-detail--visible");
    if (avatar) avatar.textContent = String(key).slice(0, 2).toUpperCase();
    if (plat) {
      plat.textContent = String(crawlLabel || key).toUpperCase();
      plat.className = "profile-plat plat-neutral";
    }
    if (cat) cat.textContent = "SOURCE";
    if (name) name.textContent = crawlLabel || toTitle(key);
    if (handle) handle.textContent = queryValue || "-";
    if (badge) badge.textContent = "Record";

    var detailValue = unwrapProfileDetailValue(value);
    var cdrPayload = resolveCdrConsoPayload(key, value);

    activeProfileKey = key;
    var selectionState = getSelectionState(workspaceReportKey);
    var allRows = collectAllRows(workspaceEntries, workspaceProfileSource);
    updateSelectionUi(allRows, selectionState);

    if (cdrPayload != null) {
      if (plat) {
        plat.textContent = "RECORD";
        plat.className = "profile-plat plat-sky";
      }
      if (cat) cat.textContent = "LINK ANALYSIS";
      if (name) name.textContent = "Record consolidated";
      var graph = buildCdrLinkGraph(extractCdrGraphData(cdrPayload), queryValue || "");
      if (fieldCount) {
        fieldCount.textContent =
          graph.nodeCount.phone +
          " phones · " +
          graph.nodeCount.imsi +
          " IMSI · " +
          graph.nodeCount.imei +
          " IMEI";
      }
      rowsWrap.innerHTML = renderCdrLinkAnalysisHtml(graph, queryValue);
      bindCdrGraphInteraction(rowsWrap);
    } else {
      var rows = assignRecordIds(key, normalizeRows(detailValue));
      if (fieldCount) fieldCount.textContent = rows.length + " fields";
      rowsWrap.innerHTML = renderRowsHtml(rows, false, selectionState);
    }

    rowsWrap.querySelectorAll("[data-intel-image-url]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openImageModal(btn.getAttribute("data-intel-image-url") || "");
      });
    });

    rowsWrap.querySelectorAll(".intel-image-thumb").forEach(function (img) {
      img.addEventListener(
        "error",
        function () {
          img.src = DEFAULT_BLANK_IMAGE;
          var holder = img.closest("[data-intel-image-url]");
          if (holder) {
            holder.setAttribute("data-intel-image-url", DEFAULT_BLANK_IMAGE);
          }
        },
        { once: true }
      );
    });

    if (sourceBlock && sourceText) {
      var source = "";
      if (value && typeof value === "object") {
        source = value.sourceUrl || value.source_url || value.url || "";
      }
      if (source) {
        var safeSource = escapeHtml(source);
        if (isUrlValue(source)) {
          sourceText.innerHTML =
            '<a href="' +
            safeSource +
            '" class="intel-field-link" target="_blank" rel="noopener noreferrer">' +
            safeSource +
            "</a>";
        } else {
          sourceText.textContent = source;
        }
        sourceBlock.classList.add("source-url-block--show");
      } else {
        sourceText.textContent = "";
        sourceBlock.classList.remove("source-url-block--show");
      }
    }
  }

  function renderAllDetails(entries, profileSource, queryValue) {
    var detail = byId("profile-detail");
    var avatar = byId("detail-avatar");
    var plat = byId("detail-plat");
    var cat = byId("detail-cat");
    var name = byId("detail-name");
    var handle = byId("detail-handle");
    var badge = byId("view-profile-badge");
    var rowsWrap = byId("intel-rows");
    var fieldCount = byId("intel-field-count");
    var sourceBlock = byId("source-url-block");

    if (!rowsWrap) return;
    if (detail) detail.classList.add("profile-detail--visible");
    if (avatar) avatar.textContent = "ALL";
    if (plat) {
      plat.textContent = "ALL SOURCES";
      plat.className = "profile-plat plat-neutral";
    }
    if (cat) cat.textContent = "SUMMARY";
    if (name) name.textContent = "All discovered profiles";
    if (handle) handle.textContent = queryValue || "-";
    if (badge) badge.textContent = "Print mode";

    var collected = collectAllRows(entries, profileSource);
    var selectionState = getSelectionState(workspaceReportKey);
    collected = filterRowsForReport(collected, selectionState);

    if (fieldCount) fieldCount.textContent = String(collected.filter(function (r) { return !r.separator; }).length) + " fields";

    rowsWrap.innerHTML = renderRowsHtml(collected, true, selectionState);

    if (sourceBlock) {
      sourceBlock.classList.remove("source-url-block--show");
    }
  }

  function renderCdrRelationshipGraph(graph, queryValue) {
    var mount = byId("workspace-relationship-graph");
    if (!mount) return;
    if (!graph || !graph.nodes.length) {
      mount.innerHTML =
        '<p class="text-sm text-muted-foreground">No PhoneID links found in Record consolidated data.</p>';
      return;
    }
      mount.innerHTML =
      '<p class="text-xs text-muted-foreground mb-3">Record consolidated — phones, IMSI, and IMEI link map (' +
      graph.nodeCount.phone +
      " phones, " +
      graph.nodeCount.imsi +
      " IMSI, " +
      graph.nodeCount.imei +
      " IMEI).</p>" +
      renderCdrLinkAnalysisHtml(graph, queryValue);
    bindCdrGraphInteraction(mount);
  }

  function renderRelationshipGraph(keys, queryValue, crawlLabels) {
    var mount = byId("workspace-relationship-graph");
    if (!mount) return;
    var unique = [];
    var seen = {};
    (keys || []).forEach(function (k, idx) {
      var label = String(k || "").trim();
      var nk = normalizedKey(label);
      if (!label || !nk || seen[nk]) return;
      seen[nk] = true;
      unique.push((crawlLabels && crawlLabels[idx]) || label);
    });
    var nodes = unique.slice(0, 12);
    if (!nodes.length) {
      mount.innerHTML =
        '<p class="text-sm text-muted-foreground">No relationship nodes available from this result.</p>';
      return;
    }

    var orbit = [];
    var total = nodes.length;
    for (var i = 0; i < total; i += 1) {
      var angle = (Math.PI * 2 * i) / total - Math.PI / 2;
      var radius = 38;
      orbit.push({
        label: nodes[i],
        x: 50 + Math.cos(angle) * radius,
        y: 50 + Math.sin(angle) * radius,
      });
    }

    var lines = orbit
      .map(function (g) {
        return (
          '<line x1="50" y1="50" x2="' +
          g.x.toFixed(2) +
          '" y2="' +
          g.y.toFixed(2) +
          '" stroke="#585b70" stroke-width="0.35" opacity="0.45"/>'
        );
      })
      .join("");

    var nodeHtml = orbit
      .map(function (g) {
        return (
          '<div class="ctx-graph-node" style="left:' +
          g.x.toFixed(2) +
          "%;top:" +
          g.y.toFixed(2) +
          '%"><div class="ctx-graph-orb" style="background:#22c55e15;border-color:#22c55e50"><span style="color:#22c55e;font-size:7px;font-family:JetBrains Mono,monospace;font-weight:700">' +
          escapeHtml(g.label.slice(0, 2).toUpperCase()) +
          '</span></div><p class="ctx-graph-lbl">' +
          escapeHtml(toTitle(g.label)) +
          "</p></div>"
        );
      })
      .join("");

    mount.innerHTML =
      '<div class="ctx-graph-stage">' +
      '<svg class="ctx-graph-line-svg" viewBox="0 0 100 100" preserveAspectRatio="none">' +
      lines +
      "</svg>" +
      '<div class="ctx-graph-center">' +
      '<div class="ctx-graph-center-ring"><span style="color:var(--cyan-400);font-size:10px;font-family:JetBrains Mono,monospace;">' +
      escapeHtml((queryValue || "ID").slice(0, 2).toUpperCase()) +
      "</span></div></div>" +
      nodeHtml +
      "</div>" +
      '<div class="ctx-graph-legend">' +
      '<div class="ctx-leg"><span class="ctx-leg-dot bg-cyan"></span><span class="text-9px text-muted-foreground font-mono">Query</span></div>' +
      '<div class="ctx-leg"><span class="ctx-leg-dot bg-green"></span><span class="text-9px text-muted-foreground font-mono">JSON Key</span></div>' +
      "</div>";
  }

  function collectImagesFromProfiles(entries, profileSource) {
    if (!canViewIntelImages()) return [];
    var urls = [];
    var seen = {};
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      var value = profileSource[entry.id];
      var detailValue = value;
      if (isObject(value) && isObject(value.data) && Object.keys(value.data).length) {
        detailValue = value.data;
      }
      var rows = normalizeRows(detailValue);
      for (var j = 0; j < rows.length; j += 1) {
        var imageUrl = rawImageUrlFromRow(rows[j]);
        if (!imageUrl) continue;
        if (seen[imageUrl]) continue;
        seen[imageUrl] = true;
        urls.push(imageUrl);
      }
    }
    return urls;
  }

  function renderQueryImage(entries, profileSource) {
    var block = byId("report-query-image-block");
    var list = byId("report-query-image-list");
    if (!block || !list) return;
    var imageUrls = collectImagesFromProfiles(entries || [], profileSource || {});
    if (!imageUrls.length) {
      block.hidden = true;
      list.innerHTML = "";
      return;
    }
    block.hidden = false;
    list.innerHTML = imageUrls
      .map(function (url) {
        return (
          '<img class="report-query-image" src="' +
          escapeHtml(url) +
          '" alt="Result photo" loading="lazy" />'
        );
      })
      .join("");
    list.querySelectorAll(".report-query-image").forEach(function (img) {
      img.addEventListener(
        "error",
        function () {
          img.src = DEFAULT_BLANK_IMAGE;
        },
        { once: true }
      );
    });
  }

  function showIntelImageNotice() {
    var notice = byId("intel-image-restricted-notice");
    if (!notice) return;
    notice.hidden = canViewIntelImages();
  }

  function main() {
    var payload = window.workspaceContextPayload;
    if (!payload || typeof payload !== "object") return;
    intelImageViewEnabled = !!(
      payload.permissions && payload.permissions.intel_image_view
    );
    intelImageProxyPrefix = String(
      (payload.permissions && payload.permissions.intel_image_proxy_prefix) || ""
    );
    intelImageOrigin = String(
      (payload.permissions && payload.permissions.intel_image_origin) || ""
    );
    showIntelImageNotice();

    var query = payload.query || {};
    var result = payload.result || {};
    if (!result || typeof result !== "object") result = {};
    var profileSource = getProfileSource(result);
    var entries = getProfileEntries(profileSource);
    workspacePayload = payload;
    workspaceReportKey = reportStorageKey(payload);
    workspaceEntries = entries;
    workspaceProfileSource = profileSource;
    if (document.body.classList.contains("page-intelligence-print")) {
      var urlInclusions = loadPrintInclusionsFromUrl();
      if (urlInclusions) {
        setSelectionState(workspaceReportKey, urlInclusions);
      }
    }
    var keys = entries.map(function (entry) {
      return entry.id;
    });
    var crawlLabels = entries.map(function (entry) {
      return entry.crawlLabel || entry.label;
    });
    var cdrEntry = entries.find(function (entry) {
      return profileHasCdrConso(entry.id, profileSource[entry.id]);
    });
    if (cdrEntry) {
      renderCdrRelationshipGraph(
        buildCdrLinkGraph(
          extractCdrGraphData(resolveCdrConsoPayload(cdrEntry.id, profileSource[cdrEntry.id])),
          query.value || ""
        ),
        query.value || "-"
      );
    } else {
      renderRelationshipGraph(keys, query.value || "-", crawlLabels);
    }
    renderQueryImage(entries, profileSource);

    var queryType = byId("query-type-label");
    var queryValue = byId("query-value-label");
    if (queryType) queryType.textContent = query.type || "SEARCH";
    if (queryValue) queryValue.textContent = query.value || "-";

    var statsRow = byId("dash-stats-row");
    var splitEl = byId("dash-split");
    var splitInner = document.querySelector(".dash-split-inner");
    var intelRows = byId("intel-rows");
    var printMode = document.body.classList.contains("page-intelligence-print");
    if (statsRow) statsRow.classList.add("dash-expandable--open");
    if (splitEl) splitEl.classList.add("dash-split--open");
    if (splitEl) splitEl.classList.add("dash-split--full");
    if (printMode && splitInner) splitInner.classList.add("dash-split-inner--print-all");
    if (intelRows) intelRows.classList.add("intel-rows--full");

    var reportStatus = byId("report-status");
    if (reportStatus) {
      reportStatus.innerHTML = '<span class="text-green-400 text-xs font-mono">COMPLETE</span>';
    }

    var moduleSub = byId("module-substatus");
    var moduleStatus = byId("module-status");
    var progress = byId("progress-inner");
    if (moduleSub) moduleSub.innerHTML = '<span class="text-green-400">Complete</span>';
    if (moduleStatus) moduleStatus.textContent = "Scan complete.";
    if (progress) progress.style.width = "100%";

    var pills = byId("module-pills");
    if (pills) {
      pills.innerHTML = crawlLabels
        .map(function (label) {
          return '<span class="module-pill module-pill--hit">' + escapeHtml(label) + "</span>";
        })
        .join("");
    }

    var scannedValue = INTEL_SCANNED_TOTAL;
    var initialSelectionState = getSelectionState(workspaceReportKey);

    if (byId("scanned-count")) byId("scanned-count").textContent = String(scannedValue);
    if (byId("stat-grid-scanned")) byId("stat-grid-scanned").textContent = String(scannedValue) + "/" + INTEL_SCANNED_TOTAL;

    updateReportSelectionStats(entries, profileSource, initialSelectionState);

    var cdrEntryForSelect = entries.find(function (entry) {
      return profileHasCdrConso(entry.id, profileSource[entry.id]);
    });
    var selected = (cdrEntryForSelect && cdrEntryForSelect.id) || keys[0] || null;
    function handleSelect(next) {
      selected = next;
      renderProfileList(entries, selected, handleSelect);
      var selectedEntry = entries.find(function (entry) {
        return entry.id === selected;
      });
      renderDetail(
        selected,
        profileSource[selected],
        query.value || "-",
        selectedEntry ? selectedEntry.crawlLabel : null
      );
    }
    renderProfileList(entries, selected, handleSelect);

    if (!printMode) {
      bindSelectionControls();
    }

    if (printMode) {
      renderAllDetails(entries, profileSource, query.value || "-");
    } else if (selected) {
      var firstEntry = entries.find(function (entry) {
        return entry.id === selected;
      });
      renderDetail(
        selected,
        profileSource[selected],
        query.value || "-",
        firstEntry ? firstEntry.crawlLabel : null
      );
    } else {
      var rows = byId("intel-rows");
      if (rows) {
        rows.innerHTML = '<div class="intel-row intel-field"><div class="intel-field-label">Info</div><div class="intel-field-value"><span class="intel-field-value-text">No records returned.</span></div></div>';
      }
      if (byId("intel-field-count")) byId("intel-field-count").textContent = "0 fields";
    }
  }

  window.kryxWorkspaceRerender = main;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();

