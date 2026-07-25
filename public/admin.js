(function (global) {
  "use strict";

  const elements = {};

  function bind() {
    for (const id of [
      "admin-report-form",
      "admin-username",
      "admin-bypass",
      "admin-report-submit",
      "admin-report-status",
      "admin-report",
      "admin-report-generated",
      "admin-report-content",
    ]) {
      elements[id] = global.document.getElementById(id);
    }
  }

  function csrfToken() {
    const value = global.document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("odysseus_csrf="));
    if (!value) return "";
    return decodeURIComponent(value.slice(value.indexOf("=") + 1));
  }

  function setStatus(message, state) {
    elements["admin-report-status"].textContent = message;
    elements["admin-report-status"].dataset.state = state || "neutral";
  }

  function node(tagName, text, className) {
    const value = global.document.createElement(tagName);
    if (text !== undefined && text !== null) {
      value.textContent = String(text);
    }
    if (className) {
      value.className = className;
    }
    return value;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? date.toLocaleString()
      : "Unavailable";
  }

  function display(value) {
    if (value === null || value === undefined || value === "") {
      return "Unavailable";
    }
    return String(value);
  }

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  function readable(value) {
    if (value === null || value === undefined || value === "") {
      return "Unavailable";
    }
    return String(value)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function percentage(value) {
    return Number.isFinite(Number(value))
      ? `${Number(value)}%`
      : null;
  }

  function section(title, description, className) {
    const value = node(
      "section",
      null,
      `admin-report-section${className ? ` ${className}` : ""}`,
    );
    value.append(node("h3", title));
    if (description) {
      value.append(node("p", description));
    }
    return value;
  }

  function facts(values) {
    const list = node("dl", null, "admin-fact-grid");
    for (const [label, value] of values) {
      const item = node("div");
      item.append(node("dt", label), node("dd", display(value)));
      list.append(item);
    }
    return list;
  }

  function table(headers, rows) {
    const wrap = node("div", null, "admin-table-wrap");
    const value = node("table", null, "admin-table");
    const head = node("thead");
    const headingRow = node("tr");
    for (const header of headers) {
      headingRow.append(node("th", header));
    }
    head.append(headingRow);
    const body = node("tbody");
    for (const row of rows) {
      const item = node("tr");
      for (const cell of row) {
        item.append(node("td", display(cell)));
      }
      body.append(item);
    }
    value.append(head, body);
    wrap.append(value);
    return wrap;
  }

  function reasonList(values, emptyMessage) {
    const wrap = node("div", null, "admin-reason-list");
    const heading = node("h4", "Decision reasons");
    const codes = list(values);
    wrap.append(heading);
    if (!codes.length) {
      wrap.append(node(
        "p",
        emptyMessage || "No decision reason was saved.",
        "admin-empty",
      ));
      return wrap;
    }
    const items = node("ul");
    for (const code of codes.slice(0, 16)) {
      items.append(node("li", readable(code)));
    }
    wrap.append(items);
    return wrap;
  }

  function contributionRows(value) {
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        if (entry && typeof entry === "object") {
          return [
            entry.label || entry.name || entry.key || `Component ${index + 1}`,
            entry.current ?? entry.value ?? entry.contribution,
            entry.baseline ?? entry.baselineCenter,
            entry.difference ?? entry.delta ?? entry.normalizedDelta,
            entry.unit ?? entry.scale ?? entry.normalizationScale,
          ];
        }
        return [`Component ${index + 1}`, entry, null, null, null];
      });
    }
    if (value && typeof value === "object") {
      return Object.entries(value).map(([name, contribution]) => [
        name,
        contribution,
        null,
        null,
        null,
      ]);
    }
    return [];
  }

  function appendContributions(target, value) {
    const rows = contributionRows(value);
    if (!rows.length) return;
    target.append(
      node("h4", "Feature and component contributions"),
      table(
        ["Signal", "Current or contribution", "Baseline", "Difference", "Scale or unit"],
        rows,
      ),
    );
  }

  function renderFingerprint(fingerprint) {
    const features = list(fingerprint.features);
    const evolution = fingerprint.evolution || fingerprint.amendment || {};
    const value = section(
      `${fingerprint.reportLabel}: ${fingerprint.subjectLabel}`,
      "These baseline centers and normalization scales are the values used by the transparent distance model.",
    );
    value.append(facts([
      ["Profile", fingerprint.profileId],
      ["Samples", fingerprint.sampleCount],
      ["Features", fingerprint.featureCount],
      ["Model", fingerprint.comparisonModel],
      ["Accept at or below", fingerprint.acceptanceThreshold],
      ["Step-up above", fingerprint.stepUpThreshold],
      ["Enrollment P90", fingerprint.calibration?.p90EnrollmentDistance],
      ["Enrolled", formatDate(fingerprint.enrolledAt)],
      ["Updated", formatDate(fingerprint.updatedAt)],
      ["Accepted amendments", evolution.acceptedUpdates ?? evolution.updateCount],
      ["Last amendment", formatDate(
        evolution.lastUpdatedAt || evolution.updatedAt
      )],
    ]));
    if (features.length > 0) {
      value.append(table(
        ["Feature", "Baseline center", "Normal variation", "Scale"],
        features.map((feature) => [
          feature.name,
          feature.baselineCenter,
          feature.normalVariation,
          feature.normalizationScale,
        ]),
      ));
    }
    const fingerprintUpdates = list(
      fingerprint.updateHistory || fingerprint.amendments
    );
    if (fingerprintUpdates.length > 0) {
      value.append(
        node("h4", "Fingerprint update history"),
        table(
          ["When", "Status", "Reason", "Samples", "Learning rate"],
          fingerprintUpdates.map((update) => [
            formatDate(update.createdAt || update.updatedAt),
            readable(update.status || update.outcome),
            readable(update.reasonCode || update.reason),
            update.sampleCount ?? update.acceptedSampleCount,
            update.learningRate,
          ]),
        ),
      );
    }
    return value;
  }

  function renderComparison(comparison) {
    const identity = comparison.identitySimilarity || {};
    const automation = comparison.automationRisk || {};
    const evidence =
      comparison.interactionEvidence ||
      comparison.evidence ||
      {};
    const sampleCounts =
      comparison.sampleCounts ||
      evidence.sampleCounts ||
      {};
    const amendment = comparison.amendment || comparison.driftUpdate || {};
    const value = section(
      `${comparison.comparisonLabel}: ${comparison.claimedSubject}`,
      "Identity similarity answers whether the session resembles the selected baseline. Automation risk is a separate estimate.",
    );
    value.append(facts([
      ["Profile", comparison.profileId],
      ["Evaluated", formatDate(comparison.evaluatedAt)],
      ["Similarity decision", readable(identity.decision)],
      ["Trust", percentage(identity.trustPercent)],
      ["Distance", identity.normalizedDistance],
      ["Acceptance threshold", identity.acceptanceThreshold],
      ["Automation level", readable(automation.level)],
      ["Automation class", readable(automation.classification)],
      ["Dwell samples", sampleCounts.dwell],
      ["Flight samples", sampleCounts.flight],
      ["Pointer samples", sampleCounts.pointer],
      ["Fingerprint amendment", readable(
        amendment.status || (
          amendment.applied === true ? "applied" : null
        )
      )],
    ]));
    value.append(reasonList(
      identity.reasonCodes || comparison.reasonCodes,
    ));
    appendContributions(
      value,
      comparison.featureContributions ||
        identity.featureContributions ||
        comparison.featureDeltas ||
        comparison.componentContributions ||
        comparison.baselineComparison,
    );
    return value;
  }

  function renderStrongTest(report) {
    const identity = report.identitySimilarity || {};
    const automation = report.automationRisk || {};
    const amendment = report.amendment || report.fingerprintUpdate || {};
    const samples = list(report.samples);
    const amendmentApplied = (
      amendment.applied === true ||
      amendment.status === "applied"
    );
    const value = section(
      `${report.reportLabel}: ${report.subjectLabel}`,
      amendmentApplied
        ? "This approved local test combined three fresh samples and strengthened the saved fingerprint."
        : "This locally saved report combines three fresh comparison samples. Its update result is shown below.",
    );
    value.append(facts([
      ["Profile", report.profileId],
      ["Created", formatDate(report.createdAt)],
      ["Samples", report.sampleCount],
      ["Similarity class", readable(identity.classification)],
      ["Matching samples", `${identity.matchingSamples || 0} of ${identity.sampleCount || 0}`],
      ["Mean trust", percentage(identity.meanTrustPercent)],
      ["Mean distance", identity.meanNormalizedDistance],
      ["Automation class", readable(automation.classification)],
      ["Maximum automation risk", automation.maximumRiskScore],
      ["Fingerprint update", readable(
        amendment.status || (
          amendmentApplied ? "applied" : "not applied"
        )
      )],
      ["Previous sample total", amendment.sampleCountBefore ?? amendment.previousSampleCount],
      ["New sample total", amendment.sampleCountAfter ?? amendment.sampleCount],
    ]));
    appendContributions(value, report.featureSummary);
    if (samples.length > 0) {
      value.append(
        node("h4", "Individual sample decisions"),
        table(
          ["Sample", "Decision", "Trust", "Distance", "Automation", "Reasons"],
          samples.map((sample) => [
            sample.sampleLabel,
            readable(sample.decision),
            percentage(sample.trustPercent),
            sample.normalizedDistance,
            readable(
              sample.automationRisk?.classification ||
              sample.automationRisk?.level
            ),
            list(sample.reasonCodes).map(readable).join(", "),
          ]),
        ),
      );
    }
    return value;
  }

  function renderReport(report) {
    const container = elements["admin-report-content"];
    const account = report.account || {};
    const interpretation = report.interpretation || {};
    const posture = report.securityPosture || {};
    const fingerprints = list(report.fingerprints);
    const comparisons = list(report.comparisons);
    const strongTests = list(report.strongTests);
    const updateHistory = list(
      report.updateHistory || report.fingerprintUpdateHistory
    );
    const recentActivity = list(report.recentActivity);
    container.replaceChildren();
    elements["admin-report-generated"].textContent =
      `Generated ${formatDate(report.generatedAt)}`;

    const overview = section(
      account.username,
      interpretation.separation,
    );
    overview.append(facts([
      ["Account created", formatDate(account.createdAt)],
      ["Fingerprint reports", fingerprints.length],
      ["Comparison sessions", comparisons.length],
      ["Stronger reports", strongTests.length],
      ["Fingerprint updates", updateHistory.length],
      ["Active devices", posture.registeredDevices],
      ["Passkeys", posture.passkeys],
      ["Password bot flags", posture.credentialAutomationFlags],
    ]));
    container.append(overview);

    const caution = section(
      "Interpretation boundary",
      interpretation.caution,
      "admin-caution",
    );
    caution.append(facts([
      ["Identity question", interpretation.identityQuestion],
      ["Automation question", interpretation.automationQuestion],
    ]));
    container.append(caution);

    if (fingerprints.length === 0) {
      const empty = section("Fingerprint reports");
      empty.append(node(
        "p",
        "No behavioral baseline has been enrolled for this account.",
        "admin-empty",
      ));
      container.append(empty);
    } else {
      for (const fingerprint of fingerprints) {
        container.append(renderFingerprint(fingerprint));
      }
    }

    if (comparisons.length === 0) {
      const empty = section("Comparison sessions");
      empty.append(node(
        "p",
        "No returning-session comparison has been recorded.",
        "admin-empty",
      ));
      container.append(empty);
    } else {
      for (const comparison of comparisons) {
        container.append(renderComparison(comparison));
      }
    }

    if (strongTests.length > 0) {
      for (const strongTest of strongTests) {
        container.append(renderStrongTest(strongTest));
      }
    }

    const updates = section(
      "Fingerprint update history",
      "Approved amendments are listed separately from denied or insufficient comparisons.",
    );
    if (updateHistory.length > 0) {
      updates.append(table(
        ["When", "Profile", "Status", "Reason", "Samples", "Source"],
        updateHistory.map((update) => [
          formatDate(update.createdAt || update.updatedAt),
          update.profileId,
          readable(update.status || update.outcome),
          readable(update.reasonCode || update.reason),
          update.samplesAdded ?? update.sampleCount,
          readable(update.source || update.eventType),
        ]),
      ));
    } else {
      updates.append(node(
        "p",
        "No approved fingerprint amendment has been recorded.",
        "admin-empty",
      ));
    }
    container.append(updates);

    const activity = section(
      "Recent security activity",
      "Passwords, tokens, raw telemetry, and provider credentials are omitted.",
    );
    activity.append(table(
      ["When", "Event", "Outcome", "Reason", "Network"],
      recentActivity.map((event) => [
        formatDate(event.createdAt),
        event.eventType,
        event.outcome,
        event.reasonCode,
        event.ipAddress,
      ]),
    ));
    container.append(activity);
    elements["admin-report"].hidden = false;
  }

  async function prepareReport(event) {
    event.preventDefault();
    elements["admin-report-submit"].disabled = true;
    elements["admin-report"].hidden = true;
    setStatus("Verifying both credentials and preparing the report.", "working");
    try {
      if (!csrfToken()) {
        await global.fetch("/api/health", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
      }
      const response = await global.fetch("/api/demo-admin/report", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken(),
        },
        body: JSON.stringify({
          username: elements["admin-username"].value,
          adminBypass: elements["admin-bypass"].value,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          body?.error?.message || "The account report could not be opened.",
        );
      }
      renderReport(body.report);
      elements["admin-bypass"].value = "";
      setStatus("The local account report is ready.", "ready");
    } catch (error) {
      setStatus(error.message || "The account report could not be opened.", "error");
    } finally {
      elements["admin-report-submit"].disabled = false;
    }
  }

  function init() {
    bind();
    elements["admin-report-form"].addEventListener("submit", prepareReport);
    global.fetch("/api/health", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    }).catch(() => {});
  }

  if (global.document.readyState === "loading") {
    global.document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
