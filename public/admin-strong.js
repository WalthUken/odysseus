(function (global) {
  "use strict";

  const REQUIRED_SAMPLES = 3;
  const elements = {};
  const state = {
    username: "",
    password: "",
    samples: [],
    roundIndex: 0,
    routeProgress: 0,
    recording: false,
    submitting: false,
    timer: null,
    collector: null,
    diagnostic: null,
  };

  function bind() {
    for (const id of [
      "admin-test-access-form",
      "admin-test-username",
      "admin-test-password",
      "admin-test-access-submit",
      "admin-test-access-status",
      "admin-test-workspace",
      "admin-test-profile",
      "admin-test-subject",
      "admin-test-restart",
      "admin-test-round-number",
      "admin-test-mission",
      "admin-test-progress",
      "admin-test-phrase",
      "admin-test-guided",
      "admin-test-guided-status",
      "admin-test-free",
      "admin-test-free-status",
      "admin-test-route-status",
      "admin-test-board",
      "admin-test-round-status",
      "admin-test-result",
      "admin-test-result-id",
      "admin-test-result-content",
    ]) {
      elements[id] = global.document.getElementById(id);
    }
  }

  function csrfToken() {
    const value = global.document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("odysseus_csrf="));
    return value
      ? decodeURIComponent(value.slice(value.indexOf("=") + 1))
      : "";
  }

  function setStatus(element, message, status) {
    element.textContent = message;
    element.dataset.state = status || "neutral";
  }

  async function request(path, body) {
    if (!csrfToken()) {
      await global.fetch("/api/health", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
    }
    const response = await global.fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken(),
      },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) {
      throw new Error(
        value?.error?.message || "The local test request failed.",
      );
    }
    return value;
  }

  function currentRound() {
    return global.OdysseusChallenge.roundAt(
      "verification",
      state.roundIndex,
    );
  }

  function textResult() {
    return global.OdysseusChallenge.compareText(
      elements["admin-test-guided"].value,
      currentRound().prompt,
    );
  }

  function freeResult() {
    return global.OdysseusChallenge.evaluateFreeTyping(
      elements["admin-test-free"].value,
    );
  }

  function tasksComplete() {
    return (
      textResult().accepted
      && freeResult().complete
      && state.routeProgress >= currentRound().route.length
    );
  }

  function renderRound() {
    const round = currentRound();
    const text = textResult();
    const free = freeResult();
    const activeSlot = global.OdysseusChallenge.targetFor(
      round,
      state.routeProgress,
    );
    const completed = new Set(round.route.slice(0, state.routeProgress));
    elements["admin-test-round-number"].textContent =
      String(state.samples.length + 1).padStart(2, "0");
    elements["admin-test-mission"].textContent = round.label;
    elements["admin-test-phrase"].textContent = round.prompt;
    elements["admin-test-progress"].textContent =
      `${state.samples.length} of ${REQUIRED_SAMPLES} saved`;
    elements["admin-test-guided-status"].textContent = text.accepted
      ? "Phrase accepted"
      : text.typedLength > 0
        ? "Keep typing the displayed phrase"
        : "Phrase waiting";
    elements["admin-test-free-status"].textContent = free.complete
      ? "Answer ready"
      : free.characterCount > 0
        ? `${free.remainingCharacters} characters and ${free.remainingWords} words remaining`
        : "Answer waiting";
    elements["admin-test-route-status"].textContent =
      state.routeProgress >= round.route.length
        ? "Trail complete"
        : `Trail ${state.routeProgress} of ${round.route.length}`;

    elements["admin-test-board"]
      .querySelectorAll(".signal-target")
      .forEach((button) => {
        const slot = Number(button.dataset.slot);
        const active = slot === activeSlot;
        const complete = completed.has(slot);
        button.dataset.active = String(active);
        button.dataset.complete = String(complete);
        button.disabled = !state.recording || !active;
        button.setAttribute(
          "aria-label",
          active
            ? `Box ${slot + 1}, next target`
            : complete
              ? `Box ${slot + 1}, completed target`
              : `Box ${slot + 1}, inactive target`,
        );
      });
    elements["admin-test-guided"].disabled = !state.recording;
    elements["admin-test-free"].disabled = !state.recording;
  }

  function clearTimer() {
    if (state.timer !== null) {
      global.clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function interactionEvidence(sample) {
    return {
      version: 1,
      trustedEventsRequired:
        sample.integrity?.trustedEventsRequired === true,
      rejectedSyntheticEvents:
        Number(sample.integrity?.rejectedSyntheticEvents) || 0,
      sampleCounts: {
        dwell: Number(sample.counts?.dwell) || 0,
        flight: Number(sample.counts?.flight) || 0,
        downDown: Number(sample.counts?.downDown) || 0,
        pointer: Number(sample.counts?.pointer) || 0,
      },
      durationMs: Math.max(0, Math.round(Number(sample.durationMs) || 0)),
    };
  }

  function resetRound() {
    clearTimer();
    state.routeProgress = 0;
    state.diagnostic.reset();
    state.collector.reset();
    elements["admin-test-guided"].value = "";
    elements["admin-test-free"].value = "";
    state.recording = true;
    renderRound();
    setStatus(
      elements["admin-test-round-status"],
      "Complete all three tasks. The sample records automatically.",
      "neutral",
    );
    elements["admin-test-guided"].focus();
  }

  function scheduleSample() {
    clearTimer();
    if (
      !state.recording
      || !tasksComplete()
      || !state.collector.readiness().ready
    ) {
      return;
    }
    setStatus(
      elements["admin-test-round-status"],
      "All signals are ready. Recording this sample.",
      "working",
    );
    state.timer = global.setTimeout(recordSample, 250);
  }

  async function recordSample() {
    state.timer = null;
    if (
      !state.recording
      || !tasksComplete()
      || !state.collector.readiness().ready
    ) {
      return;
    }
    state.recording = false;
    const diagnostics = state.diagnostic.summarize({
      missionId: currentRound().id,
      keyPressCount: state.collector.readiness().counts.dwell,
    });
    const sample = state.collector.finalize({ reset: true });
    if (!sample.ok) {
      state.recording = true;
      setStatus(
        elements["admin-test-round-status"],
        sample.reason,
        "error",
      );
      renderRound();
      return;
    }
    state.samples.push({
      vector: sample.vector,
      diagnostics,
      interactionEvidence: interactionEvidence(sample),
    });
    elements["admin-test-profile"].disabled = true;
    elements["admin-test-subject"].disabled = true;
    if (state.samples.length < REQUIRED_SAMPLES) {
      state.roundIndex += 1;
      resetRound();
      setStatus(
        elements["admin-test-round-status"],
        `Sample saved. ${REQUIRED_SAMPLES - state.samples.length} remaining.`,
        "ready",
      );
      return;
    }
    renderRound();
    await submitTest();
  }

  function inputRecorded(kind, event) {
    if (!global.OdysseusTelemetry.isTrustedInteraction(event)) {
      event.target.value = "";
      setStatus(
        elements["admin-test-round-status"],
        "Direct browser input is required.",
        "error",
      );
      return;
    }
    state.diagnostic.record(kind, event.target.value);
    renderRound();
    scheduleSample();
  }

  function routeClicked(event) {
    if (!global.OdysseusTelemetry.isTrustedInteraction(event)) {
      setStatus(
        elements["admin-test-round-status"],
        "Direct browser input is required.",
        "error",
      );
      return;
    }
    const button = event.target.closest(".signal-target");
    if (!button || !state.recording) return;
    const result = global.OdysseusChallenge.acceptTarget(
      currentRound(),
      state.routeProgress,
      Number(button.dataset.slot),
    );
    if (!result.accepted) return;
    state.routeProgress = result.completedTargets;
    renderRound();
    scheduleSample();
  }

  function node(tagName, text, className) {
    const value = global.document.createElement(tagName);
    if (text !== undefined && text !== null) {
      value.textContent = String(text);
    }
    if (className) value.className = className;
    return value;
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

  function factGrid(values) {
    const list = node("dl", null, "admin-fact-grid");
    for (const [label, value] of values) {
      const item = node("div");
      item.append(
        node("dt", label),
        node("dd", value ?? "Unavailable"),
      );
      list.append(item);
    }
    return list;
  }

  function resultTable(report) {
    const wrap = node("div", null, "admin-table-wrap");
    const table = node("table", null, "admin-table");
    const head = node("thead");
    const heading = node("tr");
    for (const label of [
      "Feature",
      "Current average",
      "Baseline",
      "Difference",
      "Scale",
    ]) {
      heading.append(node("th", label));
    }
    head.append(heading);
    const body = node("tbody");
    for (const feature of list(report.featureSummary)) {
      const row = node("tr");
      for (const value of [
        feature.name,
        feature.currentAverage,
        feature.baselineCenter,
        feature.difference,
        feature.normalizationScale,
      ]) {
        row.append(node("td", value));
      }
      body.append(row);
    }
    table.append(head, body);
    wrap.append(table);
    return wrap;
  }

  function sampleTable(samples) {
    const wrap = node("div", null, "admin-table-wrap");
    const table = node("table", null, "admin-table");
    const head = node("thead");
    const heading = node("tr");
    for (const label of [
      "Sample",
      "Decision",
      "Trust",
      "Distance",
      "Automation",
      "Reasons",
    ]) {
      heading.append(node("th", label));
    }
    head.append(heading);
    const body = node("tbody");
    for (const sample of list(samples)) {
      const row = node("tr");
      const automation = sample.automationRisk || {};
      for (const value of [
        sample.sampleLabel,
        readable(sample.decision),
        Number.isFinite(Number(sample.trustPercent))
          ? `${sample.trustPercent}%`
          : "Unavailable",
        sample.normalizedDistance,
        readable(automation.classification || automation.level),
        list(sample.reasonCodes).map(readable).join(", "),
      ]) {
        row.append(node("td", value ?? "Unavailable"));
      }
      body.append(row);
    }
    table.append(head, body);
    wrap.append(table);
    return wrap;
  }

  function renderResult(report) {
    elements["admin-test-result-id"].textContent = report.id;
    const content = elements["admin-test-result-content"];
    content.replaceChildren();
    const identity = report.identitySimilarity || {};
    const automation = report.automationRisk || {};
    const amendment = report.amendment || report.fingerprintUpdate || {};
    const amendmentApplied = (
      amendment.applied === true ||
      amendment.status === "applied"
    );
    const section = node("section", null, "admin-report-section");
    section.append(
      node("h3", `${report.subjectLabel} against ${report.profileId}`),
      node(
        "p",
        amendmentApplied
          ? "Three approved samples matched safely and strengthened the saved fingerprint."
          : "Three samples were compared independently. The server did not approve a fingerprint update.",
      ),
      node(
        "p",
        amendmentApplied
          ? "Fingerprint strengthened"
          : `Update not applied: ${readable(
              amendment.reasonCode || amendment.reason || amendment.status
            )}`,
        amendmentApplied
          ? "admin-update-result is-applied"
          : "admin-update-result is-not-applied",
      ),
      factGrid([
        ["Similarity class", readable(identity.classification)],
        ["Matching samples", `${identity.matchingSamples || 0} of ${identity.sampleCount || 0}`],
        ["Mean trust", Number.isFinite(Number(identity.meanTrustPercent))
          ? `${identity.meanTrustPercent}%`
          : "Unavailable"],
        ["Mean distance", identity.meanNormalizedDistance],
        ["Acceptance threshold", identity.acceptanceThreshold],
        ["Automation class", readable(automation.classification)],
        ["Maximum automation risk", automation.maximumRiskScore],
        ["Fingerprint update", readable(
          amendment.status || (
            amendmentApplied ? "applied" : "not applied"
          )
        )],
        ["Previous sample total", amendment.sampleCountBefore ?? amendment.previousSampleCount],
        ["New sample total", amendment.sampleCountAfter ?? amendment.sampleCount],
      ]),
      resultTable(report),
    );
    if (list(report.samples).length > 0) {
      section.append(
        node("h4", "Individual sample decisions"),
        sampleTable(report.samples),
      );
    }
    content.append(section);
    elements["admin-test-result"].hidden = false;
  }

  async function submitTest() {
    if (state.submitting) return;
    state.submitting = true;
    setStatus(
      elements["admin-test-round-status"],
      "Building and saving the stronger report.",
      "working",
    );
    try {
      const result = await request("/api/demo-admin/test", {
        username: state.username,
        password: state.password,
        profileId: elements["admin-test-profile"].value,
        demoSubjectLabel: elements["admin-test-subject"].value,
        samples: state.samples,
      });
      renderResult(result.report);
      elements["admin-test-password"].value = "";
      state.password = "";
      const amendment =
        result.report.amendment ||
        result.report.fingerprintUpdate ||
        {};
      setStatus(
        elements["admin-test-round-status"],
        (
          amendment.applied === true ||
          amendment.status === "applied"
        )
          ? `Fingerprint strengthened with ${
              amendment.samplesAdded || REQUIRED_SAMPLES
            } approved samples.`
          : "The comparison report was saved, but the fingerprint was not changed.",
        (
          amendment.applied === true ||
          amendment.status === "applied"
        ) ? "ready" : "error",
      );
    } catch (error) {
      state.recording = false;
      setStatus(
        elements["admin-test-round-status"],
        error.message,
        "error",
      );
    } finally {
      state.submitting = false;
    }
  }

  function restartTest() {
    state.samples = [];
    state.roundIndex = 0;
    elements["admin-test-result"].hidden = true;
    elements["admin-test-profile"].disabled = false;
    elements["admin-test-subject"].disabled = false;
    resetRound();
  }

  async function unlockTest(event) {
    event.preventDefault();
    elements["admin-test-access-submit"].disabled = true;
    setStatus(
      elements["admin-test-access-status"],
      "Opening the locally saved account baseline.",
      "working",
    );
    try {
      const username = elements["admin-test-username"].value;
      const password = elements["admin-test-password"].value;
      const value = await request("/api/demo-admin/report", {
        username,
        password,
      });
      if (!Array.isArray(value.report.fingerprints)
        || value.report.fingerprints.length === 0) {
        throw new Error(
          "This account does not have a saved behavioral baseline.",
        );
      }
      state.username = username;
      state.password = password;
      const profile = elements["admin-test-profile"];
      profile.replaceChildren();
      for (const fingerprint of value.report.fingerprints) {
        const option = node("option", fingerprint.profileId);
        option.value = fingerprint.profileId;
        profile.append(option);
      }
      elements["admin-test-workspace"].hidden = false;
      state.collector.start();
      restartTest();
      setStatus(
        elements["admin-test-access-status"],
        `Testing the saved account ${value.report.account.username}.`,
        "ready",
      );
    } catch (error) {
      setStatus(
        elements["admin-test-access-status"],
        error.message,
        "error",
      );
    } finally {
      elements["admin-test-access-submit"].disabled = false;
    }
  }

  function init() {
    bind();
    if (
      !global.OdysseusTelemetry
      || !global.OdysseusDiagnostics
      || !global.OdysseusChallenge
    ) {
      setStatus(
        elements["admin-test-access-status"],
        "The local behavior modules could not be loaded.",
        "error",
      );
      return;
    }
    state.collector = global.OdysseusTelemetry.createCollector({
      keyboardTarget: global.document,
      pointerTarget: global.document,
      shouldCaptureKeyboard(event) {
        return (
          event.target === elements["admin-test-guided"]
          || event.target === elements["admin-test-free"]
        );
      },
    });
    state.diagnostic =
      global.OdysseusDiagnostics.createTypingDiagnostic();
    elements["admin-test-access-form"].addEventListener(
      "submit",
      unlockTest,
    );
    elements["admin-test-guided"].addEventListener(
      "input",
      (event) => inputRecorded("guided", event),
    );
    elements["admin-test-free"].addEventListener(
      "input",
      (event) => inputRecorded("free", event),
    );
    elements["admin-test-board"].addEventListener("click", routeClicked);
    elements["admin-test-restart"].addEventListener("click", restartTest);
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
