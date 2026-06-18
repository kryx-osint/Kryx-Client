(function () {
  "use strict";

  var META_KEYS = {
    hits: true,
    miss: true,
    misses: true,
    crawled_sites: true,
    scanned: true,
    total_sites: true,
    status: true,
    success: true,
    message: true,
    query: true,
    meta: true,
    errors: true,
  };

  var MIDDLE_NAME_KEYS = [
    "middle_name",
    "middlename",
    "middleName",
    "memberInfo_middleName",
    "middle",
  ];

  var BIRTHDAY_KEYS = [
    "birth_date",
    "birthdate",
    "birthday",
    "date_of_birth",
    "dob",
    "birthDate",
    "memberInfo_birthDate",
    "memberInfo_birthdate",
  ];

  function isObject(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  function isMetaKey(key) {
    return !!META_KEYS[String(key || "").toLowerCase()];
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
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

    var i;
    for (i = 0; i < directCandidates.length; i += 1) {
      var c = directCandidates[i];
      if (isObject(c) && Object.keys(c).length) return c;
      if (Array.isArray(c) && c.length) {
        var out = {};
        c.forEach(function (item, idx) {
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

  function findProfilesLocation(result) {
    if (!isObject(result)) return { container: result, key: null, isRoot: true };

    var directKeys = ["profiles", "results", "records", "matches"];
    var i;
    for (i = 0; i < directKeys.length; i += 1) {
      var k = directKeys[i];
      if (isObject(result[k]) && Object.keys(result[k]).length) {
        return { container: result, key: k, isRoot: false };
      }
    }

    if (isObject(result.data)) {
      for (i = 0; i < directKeys.length; i += 1) {
        var dk = directKeys[i];
        if (isObject(result.data[dk]) && Object.keys(result.data[dk]).length) {
          return { container: result.data, key: dk, isRoot: false };
        }
      }
    }

    return { container: result, key: null, isRoot: true };
  }

  function replaceProfilesInResult(result, filteredProfiles) {
    var loc = findProfilesLocation(result);
    if (loc.key) {
      loc.container[loc.key] = filteredProfiles;
      return result;
    }

    Object.keys(result).forEach(function (key) {
      if (isMetaKey(key)) return;
      if (filteredProfiles[key] === undefined) delete result[key];
    });
    Object.keys(filteredProfiles).forEach(function (key) {
      result[key] = filteredProfiles[key];
    });
    return result;
  }

  function keyLooksLikeMiddleName(key) {
    return /middle/i.test(String(key || ""));
  }

  function keyLooksLikeBirthday(key) {
    return /birth|dob/i.test(String(key || ""));
  }

  function collectSearchableValues(value, out) {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach(function (item) {
        collectSearchableValues(item, out);
      });
      return;
    }
    if (isObject(value)) {
      Object.keys(value).forEach(function (key) {
        collectSearchableValues(value[key], out);
      });
      return;
    }
    out.push(String(value));
  }

  function wildcardMatch(pattern, text) {
    var trimmed = String(pattern || "").trim();
    if (!trimmed) return true;
    var parts = trimmed.toLowerCase().split("*").map(function (part) {
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    });
    var regex = new RegExp(parts.join(".*"), "i");
    return regex.test(String(text));
  }

  function getFieldValues(record, keys, keyMatcher) {
    var values = [];
    if (!isObject(record)) return values;

    keys.forEach(function (key) {
      if (record[key] != null && String(record[key]).trim() !== "") {
        values.push(String(record[key]));
      }
    });

    Object.keys(record).forEach(function (key) {
      if (keyMatcher && keyMatcher(key) && record[key] != null && String(record[key]).trim() !== "") {
        if (values.indexOf(String(record[key])) === -1) values.push(String(record[key]));
      }
    });

    return values;
  }

  function normalizeDateString(value) {
    return String(value || "").replace(/[^\d]/g, "");
  }

  function matchesMiddleName(record, filter) {
    var trimmed = String(filter || "").trim();
    if (!trimmed) return true;
    var values = getFieldValues(record, MIDDLE_NAME_KEYS, keyLooksLikeMiddleName);
    return values.some(function (value) {
      return wildcardMatch(trimmed, value);
    });
  }

  function matchesBirthday(record, filter) {
    var trimmed = String(filter || "").trim();
    if (!trimmed) return true;
    var normFilter = normalizeDateString(trimmed);
    if (!normFilter) return true;
    var values = getFieldValues(record, BIRTHDAY_KEYS, keyLooksLikeBirthday);
    return values.some(function (value) {
      var normValue = normalizeDateString(value);
      if (!normValue) return false;
      return normValue.indexOf(normFilter) !== -1 || normFilter.indexOf(normValue) !== -1;
    });
  }

  function matchesWildcard(record, filter) {
    var trimmed = String(filter || "").trim();
    if (!trimmed) return true;
    var values = [];
    collectSearchableValues(record, values);
    return values.some(function (value) {
      return wildcardMatch(trimmed, value);
    });
  }

  function recordMatchesFilters(record, filters) {
    if (!isObject(record)) return false;
    return (
      matchesMiddleName(record, filters.middleName) &&
      matchesBirthday(record, filters.birthday) &&
      matchesWildcard(record, filters.wildcard)
    );
  }

  function looksLikeRecord(value) {
    if (!isObject(value)) return false;
    var keys = Object.keys(value).map(function (k) {
      return k.toLowerCase();
    });
    return keys.some(function (k) {
      return (
        k.indexOf("first") !== -1 ||
        k.indexOf("last") !== -1 ||
        k.indexOf("name") !== -1 ||
        k.indexOf("email") !== -1 ||
        k.indexOf("phone") !== -1 ||
        k.indexOf("mobile") !== -1 ||
        k.indexOf("birth") !== -1
      );
    });
  }

  function filterProfileValue(value, filters) {
    if (value == null) return null;

    if (Array.isArray(value)) {
      var filteredArray = value.filter(function (item) {
        return recordMatchesFilters(item, filters);
      });
      return filteredArray.length ? filteredArray : null;
    }

    if (!isObject(value)) return null;

    if (isObject(value.data)) {
      var filteredData = filterProfileValue(value.data, filters);
      if (!filteredData) return null;
      var wrapped = Object.assign({}, value, { data: filteredData });
      return wrapped;
    }

    if (looksLikeRecord(value)) {
      return recordMatchesFilters(value, filters) ? value : null;
    }

    var childKeys = Object.keys(value);
    var filteredObject = {};
    var hasMatch = false;
    childKeys.forEach(function (key) {
      var child = value[key];
      if (Array.isArray(child)) {
        var filteredChild = child.filter(function (item) {
          return recordMatchesFilters(item, filters);
        });
        if (filteredChild.length) {
          filteredObject[key] = filteredChild;
          hasMatch = true;
        }
        return;
      }
      if (isObject(child)) {
        var nested = filterProfileValue(child, filters);
        if (nested) {
          filteredObject[key] = nested;
          hasMatch = true;
        }
        return;
      }
      if (matchesWildcard({ value: child }, filters)) {
        filteredObject[key] = child;
        hasMatch = true;
      }
    });

    return hasMatch ? filteredObject : null;
  }

  function countRecordsInProfileValue(value) {
    if (value == null) return 0;
    if (Array.isArray(value)) return value.length;
    if (!isObject(value)) return 0;
    if (isObject(value.data)) return countRecordsInProfileValue(value.data);
    if (looksLikeRecord(value)) return 1;

    var total = 0;
    Object.keys(value).forEach(function (key) {
      var child = value[key];
      if (Array.isArray(child)) total += child.length;
      else if (isObject(child)) total += countRecordsInProfileValue(child);
    });
    return total || 1;
  }

  function countRecordsInResult(result) {
    var source = pickProfiles(result || {});
    var total = 0;
    Object.keys(source).forEach(function (key) {
      total += countRecordsInProfileValue(source[key]);
    });
    return total;
  }

  function hasActiveFilters(filters) {
    return !!(
      String(filters.middleName || "").trim() ||
      String(filters.birthday || "").trim() ||
      String(filters.wildcard || "").trim()
    );
  }

  function readFiltersFromForm(root) {
    return {
      middleName: (root.querySelector('[data-filter="middle-name"]') || {}).value || "",
      birthday: (root.querySelector('[data-filter="birthday"]') || {}).value || "",
      wildcard: (root.querySelector('[data-filter="wildcard"]') || {}).value || "",
    };
  }

  function updateFilterStatus(root, filters) {
    var statusEl = root.querySelector("[data-filter-status]");
    if (!statusEl) return;

    var original = window.workspaceContextPayloadOriginal;
    if (!original) {
      statusEl.textContent = "";
      return;
    }

    var total = countRecordsInResult(original.result);
    if (!hasActiveFilters(filters)) {
      statusEl.textContent = total + " record" + (total === 1 ? "" : "s") + " in report";
      return;
    }

    var filteredResult = deepClone(original.result);
    var source = pickProfiles(original.result);
    var filteredProfiles = {};
    Object.keys(source).forEach(function (key) {
      var filteredValue = filterProfileValue(source[key], filters);
      if (filteredValue !== null) filteredProfiles[key] = filteredValue;
    });
    replaceProfilesInResult(filteredResult, filteredProfiles);
    var shown = countRecordsInResult(filteredResult);
    statusEl.textContent =
      "Showing " + shown + " of " + total + " record" + (total === 1 ? "" : "s");
  }

  function syncReportContextToServer(filters) {
    var payload = window.workspaceContextPayload;
    var syncUrl = window.kryxReportContextSyncUrl;
    if (!payload || !syncUrl || !payload.result) {
      return Promise.resolve(false);
    }

    return fetch(syncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": window.kryxClientCsrfToken || "",
      },
      body: JSON.stringify({
        result: payload.result,
        filters: filters || readFiltersFromForm(
          document.getElementById("client-report-filter-panel") || document.body
        ),
      }),
      credentials: "same-origin",
    })
      .then(function (response) {
        return response.json().catch(function () {
          return { ok: false };
        }).then(function (data) {
          return response.ok && data && data.ok;
        });
      })
      .catch(function () {
        return false;
      });
  }

  function applyFilters(root) {
    var original = window.workspaceContextPayloadOriginal;
    if (!original || !window.workspaceContextPayload) return;

    var filters = readFiltersFromForm(root);
    if (!hasActiveFilters(filters)) {
      window.workspaceContextPayload = deepClone(original);
    } else {
      var source = pickProfiles(original.result);
      var filteredProfiles = {};
      Object.keys(source).forEach(function (key) {
        var filteredValue = filterProfileValue(source[key], filters);
        if (filteredValue !== null) filteredProfiles[key] = filteredValue;
      });
      window.workspaceContextPayload = deepClone(original);
      window.workspaceContextPayload.result = replaceProfilesInResult(
        deepClone(original.result),
        filteredProfiles
      );
    }

    updateFilterStatus(root, filters);
    if (typeof window.kryxWorkspaceRerender === "function") {
      window.kryxWorkspaceRerender();
    }
    syncReportContextToServer(filters);
  }

  function clearFilters(root) {
    var fields = root.querySelectorAll("[data-filter]");
    fields.forEach(function (field) {
      field.value = "";
    });
    applyFilters(root);
  }

  function init() {
    var panel = document.getElementById("client-report-filter-panel");
    if (!panel || !window.workspaceContextPayload) return;

    window.workspaceContextPayloadOriginal = deepClone(window.workspaceContextPayload);

    var applyBtn = panel.querySelector("[data-filter-apply]");
    var clearBtn = panel.querySelector("[data-filter-clear]");
    var fields = panel.querySelectorAll("[data-filter]");

    if (applyBtn) {
      applyBtn.addEventListener("click", function () {
        applyFilters(panel);
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        clearFilters(panel);
      });
    }

    fields.forEach(function (field) {
      field.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          applyFilters(panel);
        }
      });
    });

    updateFilterStatus(panel, readFiltersFromForm(panel));
    hookPrintButton(panel);
  }

  function hookPrintButton(root) {
    var printBtn = document.getElementById("workspace-intel-print-btn");
    if (!printBtn || printBtn.dataset.filterPrintHooked === "1") return;

    function attach() {
      if (printBtn.dataset.filterPrintHooked === "1") return;
      printBtn.dataset.filterPrintHooked = "1";
      printBtn.addEventListener("click", function (event) {
        event.preventDefault();
        var href =
          printBtn.getAttribute("href") ||
          printBtn.dataset.printHref ||
          "";
        var filters = readFiltersFromForm(root);
        syncReportContextToServer(filters).finally(function () {
          if (href) {
            window.open(href, "_blank", "noopener,noreferrer");
          }
        });
      });
    }

    if (typeof window.kryxWorkspaceRerender === "function") {
      attach();
      return;
    }

    var tries = 0;
    var timer = window.setInterval(function () {
      tries += 1;
      if (typeof window.kryxWorkspaceRerender === "function" || tries > 40) {
        window.clearInterval(timer);
        attach();
      }
    }, 50);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
