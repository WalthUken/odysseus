(function (global) {
  "use strict";

  const REQUIRED_ENROLLMENT_SAMPLES = 5;
  const DEFAULT_TRUST_THRESHOLD = 0.6;
  const VERIFICATION_INTERVAL_MS = 12000;

  const ids = Object.freeze({
    apiStatus: "api-status",
    authPanel: "auth-panel",
    authForm: "auth-form",
    authMode: "auth-mode",
    authUsername: "auth-username",
    authPassword: "auth-password",
    authSubmit: "auth-submit",
    authStatus: "auth-status",
    behaviorAccessWarning: "behavior-access-warning",
    behaviorWarningTitle: "behavior-warning-title",
    behaviorWarningSummary: "behavior-warning-summary",
    behaviorWarningIdentity: "behavior-warning-identity",
    behaviorWarningAutomation: "behavior-warning-automation",
    behaviorWarningDecision: "behavior-warning-decision",
    behaviorWarningReasonList: "behavior-warning-reason-list",
    simulatedIpWarning: "simulated-ip-warning",
    behaviorWarningRetry: "behavior-warning-retry",
    currentUserPanel: "current-user-panel",
    currentUser: "current-user",
    logoutButton: "logout-button",
    profileId: "profile-id",
    demoSubjectLabel: "demo-subject-label",
    resetProfile: "reset-profile",
    enrollmentForm: "enrollment-form",
    enrollmentRoundTag: "enrollment-round-tag",
    enrollmentMission: "enrollment-mission",
    enrollmentPhrase: "enrollment-phrase",
    enrollmentInput: "enrollment-input",
    enrollmentTextStatus: "enrollment-text-status",
    enrollmentFreeInput: "enrollment-free-input",
    enrollmentFreeStatus: "enrollment-free-status",
    enrollmentTrailStatus: "enrollment-trail-status",
    enrollmentBoard: "enrollment-board",
    enrollmentProgress: "enrollment-progress",
    enrollmentProgressLabel: "enrollment-progress-label",
    enrollmentStatus: "enrollment-status",
    verificationForm: "verification-form",
    verificationMission: "verification-mission",
    verificationPhrase: "verification-phrase",
    verificationInput: "verification-input",
    verificationTextStatus: "verification-text-status",
    verificationFreeInput: "verification-free-input",
    verificationFreeStatus: "verification-free-status",
    verificationTrailStatus: "verification-trail-status",
    verificationBoard: "verification-board",
    resetVerification: "reset-verification",
    verificationStatus: "verification-status",
    trustState: "trust-state",
    trustScore: "trust-score",
    trustFill: "trust-fill",
    decisionReason: "decision-reason",
    automationCard: "automation-card",
    automationLevel: "automation-level",
    automationExplanation: "automation-explanation",
    metricDwell: "metric-dwell",
    metricFlight: "metric-flight",
    metricPointer: "metric-pointer",
    stepUpWarning: "step-up-warning",
    stepUpForm: "step-up-form",
    stepUpField: "step-up-password",
    stepUpSubmit: "step-up-submit",
    stepUpStatus: "step-up-status",
    sensitiveAction: "sensitive-action",
    actionStatus: "action-status",
    securityReport: "security-report",
    actionResult: "action-result",
    dashboardShell: "dashboard-shell",
    dashboardUser: "dashboard-user",
    dashboardAvatar: "dashboard-avatar",
    dashboardTheme: "dashboard-theme",
    dashboardOverview: "dashboard-overview",
  });

  const elements = {};
  const enrollmentSamples = [];
  let collector = null;
  let authCollector = null;
  let authDiagnostics = null;
  let typingDiagnostics = null;
  let enrolled = false;
  let completedEnrollmentSamples = 0;
  let trustScore = 0;
  let verificationInFlight = false;
  let intervalId = null;
  let sessionObserver = null;
  let hydrationSequence = 0;
  let currentUser = null;
  let authInFlight = false;
  let actionInFlight = false;
  let enrollmentInFlight = false;
  let csrfBootstrapPromise = null;
  let enrollmentRoundIndex = 0;
  let verificationRoundIndex = 0;
  let enrollmentTrailProgress = 0;
  let verificationTrailProgress = 0;
  let currentAppView = "login";
  const autoSubmitTimers = {
    enrollment: null,
    verification: null,
  };

  function setText(element, text) {
    if (element) {
      element.textContent = text;
    }
  }

  function setInlineStatus(element, text, state) {
    setText(element, text);
    if (element) {
      element.dataset.state = state || "neutral";
    }
  }

  class ApiError extends Error {
    constructor(message, response, body) {
      super(message);
      this.name = "ApiError";
      this.status = response.status;
      this.code =
        (body && body.error && body.error.code) ||
        (body && body.code) ||
        "";
      this.body = body;
    }
  }

  function isAuthenticated() {
    return Boolean(currentUser);
  }

  function restartSessionObserver(view) {
    if (sessionObserver) {
      sessionObserver.destroy();
    }
    sessionObserver = global.OdysseusSession.createObserver(global);
    sessionObserver.setView(view || "unknown");
  }

  function setAppView(view, telemetryView) {
    const allowed = new Set(["login", "session", "dashboard", "account"]);
    const nextView = allowed.has(view) ? view : "login";
    currentAppView = nextView;
    global.document.body.dataset.appView = nextView;
    elements.dashboardShell.hidden = nextView === "login";
    global.document
      .querySelectorAll("[data-app-view-target]")
      .forEach((control) => {
        const active = control.dataset.appViewTarget === nextView;
        control.classList.toggle("is-active", active);
        if (active) {
          control.setAttribute("aria-current", "page");
        } else {
          control.removeAttribute("aria-current");
        }
      });
    if (sessionObserver) {
      sessionObserver.setView(telemetryView || nextView);
    }
  }

  function navigateAppView(view) {
    if (!isAuthenticated()) {
      setAppView("login", "login");
      elements.authUsername.focus();
      return;
    }
    if (view === "dashboard") {
      if (!enrolled) {
        setAppView("session", "enrollment");
        elements.enrollmentInput.focus();
        return;
      }
      setAppView("dashboard", "dashboard");
      elements.dashboardOverview.focus();
      return;
    }
    if (view === "account") {
      setAppView("account", "account");
      const heading = global.document.getElementById(
        "security-center-heading"
      );
      if (heading) {
        heading.focus();
      }
      return;
    }
    setAppView("session", enrolled ? "verification" : "enrollment");
    (enrolled
      ? elements.verificationInput
      : elements.enrollmentInput
    ).focus();
  }

  function csrfToken() {
    const cookie = global.document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("odysseus_csrf="));
    if (!cookie) {
      return "";
    }
    try {
      return decodeURIComponent(cookie.slice("odysseus_csrf=".length));
    } catch (_error) {
      return cookie.slice("odysseus_csrf=".length);
    }
  }

  async function ensureCsrfToken() {
    const existingValue = csrfToken();
    if (existingValue) {
      return existingValue;
    }

    if (!csrfBootstrapPromise) {
      csrfBootstrapPromise = global
        .fetch("/api/health", {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "same-origin",
        })
        .then((response) => {
          if (!response.ok) {
            throw new Error(
              `CSRF bootstrap failed with ${response.status}.`
            );
          }
          const issuedValue = csrfToken();
          if (!issuedValue) {
            throw new Error("The server did not issue a CSRF cookie.");
          }
          return issuedValue;
        })
        .finally(() => {
          csrfBootstrapPromise = null;
        });
    }

    return csrfBootstrapPromise;
  }

  function normalizeTrust(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
  }

  function responseReason(result) {
    const codes = result.reasonCodes || result.reasons;
    if (Array.isArray(codes) && codes.length) {
      return codes
        .map((code) => String(code).replace(/[_-]+/g, " ").toLowerCase())
        .join(", ");
    }
    return result.reason || result.message || "";
  }

  function readableBehaviorValue(value, fallback) {
    if (value === null || value === undefined || value === "") {
      return fallback || "Not assessed";
    }
    return String(value)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function behaviorDecisionFrom(value) {
    const source = value && value.body ? value.body : value;
    if (!source || typeof source !== "object") {
      return null;
    }
    const decision =
      source.behaviorDecision ||
      source.loginBehaviorDecision ||
      source.behaviorAssessment ||
      source.error?.behaviorDecision;
    return decision && typeof decision === "object" ? decision : null;
  }

  function behaviorReasonCodes(decision) {
    const identity = decision?.identitySimilarity;
    const automation = decision?.automationRisk;
    const candidates = [
      decision?.reasonCodes,
      decision?.reasons,
      identity?.reasonCodes,
      identity?.reasons,
      automation?.reasonCodes,
      automation?.reasons,
    ];
    const values = [];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        values.push(...candidate);
      }
    }
    return [...new Set(values.map((value) => String(value)).filter(Boolean))];
  }

  function behaviorDecisionAllowsAccess(decision) {
    if (!decision) {
      return true;
    }
    const value = String(
      decision.decision || decision.outcome || decision.classification || ""
    ).toLowerCase();
    return ![
      "deny",
      "denied",
      "review",
      "step_up",
      "step-up",
      "suspicious_identity",
      "automation_likely",
    ].includes(value);
  }

  function authenticatedBehaviorMessage(username, decision) {
    if (!decision) {
      return `Signed in as ${username}.`;
    }
    const classification = String(
      decision.classification || decision.identityClass || ""
    ).toLowerCase();
    const amendment = decision.amendment;
    if (
      amendment?.applied === true ||
      amendment?.status === "applied"
    ) {
      return `Signed in as ${username}. The trusted match strengthened the saved fingerprint.`;
    }
    if (
      amendment?.status === "candidate_recorded" ||
      amendment?.status === "pending"
    ) {
      return `Signed in as ${username}. The trusted match was recorded as a future fingerprint amendment candidate.`;
    }
    if (classification === "baseline_missing") {
      return `Signed in as ${username}. Complete the account questions to create the first saved fingerprint.`;
    }
    if (
      classification === "trusted_return" ||
      String(decision.decision || "").toLowerCase() === "allow"
    ) {
      return `Signed in as ${username}. Returning behavior matched the saved fingerprint.`;
    }
    return `Signed in as ${username}.`;
  }

  function showBehaviorWarning(decision) {
    const identity = decision?.identitySimilarity || {};
    const automation = decision?.automationRisk || {};
    const automationClass = String(
      automation.classification || automation.level || ""
    ).toLowerCase();
    const identityClass = String(
      identity.classification || decision?.classification || ""
    ).toLowerCase();
    const reasonCodes = behaviorReasonCodes(decision);
    const insufficientEvidence = [
      "baseline_missing",
      "insufficient_evidence",
      "more_interaction_required",
    ].includes(identityClass) || reasonCodes.some((code) => [
      "BEHAVIOR_EVIDENCE_INSUFFICIENT",
      "BEHAVIOR_EVIDENCE_REQUIRED",
      "PROFILE_FEATURE_COVERAGE_INSUFFICIENT",
    ].includes(String(code).toUpperCase()));
    const likelyAutomation = automationClass === "automation_likely";
    const title = insufficientEvidence
      ? "More natural interaction is required"
      : likelyAutomation
        ? "Automated behavior requires review"
        : "This sign-in did not match safely";
    const summary = insufficientEvidence
      ? "The server did not receive enough timing and pointer evidence to compare this sign-in safely. Try again using the form naturally."
      : likelyAutomation
        ? "The server detected several automation-like interaction signals and paused access."
        : "The server found a meaningful difference from the saved account fingerprint and paused access.";

    setText(elements.behaviorWarningTitle, title);
    setText(elements.behaviorWarningSummary, summary);
    setText(
      elements.behaviorWarningIdentity,
      readableBehaviorValue(
        identity.classification || identity.decision,
        "Review required"
      )
    );
    setText(
      elements.behaviorWarningAutomation,
      readableBehaviorValue(
        automation.classification || automation.level,
        "Not assessed"
      )
    );
    setText(
      elements.behaviorWarningDecision,
      readableBehaviorValue(
        decision?.decision || decision?.outcome,
        "Access paused"
      )
    );

    elements.behaviorWarningReasonList.replaceChildren();
    const visibleReasons = reasonCodes.length
      ? reasonCodes
      : [
          insufficientEvidence
            ? "MORE_INTERACTION_REQUIRED"
            : "BEHAVIORAL_DIFFERENCE_REQUIRES_REVIEW",
        ];
    for (const reason of visibleReasons.slice(0, 8)) {
      const item = global.document.createElement("li");
      item.textContent = readableBehaviorValue(reason);
      elements.behaviorWarningReasonList.append(item);
    }

    const simulated = decision?.simulatedIpRestriction;
    elements.simulatedIpWarning.hidden = !(
      simulated &&
      simulated.displayed === true &&
      simulated.enforced === false
    );
    elements.authPanel.hidden = true;
    elements.behaviorAccessWarning.hidden = false;
    const recovery = global.document.getElementById("account-recovery-panel");
    if (recovery) {
      recovery.hidden = true;
    }
    elements.behaviorAccessWarning.focus();
  }

  function closeBehaviorWarning() {
    elements.behaviorAccessWarning.hidden = true;
    elements.simulatedIpWarning.hidden = true;
    elements.authPanel.hidden = false;
    const recovery = global.document.getElementById("account-recovery-panel");
    if (recovery) {
      recovery.hidden = false;
    }
    if (authCollector) {
      authCollector.reset();
    }
    if (authDiagnostics) {
      authDiagnostics.reset();
    }
    elements.authPassword.value = "";
    setInlineStatus(
      elements.authStatus,
      "Try again naturally, or use another approved account recovery method.",
      "neutral"
    );
    elements.authUsername.focus();
  }

  function challengeReferences(mode) {
    const enrollmentMode = mode === "enrollment";
    return {
      input: enrollmentMode
        ? elements.enrollmentInput
        : elements.verificationInput,
      freeInput: enrollmentMode
        ? elements.enrollmentFreeInput
        : elements.verificationFreeInput,
      mission: enrollmentMode
        ? elements.enrollmentMission
        : elements.verificationMission,
      phrase: enrollmentMode
        ? elements.enrollmentPhrase
        : elements.verificationPhrase,
      textStatus: enrollmentMode
        ? elements.enrollmentTextStatus
        : elements.verificationTextStatus,
      freeStatus: enrollmentMode
        ? elements.enrollmentFreeStatus
        : elements.verificationFreeStatus,
      trailStatus: enrollmentMode
        ? elements.enrollmentTrailStatus
        : elements.verificationTrailStatus,
      status: enrollmentMode
        ? elements.enrollmentStatus
        : elements.verificationStatus,
      board: enrollmentMode
        ? elements.enrollmentBoard
        : elements.verificationBoard,
    };
  }

  function challengeRound(mode) {
    const index =
      mode === "enrollment" ? enrollmentRoundIndex : verificationRoundIndex;
    return global.OdysseusChallenge.roundAt(mode, index);
  }

  function trailProgress(mode) {
    return mode === "enrollment"
      ? enrollmentTrailProgress
      : verificationTrailProgress;
  }

  function setTrailProgress(mode, value) {
    if (mode === "enrollment") {
      enrollmentTrailProgress = value;
    } else {
      verificationTrailProgress = value;
    }
  }

  function challengeAvailable(mode) {
    if (!isAuthenticated()) {
      return false;
    }
    if (mode === "enrollment") {
      return !enrolled && !enrollmentInFlight;
    }
    return enrolled && !verificationInFlight;
  }

  function challengeTextResult(mode) {
    const references = challengeReferences(mode);
    return global.OdysseusChallenge.evaluateShortResponse(
      references.input.value
    );
  }

  function requiresFreeTyping(mode) {
    return (
      mode === "enrollment" &&
      enrollmentRoundIndex === REQUIRED_ENROLLMENT_SAMPLES - 1
    );
  }

  function freeTypingResult(mode) {
    if (!requiresFreeTyping(mode)) {
      return {
        complete: true,
        characterCount: 0,
        wordCount: 0,
        remainingCharacters: 0,
        remainingWords: 0,
      };
    }
    return global.OdysseusChallenge.evaluateFreeTyping(
      challengeReferences(mode).freeInput.value
    );
  }

  function challengeTasksComplete(mode) {
    return (
      challengeTextResult(mode).accepted &&
      freeTypingResult(mode).complete
    );
  }

  function renderChallenge(mode) {
    const references = challengeReferences(mode);
    const round = challengeRound(mode);
    const comparison = challengeTextResult(mode);
    const freeTyping = freeTypingResult(mode);
    const available = challengeAvailable(mode);
    const freeTypingRequired = requiresFreeTyping(mode);

    setText(references.mission, round.label);
    setText(
      references.phrase,
      "Answer naturally. The words are processed locally and then cleared."
    );
    const promptCard = references.phrase.closest(".prompt-card");
    if (promptCard) {
      promptCard.hidden = true;
    }
    const freeTypingField = references.freeInput.closest(".field");
    if (freeTypingField) {
      freeTypingField.hidden = !freeTypingRequired;
    }
    const trail = references.board.closest(".signal-trail");
    if (trail) {
      trail.hidden = true;
    }
    references.board.hidden = true;
    references.trailStatus.hidden = true;
    if (mode === "enrollment") {
      setText(
        elements.enrollmentRoundTag,
        enrolled
          ? "Setup saved"
          : `Round ${Math.min(
              enrollmentRoundIndex + 1,
              REQUIRED_ENROLLMENT_SAMPLES
            )} of ${REQUIRED_ENROLLMENT_SAMPLES}`
      );
    }

    let textStatus = "Response waiting";
    if (comparison.accepted) {
      textStatus = "Response ready";
    } else if (comparison.typedLength > 0) {
      textStatus =
        comparison.remainingCharacters > 0
          ? `${comparison.remainingCharacters} characters left`
          : `${comparison.remainingWords} words left`;
    }
    setText(references.textStatus, textStatus);
    references.textStatus.dataset.complete = String(comparison.accepted);
    references.input.setAttribute(
      "aria-invalid",
      String(comparison.needsCorrection)
    );

    let freeStatus = freeTypingRequired
      ? "Open response waiting"
      : "Open response later";
    if (freeTypingRequired && freeTyping.complete) {
      freeStatus = "Open response ready";
    } else if (freeTyping.characterCount > 0) {
      freeStatus =
        freeTyping.remainingCharacters > 0
          ? `${freeTyping.remainingCharacters} free characters left`
          : `${freeTyping.remainingWords} free words left`;
    }
    setText(references.freeStatus, freeStatus);
    references.freeStatus.dataset.complete = String(freeTyping.complete);

    references.board.querySelectorAll(".signal-target").forEach((button) => {
      button.disabled = true;
      button.removeAttribute("aria-current");
    });

    references.input.disabled = !available;
    references.input.readOnly =
      available &&
      comparison.accepted &&
      collector &&
      collector.readiness().ready;
    references.freeInput.disabled = !available || !freeTypingRequired;
    if (mode === "verification") {
      elements.resetVerification.disabled = !available;
    }
  }

  function cancelAutoSubmit(mode) {
    if (autoSubmitTimers[mode] !== null) {
      global.clearTimeout(autoSubmitTimers[mode]);
      autoSubmitTimers[mode] = null;
    }
  }

  function scheduleAutoSubmit(mode) {
    cancelAutoSubmit(mode);
    if (
      !challengeAvailable(mode) ||
      !challengeTasksComplete(mode) ||
      !collector.readiness().ready
    ) {
      return;
    }

    autoSubmitTimers[mode] = global.setTimeout(() => {
      autoSubmitTimers[mode] = null;
      if (
        !challengeAvailable(mode) ||
        !challengeTasksComplete(mode) ||
        !collector.readiness().ready
      ) {
        return;
      }
      if (mode === "enrollment") {
        submitEnrollment();
      } else {
        verify("automatic");
      }
    }, 250);
  }

  function clearChallengeInputs(mode) {
    const references = challengeReferences(mode);
    clearBehaviorInput(references.input);
    clearBehaviorInput(references.freeInput);
  }

  function resetChallenge(mode, options) {
    const supplied = options || {};
    cancelAutoSubmit(mode);
    if (mode === "enrollment") {
      if (Number.isSafeInteger(supplied.index)) {
        enrollmentRoundIndex = supplied.index;
      } else if (supplied.advance) {
        enrollmentRoundIndex = Math.min(
          enrollmentRoundIndex + 1,
          REQUIRED_ENROLLMENT_SAMPLES - 1
        );
      }
    } else if (Number.isSafeInteger(supplied.index)) {
      verificationRoundIndex = supplied.index;
    } else if (supplied.advance) {
      verificationRoundIndex += 1;
    }

    setTrailProgress(mode, 0);
    if (typingDiagnostics) {
      typingDiagnostics[mode].reset();
    }
    clearChallengeInputs(mode);
    renderChallenge(mode);
  }

  function resetAllChallenges() {
    cancelAutoSubmit("enrollment");
    cancelAutoSubmit("verification");
    enrollmentRoundIndex = 0;
    verificationRoundIndex =
      Math.floor(Date.now() / 60000) %
      global.OdysseusChallenge.VERIFICATION_ROUNDS.length;
    enrollmentTrailProgress = 0;
    verificationTrailProgress = 0;
    if (typingDiagnostics) {
      typingDiagnostics.enrollment.reset();
      typingDiagnostics.verification.reset();
    }
    clearChallengeInputs("enrollment");
    clearChallengeInputs("verification");
    renderChallenge("enrollment");
    renderChallenge("verification");
  }

  function handleChallengeTarget(mode, event) {
    if (!global.OdysseusTelemetry.isTrustedInteraction(event)) {
      rejectSyntheticChallengeInteraction(mode);
      return;
    }
    const button = event.target.closest(".signal-target");
    if (!button || !challengeAvailable(mode)) {
      return;
    }
    const round = challengeRound(mode);
    const result = global.OdysseusChallenge.acceptTarget(
      round,
      trailProgress(mode),
      Number(button.dataset.slot)
    );
    if (!result.accepted) {
      return;
    }
    setTrailProgress(mode, result.completedTargets);
    renderChallenge(mode);
    showSampleReadiness(mode);
  }

  function rejectSyntheticChallengeInteraction(mode, input) {
    cancelAutoSubmit(mode);
    if (input) {
      clearBehaviorInput(input);
    }
    renderChallenge(mode);
    setInlineStatus(
      challengeReferences(mode).status,
      "Direct browser input is required. Script-dispatched events are not accepted.",
      "error"
    );
  }

  function recordChallengeInput(mode, kind, input, event) {
    if (!global.OdysseusTelemetry.isTrustedInteraction(event)) {
      rejectSyntheticChallengeInteraction(mode, input);
      return false;
    }
    typingDiagnostics[mode].record(kind, input.value, {
      inputType:
        event && typeof event.inputType === "string"
          ? event.inputType
          : "",
    });
    showSampleReadiness(mode);
    return true;
  }

  function policyAllowsSensitiveAction(result, normalizedTrust) {
    const policy = result && result.policy;
    if (policy && typeof policy === "object") {
      const policyValue =
        policy.allowSensitiveAction ??
        policy.allowSensitiveActions ??
        policy.sensitiveActionAllowed ??
        policy.allowed;
      if (typeof policyValue === "boolean") {
        return policyValue;
      }
    }

    const decision = String((result && result.decision) || "").toLowerCase();
    if (
      [
        "reject",
        "deny",
        "denied",
        "challenge",
        "step-up",
        "step_up",
      ].includes(decision)
    ) {
      return false;
    }
    return enrolled && normalizedTrust >= DEFAULT_TRUST_THRESHOLD;
  }

  function updateTrust(nextTrust, allowed, decision) {
    const normalized = normalizeTrust(nextTrust);
    if (normalized !== null) {
      trustScore = normalized;
    }

    const percent = Math.round(trustScore * 100);
    const state =
      decision ||
      (percent >= 75 ? "Trusted" : percent >= 60 ? "Review" : "Challenge");
    setText(elements.trustScore, String(percent));
    setText(elements.trustState, state);

    if (elements.trustFill) {
      elements.trustFill.style.width = `${percent}%`;
      elements.trustFill.parentElement.setAttribute(
        "aria-valuenow",
        String(percent)
      );
      elements.trustFill.classList.toggle("is-review", percent >= 60 && percent < 75);
      elements.trustFill.classList.toggle("is-challenge", percent < 60);
    }

    if (elements.trustState) {
      elements.trustState.classList.toggle("is-trusted", percent >= 75);
      elements.trustState.classList.toggle(
        "is-review",
        percent >= 60 && percent < 75
      );
      elements.trustState.classList.toggle("is-challenge", percent < 60);
    }

    const canAct = Boolean(allowed);
    const actionDisabled = !isAuthenticated() || actionInFlight;
    elements.sensitiveAction.disabled = actionDisabled;
    elements.sensitiveAction.setAttribute(
      "aria-disabled",
      String(actionDisabled)
    );
    elements.sensitiveAction.dataset.trustAllowed = String(canAct);
    if (canAct || !isAuthenticated()) {
      elements.stepUpWarning.hidden = true;
    }
  }

  function updateMetrics(vector) {
    if (!vector) {
      setText(elements.metricDwell, "0");
      setText(elements.metricFlight, "0");
      setText(elements.metricPointer, "0");
      return;
    }
    setText(elements.metricDwell, String(Math.round(vector.dwellMean || 0)));
    setText(elements.metricFlight, String(Math.round(vector.flightMean || 0)));
    setText(
      elements.metricPointer,
      String(Math.round(vector.pointerVelocityMean || 0))
    );
  }

  function updateAutomationAssessment(assessment) {
    const value = assessment && typeof assessment === "object"
      ? assessment
      : null;
    const classification = value?.classification || "insufficient_evidence";
    const labels = {
      automation_likely: "High risk",
      elevated_review: "Review",
      human_like_interaction: "Low risk",
      insufficient_evidence: "Not assessed",
    };
    const explanations = {
      automation_likely:
        "The interaction contains multiple automation-like signals. Password or passkey review is required.",
      elevated_review:
        "Some signals merit review, but they do not establish that an agent produced the interaction.",
      human_like_interaction:
        "No strong automation pattern was found. This does not prove a human produced the interaction.",
      insufficient_evidence:
        "Identity similarity and automation risk are evaluated separately.",
    };
    setText(
      elements.automationLevel,
      labels[classification] || "Not assessed",
    );
    setText(
      elements.automationExplanation,
      explanations[classification] || explanations.insufficient_evidence,
    );
    if (elements.automationCard) {
      elements.automationCard.dataset.level = value?.level || "unknown";
    }
  }

  function interactionEvidence(sample) {
    const boundedInteger = (value, maximum) =>
      Math.max(
        0,
        Math.min(maximum, Math.round(Number(value) || 0))
      );
    const boundedScale = (value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric >= 0.1
        ? Math.min(10, numeric)
        : 1;
    };
    const snapshot = sessionObserver ? sessionObserver.snapshot() : null;
    const sessionInteraction = snapshot?.interaction;
    const visualScaleMinimum = boundedScale(
      snapshot?.zoom?.visualScaleMinimum
    );
    const visualScaleMaximum = Math.max(
      visualScaleMinimum,
      boundedScale(snapshot?.zoom?.visualScaleMaximum)
    );
    const pixelRatioMinimum = boundedScale(
      snapshot?.zoom?.devicePixelRatioMinimum
    );
    const pixelRatioMaximum = Math.max(
      pixelRatioMinimum,
      boundedScale(snapshot?.zoom?.devicePixelRatioMaximum)
    );
    const elapsedMs = boundedInteger(
      snapshot?.pageSession?.elapsedMs,
      24 * 60 * 60 * 1_000
    );
    let remainingViewMs = elapsedMs;
    const viewTiming = [];
    if (Array.isArray(sessionInteraction?.viewTiming)) {
      for (const entry of sessionInteraction.viewTiming.slice(0, 16)) {
        const durationMs = Math.min(
          remainingViewMs,
          boundedInteger(entry.durationMs, 24 * 60 * 60 * 1_000)
        );
        viewTiming.push({
          view: String(entry.view || "unknown"),
          durationMs,
        });
        remainingViewMs -= durationMs;
      }
    }
    const sessionAggregate = snapshot
      ? {
          elapsedMs,
          keyboard: {
            keyDownEvents:
              boundedInteger(
                sessionInteraction?.keyboard?.keyDownEvents,
                200_000
              ),
            keyUpEvents:
              boundedInteger(
                sessionInteraction?.keyboard?.keyUpEvents,
                200_000
              ),
            repeatedKeyEvents:
              boundedInteger(
                sessionInteraction?.keyboard?.repeatedKeyEvents,
                200_000
              ),
            inputEvents:
              boundedInteger(
                sessionInteraction?.keyboard?.inputEvents,
                200_000
              ),
            correctionEvents:
              boundedInteger(
                sessionInteraction?.keyboard?.correctionEvents,
                200_000
              ),
            deletionEvents:
              boundedInteger(
                sessionInteraction?.keyboard?.deletionEvents,
                200_000
              ),
            undoEvents:
              boundedInteger(
                sessionInteraction?.keyboard?.undoEvents,
                200_000
              ),
          },
          pointer: {
            moveEvents:
              boundedInteger(
                sessionInteraction?.pointer?.moveEvents,
                200_000
              ),
            distancePx:
              boundedInteger(
                sessionInteraction?.pointer?.distancePx,
                1_000_000_000
              ),
            pointerDownEvents:
              boundedInteger(
                sessionInteraction?.pointer?.pointerDownEvents,
                200_000
              ),
            pointerUpEvents:
              boundedInteger(
                sessionInteraction?.pointer?.pointerUpEvents,
                200_000
              ),
            clickEvents:
              boundedInteger(
                sessionInteraction?.pointer?.clickEvents,
                200_000
              ),
            doubleClickEvents:
              boundedInteger(
                sessionInteraction?.pointer?.doubleClickEvents,
                200_000
              ),
            contextMenuEvents:
              boundedInteger(
                sessionInteraction?.pointer?.contextMenuEvents,
                200_000
              ),
          },
          scrolling: {
            wheelEvents:
              boundedInteger(
                sessionInteraction?.scrolling?.wheelEvents,
                200_000
              ),
            scrollEvents:
              boundedInteger(
                sessionInteraction?.scrolling?.scrollEvents,
                200_000
              ),
            distancePx:
              boundedInteger(
                sessionInteraction?.scrolling?.distancePx,
                1_000_000_000
              ),
          },
          delays: {
            sampleCount:
              boundedInteger(
                sessionInteraction?.delays?.sampleCount,
                200_000
              ),
            averageMs:
              boundedInteger(
                sessionInteraction?.delays?.averageMs,
                24 * 60 * 60 * 1_000
              ),
            deviationMs:
              boundedInteger(
                sessionInteraction?.delays?.deviationMs,
                24 * 60 * 60 * 1_000
              ),
            longestMs:
              boundedInteger(
                sessionInteraction?.delays?.longestMs,
                24 * 60 * 60 * 1_000
              ),
          },
          zoom: {
            changeEvents: boundedInteger(
              snapshot.zoom?.changeEvents,
              200_000
            ),
            visualScaleMinimum,
            visualScaleMaximum,
            devicePixelRatioMinimum: pixelRatioMinimum,
            devicePixelRatioMaximum: pixelRatioMaximum,
          },
          viewTiming,
        }
      : undefined;
    return {
      version: 2,
      trustedEventsRequired:
        sample.integrity?.trustedEventsRequired === true,
      rejectedSyntheticEvents:
        boundedInteger(
          sample.integrity?.rejectedSyntheticEvents,
          1_000
        ),
      sampleCounts: {
        dwell: boundedInteger(sample.counts?.dwell, 1_000),
        flight: boundedInteger(sample.counts?.flight, 1_000),
        downDown: boundedInteger(sample.counts?.downDown, 1_000),
        pointer: boundedInteger(sample.counts?.pointer, 1_000),
      },
      durationMs: boundedInteger(sample.durationMs, 10 * 60 * 1_000),
      sessionAggregate,
    };
  }

  function boundedAuthSampleCounts(readiness) {
    const counts = readiness?.counts || {};
    const bounded = (value) =>
      Math.max(0, Math.min(1_000, Math.round(Number(value) || 0)));
    return {
      dwell: bounded(counts.dwell),
      flight: bounded(counts.flight),
      downDown: bounded(counts.downDown),
      pointer: bounded(counts.pointer),
    };
  }

  function redactedInputShape(value) {
    return Array.from(String(value || ""))
      .slice(0, 128)
      .map((character) => (/\s/.test(character) ? " " : "x"))
      .join("");
  }

  function recordAuthInput(kind, event) {
    if (
      !authDiagnostics ||
      !global.OdysseusTelemetry.isTrustedInteraction(event)
    ) {
      return;
    }
    authDiagnostics.record(
      kind,
      redactedInputShape(event.target.value),
      {
        inputType:
          typeof event.inputType === "string" ? event.inputType : "",
      }
    );
  }

  function collectAuthBehaviorEvidence(username) {
    const readiness = authCollector.readiness();
    const sampleCounts = boundedAuthSampleCounts(readiness);
    const diagnostics = authDiagnostics.summarize({
      missionId: "steady-session",
      keyPressCount: sampleCounts.dwell,
    });
    const sample = authCollector.finalize({ reset: true });
    authDiagnostics.reset();

    if (!sample.ok) {
      return {
        profileId: username,
        status: "insufficient_evidence",
        sampleCounts,
      };
    }
    return {
      profileId: username,
      status: "ready",
      sampleCounts,
      vector: sample.vector,
      diagnostics,
      interactionEvidence: interactionEvidence(sample),
    };
  }

  function updateEnrollmentProgress(count) {
    completedEnrollmentSamples = Math.max(
      0,
      Math.min(REQUIRED_ENROLLMENT_SAMPLES, Number(count) || 0)
    );
    setText(
      elements.enrollmentProgressLabel,
      `${completedEnrollmentSamples} of ${REQUIRED_ENROLLMENT_SAMPLES}`
    );
    elements.enrollmentProgress.dataset.complete = String(
      completedEnrollmentSamples
    );
    elements.enrollmentProgress.setAttribute(
      "aria-valuenow",
      String(completedEnrollmentSamples)
    );
  }

  function clearBehaviorInput(input) {
    // Diagnostic text is evaluated locally, then cleared without transmission.
    input.value = "";
    input.readOnly = false;
    input.removeAttribute("aria-invalid");
  }

  function profileId() {
    return elements.profileId.value.trim();
  }

  function requireProfile() {
    const id = profileId();
    if (id) {
      return id;
    }
    setInlineStatus(
      elements.enrollmentStatus,
      "Enter a profile ID before continuing.",
      "error"
    );
    elements.profileId.focus();
    return null;
  }

  function requireAuth(statusElement) {
    if (isAuthenticated()) {
      return true;
    }
    setInlineStatus(
      statusElement || elements.authStatus,
      "Sign in before using the account workspace.",
      "error"
    );
    elements.authUsername.focus();
    return false;
  }

  async function request(path, options) {
    const supplied = options || {};
    const acceptNotFound = supplied.acceptNotFound === true;
    const acceptUnauthorized = supplied.acceptUnauthorized === true;
    const csrfRetried = supplied.csrfRetried === true;
    const fetchOptions = { ...supplied };
    delete fetchOptions.acceptNotFound;
    delete fetchOptions.acceptUnauthorized;
    delete fetchOptions.csrfRetried;

    const method = String(fetchOptions.method || "GET").toUpperCase();
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
    const headers = new Headers(fetchOptions.headers || {});
    headers.set("Accept", "application/json");
    if (fetchOptions.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    let requestCsrf = csrfToken();
    if (mutating && !requestCsrf) {
      requestCsrf = await ensureCsrfToken();
    }
    if (mutating && requestCsrf) {
      headers.set("X-CSRF-Token", requestCsrf);
    }

    const response = await global.fetch(path, {
      ...fetchOptions,
      method,
      headers,
      credentials: "same-origin",
    });

    let body = {};
    try {
      body = await response.json();
    } catch (_error) {
      body = {};
    }

    if (acceptNotFound && response.status === 404) {
      return { notFound: true };
    }

    if (acceptUnauthorized && response.status === 401) {
      return { unauthorized: true };
    }

    if (!response.ok) {
      const errorCode =
        body.error && typeof body.error.code === "string"
          ? body.error.code.toUpperCase()
          : "";
      if (
        mutating &&
        response.status === 403 &&
        errorCode === "CSRF_REJECTED" &&
        !csrfRetried
      ) {
        if (!csrfToken()) {
          await ensureCsrfToken();
        }
        return request(path, {
          ...supplied,
          csrfRetried: true,
        });
      }
      const errorMessage =
        typeof body.error === "string"
          ? body.error
          : body.error && body.error.message;
      throw new ApiError(
        errorMessage ||
          body.message ||
          `Request failed with ${response.status}.`,
        response,
        body
      );
    }
    return body;
  }

  function authenticatedUserFrom(result) {
    const body = result || {};
    const candidate =
      body.user ||
      body.account ||
      (body.session && body.session.user) ||
      body;
    const username =
      candidate && typeof candidate.username === "string"
        ? candidate.username
        : typeof body.username === "string"
          ? body.username
          : "";
    if (!username) {
      return null;
    }
    return {
      id: candidate && candidate.id,
      username,
      profileId:
        (candidate && candidate.profileId) ||
        body.profileId ||
        username,
      role: candidate && candidate.role,
      isAdmin: Boolean(candidate && candidate.isAdmin),
      createdAt: candidate && candidate.createdAt,
      updatedAt: candidate && candidate.updatedAt,
    };
  }

  function setWorkspaceControls() {
    const authenticated = isAuthenticated();
    global.document.body.dataset.sessionMode = enrolled
      ? "verification"
      : "enrollment";
    elements.profileId.disabled = !authenticated;
    elements.demoSubjectLabel.disabled = !authenticated;
    elements.resetProfile.disabled = !authenticated || !enrolled;
    elements.sensitiveAction.disabled = !authenticated || actionInFlight;
    elements.sensitiveAction.setAttribute(
      "aria-disabled",
      String(!authenticated || actionInFlight)
    );
    renderChallenge("enrollment");
    renderChallenge("verification");
  }

  function showAuthenticatedUser(user, message) {
    currentUser = user;
    elements.behaviorAccessWarning.hidden = true;
    elements.simulatedIpWarning.hidden = true;
    elements.authPanel.hidden = false;
    const recovery = global.document.getElementById("account-recovery-panel");
    if (recovery) {
      recovery.hidden = false;
    }
    elements.authPanel.dataset.authenticated = "true";
    elements.authForm.hidden = true;
    elements.currentUserPanel.hidden = false;
    setText(elements.currentUser, user.username);
    setText(elements.dashboardUser, user.username);
    setText(
      elements.dashboardAvatar,
      Array.from(user.username)[0]?.toLocaleUpperCase() || "U"
    );
    elements.profileId.value = String(user.profileId || user.username);
    elements.authPassword.value = "";
    setInlineStatus(
      elements.authStatus,
      message || "Authenticated session restored.",
      "ready"
    );
    if (global.OdysseusAccount) {
      global.OdysseusAccount.setAuthenticatedUser(user);
    }
    restartSessionObserver("unknown");
    setAppView("session", "unknown");
    setWorkspaceControls();
  }

  function showSignedOut(message, state) {
    currentUser = null;
    elements.behaviorAccessWarning.hidden = true;
    elements.simulatedIpWarning.hidden = true;
    elements.authPanel.hidden = false;
    const recovery = global.document.getElementById("account-recovery-panel");
    if (recovery) {
      recovery.hidden = false;
    }
    elements.authPanel.dataset.authenticated = "false";
    elements.authForm.hidden = false;
    elements.currentUserPanel.hidden = true;
    setText(elements.currentUser, "Not signed in");
    setText(elements.dashboardUser, "Not signed in");
    setText(elements.dashboardAvatar, "U");
    elements.profileId.value = "";
    elements.authPassword.value = "";
    elements.stepUpField.value = "";
    elements.stepUpWarning.hidden = true;
    setInlineStatus(
      elements.authStatus,
      message ||
        "Sign in or create a local demo account to unlock the workspace.",
      state || "neutral"
    );
    if (global.OdysseusAccount) {
      global.OdysseusAccount.setAuthenticatedUser(null);
    }
    restartSessionObserver("login");
    setAppView("login", "login");
    resetLocalState();
    if (authCollector) {
      authCollector.reset();
    }
    if (authDiagnostics) {
      authDiagnostics.reset();
    }
    setWorkspaceControls();
  }

  function handleAuthenticatedError(error, statusElement) {
    if (error.status === 401) {
      showSignedOut("Your session ended. Sign in again.", "error");
      elements.authUsername.focus();
      return true;
    }
    setInlineStatus(statusElement, error.message, "error");
    return false;
  }

  function updateAuthMode() {
    const registering = elements.authMode.value === "register";
    setText(elements.authSubmit, registering ? "Create account" : "Sign in");
    elements.authPassword.autocomplete = registering
      ? "new-password"
      : "current-password";
    setInlineStatus(
      elements.authStatus,
      registering
        ? "Create a local demo account. Do not reuse a real password."
        : "Sign in to restore your saved account setup.",
      "neutral"
    );
    if (authCollector) {
      authCollector.reset();
    }
    if (authDiagnostics) {
      authDiagnostics.reset();
    }
  }

  async function submitAuth() {
    if (authInFlight) {
      return;
    }
    const mode =
      elements.authMode.value === "register" ? "register" : "login";
    const username = elements.authUsername.value.trim();
    const credential = elements.authPassword.value;
    const credentialIsValid = credential.length >= 6;
    if (!username || !credentialIsValid) {
      setInlineStatus(
        elements.authStatus,
        "Enter a username and a password with at least 6 characters.",
        "error"
      );
      (!username ? elements.authUsername : elements.authPassword).focus();
      return;
    }

    authInFlight = true;
    elements.authSubmit.disabled = true;
    setInlineStatus(
      elements.authStatus,
      mode === "register"
        ? "Creating your local account."
        : "Starting your protected session.",
      "working"
    );

    const turnstileToken =
      global.OdysseusAccount &&
      global.OdysseusAccount.getTurnstileToken();
    const behaviorEvidence =
      mode === "login"
        ? collectAuthBehaviorEvidence(username)
        : undefined;
    if (mode === "register") {
      authCollector.reset();
      authDiagnostics.reset();
    }
    const payload = JSON.stringify({
      username,
      password: credential,
      turnstileToken: turnstileToken || undefined,
      behaviorEvidence,
    });
    elements.authPassword.value = "";

    try {
      const result = await request(`/api/auth/${mode}`, {
        method: "POST",
        body: payload,
      });
      const behaviorDecision = behaviorDecisionFrom(result);
      if (!behaviorDecisionAllowsAccess(behaviorDecision)) {
        showBehaviorWarning(behaviorDecision);
        return;
      }
      let user = authenticatedUserFrom(result);
      if (!user) {
        const session = await request("/api/auth/me", { method: "GET" });
        user = authenticatedUserFrom(session);
      }
      if (!user) {
        throw new Error("The server did not return an authenticated account.");
      }
      showAuthenticatedUser(
        user,
        mode === "register"
          ? `Account created. Signed in as ${user.username}.`
          : authenticatedBehaviorMessage(user.username, behaviorDecision)
      );
      await hydrateProfile();
      if (isAuthenticated()) {
        (enrolled
          ? elements.verificationInput
          : elements.enrollmentInput
        ).focus();
      }
    } catch (error) {
      const behaviorDecision = behaviorDecisionFrom(error);
      if (
        String(error.code).toUpperCase() === "BEHAVIOR_LOGIN_DENIED" &&
        behaviorDecision
      ) {
        showBehaviorWarning(behaviorDecision);
        return;
      }
      setInlineStatus(elements.authStatus, error.message, "error");
      elements.authPassword.focus();
    } finally {
      authInFlight = false;
      elements.authSubmit.disabled = false;
      if (global.OdysseusAccount) {
        global.OdysseusAccount.resetTurnstile();
      }
    }
  }

  async function hydrateAuth() {
    setInlineStatus(
      elements.authStatus,
      "Checking for an existing session.",
      "working"
    );
    try {
      const result = await request("/api/auth/me", {
        method: "GET",
        acceptUnauthorized: true,
      });
      if (result.unauthorized) {
        showSignedOut();
        return;
      }
      const user = authenticatedUserFrom(result);
      if (!user) {
        showSignedOut();
        return;
      }
      showAuthenticatedUser(user, `Signed in as ${user.username}.`);
      await hydrateProfile();
    } catch (error) {
      showSignedOut(
        `Account service unavailable: ${error.message}`,
        "error"
      );
    }
  }

  async function logout() {
    if (!isAuthenticated()) {
      showSignedOut();
      return;
    }
    elements.logoutButton.disabled = true;
    setInlineStatus(elements.authStatus, "Signing out.", "working");
    try {
      await request("/api/auth/logout", {
        method: "POST",
        body: JSON.stringify({}),
      });
      showSignedOut("Signed out. Local account controls are locked.", "ready");
      try {
        await ensureCsrfToken();
      } catch (_error) {
        setInlineStatus(
          elements.authStatus,
          "Signed out. Refresh the page before creating another account.",
          "error"
        );
      }
      elements.authUsername.focus();
    } catch (error) {
      if (error.status === 401) {
        showSignedOut("Your session ended. Sign in again.", "error");
        elements.authUsername.focus();
      } else {
        setInlineStatus(elements.authStatus, error.message, "error");
      }
    } finally {
      elements.logoutButton.disabled = false;
    }
  }

  function showSampleReadiness(mode) {
    renderChallenge(mode);
    const comparison = challengeTextResult(mode);
    const freeTyping = freeTypingResult(mode);
    const readiness = collector.readiness();
    const output =
      mode === "verification"
        ? elements.verificationStatus
        : elements.enrollmentStatus;
    if (!comparison.accepted) {
      cancelAutoSubmit(mode);
      const remaining =
        comparison.remainingCharacters > 0
          ? `${comparison.remainingCharacters} more characters`
          : `${comparison.remainingWords} more words`;
      setInlineStatus(
        output,
        `Answer naturally. Add ${remaining} and the question will continue automatically.`,
        "collecting"
      );
      return;
    }
    if (!freeTyping.complete) {
      cancelAutoSubmit(mode);
      const remaining =
        freeTyping.remainingCharacters > 0
          ? `${freeTyping.remainingCharacters} more characters`
          : `${freeTyping.remainingWords} more words`;
      setInlineStatus(
        output,
        `Response accepted automatically. Add ${remaining} in the final open response.`,
        "collecting"
      );
      return;
    }
    if (readiness.ready) {
      setInlineStatus(
        output,
        "Response ready. Continuing automatically.",
        "working"
      );
      scheduleAutoSubmit(mode);
      return;
    }
    cancelAutoSubmit(mode);
    setInlineStatus(
      output,
      "Response ready. Keep using the page naturally while the check finishes.",
      "collecting"
    );
  }

  async function submitEnrollment() {
    if (enrollmentInFlight) {
      return;
    }
    if (!requireAuth(elements.enrollmentStatus)) {
      return;
    }
    const id = requireProfile();
    if (!id || enrolled) {
      if (enrolled) {
        setInlineStatus(
          elements.enrollmentStatus,
          "Reset the profile before creating another saved setup.",
          "error"
        );
      }
      return;
    }
    if (!challengeTasksComplete("enrollment")) {
      setInlineStatus(
        elements.enrollmentStatus,
        "Finish this response before recording the question.",
        "error"
      );
      return;
    }

    cancelAutoSubmit("enrollment");
    enrollmentInFlight = true;
    renderChallenge("enrollment");
    const sample = collector.finalize({ reset: true });
    if (!sample.ok) {
      enrollmentInFlight = false;
      renderChallenge("enrollment");
      setInlineStatus(elements.enrollmentStatus, sample.reason, "error");
      return;
    }

    enrollmentSamples.push(sample.vector);
    updateMetrics(sample.vector);
    updateEnrollmentProgress(enrollmentSamples.length);

    if (enrollmentSamples.length < REQUIRED_ENROLLMENT_SAMPLES) {
      enrollmentInFlight = false;
      resetChallenge("enrollment", { advance: true });
      setInlineStatus(
        elements.enrollmentStatus,
        `Mission complete. ${
          REQUIRED_ENROLLMENT_SAMPLES - enrollmentSamples.length
        } missions remaining.`,
        "ready"
      );
      elements.enrollmentInput.focus();
      return;
    }

    clearChallengeInputs("enrollment");
    setInlineStatus(
      elements.enrollmentStatus,
      "Saving the account setup.",
      "working"
    );

    try {
      const result = await request("/api/enroll", {
        method: "POST",
        body: JSON.stringify({
          profileId: id,
          samples: enrollmentSamples.slice(0, REQUIRED_ENROLLMENT_SAMPLES),
        }),
      });
      enrolled = true;
      enrollmentSamples.length = 0;
      updateEnrollmentProgress(
        result.sampleCount ?? REQUIRED_ENROLLMENT_SAMPLES
      );
      updateTrust(1, true, "Enrolled");
      setText(
        elements.decisionReason,
        responseReason(result) ||
          "Setup saved. The returning session check is ready."
      );
      setInlineStatus(
        elements.enrollmentStatus,
        "Security question setup complete.",
        "ready"
      );
      setWorkspaceControls();
      setAppView("dashboard", "dashboard");
      elements.dashboardOverview.focus();
      if (global.OdysseusAccount) {
        global.OdysseusAccount.pushNotification(
          "Saved setup ready",
          "Five interaction missions were accepted for this profile.",
          "ready"
        );
        global.OdysseusAccount.refresh();
      }
    } catch (error) {
      enrollmentSamples.length = 0;
      updateEnrollmentProgress(0);
      resetChallenge("enrollment", { index: 0 });
      updateTrust(0, false, "Enrollment failed");
      handleAuthenticatedError(error, elements.enrollmentStatus);
    } finally {
      enrollmentInFlight = false;
      setWorkspaceControls();
    }
  }

  async function verify(source) {
    if (!isAuthenticated()) {
      if (source === "explicit") {
        requireAuth(elements.verificationStatus);
      }
      return;
    }
    if (!enrolled || verificationInFlight) {
      if (source === "explicit" && !enrolled) {
        setInlineStatus(
          elements.verificationStatus,
          "Complete the account questions first.",
          "error"
        );
      }
      return;
    }

    const id = requireProfile();
    if (!id) {
      return;
    }
    if (!challengeTasksComplete("verification")) {
      if (source === "explicit") {
        setInlineStatus(
          elements.verificationStatus,
          "Finish this response before running the check.",
          "error"
        );
      }
      return;
    }

    cancelAutoSubmit("verification");
    const typingDiagnostic = typingDiagnostics.verification.summarize({
      missionId: challengeRound("verification").id,
      keyPressCount: collector.readiness().counts.dwell,
    });
    const sample = collector.finalize({ reset: true });
    if (!sample.ok) {
      if (source === "explicit") {
        setInlineStatus(elements.verificationStatus, sample.reason, "error");
      }
      return;
    }

    updateMetrics(sample.vector);
    verificationInFlight = true;
    renderChallenge("verification");
    setInlineStatus(
      elements.verificationStatus,
      "Comparing this session with the saved setup.",
      "working"
    );

    try {
      const result = await request("/api/verify", {
        method: "POST",
        body: JSON.stringify({
          profileId: id,
          vector: sample.vector,
          diagnostics: typingDiagnostic,
          interactionEvidence: interactionEvidence(sample),
        }),
      });
      const rawTrust =
        result.trustScore ?? result.trustPercent ?? result.score ?? trustScore;
      const normalized = normalizeTrust(rawTrust) ?? trustScore;
      const allowed = policyAllowsSensitiveAction(result, normalized);
      const decision = String(
        result.decision || (allowed ? "Trusted" : "Challenge")
      );

      updateTrust(normalized, allowed, decision);
      updateAutomationAssessment(result.automationAssessment);
      setText(
        elements.decisionReason,
        responseReason(result) || "The current session was compared with the saved setup."
      );
      setInlineStatus(
        elements.verificationStatus,
        `Verification complete. Trust is ${Math.round(normalized * 100)}.`,
        allowed ? "ready" : "error"
      );
      resetChallenge("verification", { advance: true });
      setAppView("dashboard", "dashboard");
      if (global.OdysseusAccount) {
        global.OdysseusAccount.pushNotification(
          allowed ? "Session matched" : "Session review required",
          `The server returned a trust score of ${Math.round(
            normalized * 100
          )}.`,
          allowed ? "ready" : "error"
        );
        global.OdysseusAccount.refresh();
      }

      global.document.dispatchEvent(
        new CustomEvent("odysseus:trust-updated", {
          detail: {
            trustScore: normalized,
            allowed,
            decision,
            distance: result.distance,
            automationAssessment: result.automationAssessment || null,
          },
        })
      );
    } catch (error) {
      updateTrust(trustScore, false, "Unavailable");
      setText(elements.decisionReason, error.message);
      resetChallenge("verification", { advance: true });
      if (!handleAuthenticatedError(error, elements.verificationStatus)) {
        setInlineStatus(
          elements.verificationStatus,
          error.message || "Verification could not be completed.",
          "error"
        );
      }
    } finally {
      verificationInFlight = false;
      setWorkspaceControls();
    }
  }

  function resetLocalState() {
    enrolled = false;
    enrollmentInFlight = false;
    verificationInFlight = false;
    trustScore = 0;
    enrollmentSamples.length = 0;
    if (collector) {
      collector.reset();
    }
    updateEnrollmentProgress(0);
    updateTrust(0, false, "Not evaluated");
    updateMetrics(null);
    updateAutomationAssessment(null);
    resetAllChallenges();
    setText(
      elements.decisionReason,
      "Complete enrollment and a verification mission to calculate trust."
    );
    setText(elements.actionResult, "");
    elements.actionResult.removeAttribute("data-state");
    setText(elements.actionStatus, "");
    elements.actionStatus.hidden = true;
    elements.actionStatus.removeAttribute("data-state");
    elements.securityReport.hidden = true;
    elements.securityReport.removeAttribute("open");
    elements.stepUpWarning.hidden = true;
    elements.stepUpField.value = "";
    setInlineStatus(elements.stepUpStatus, "", "neutral");
    setWorkspaceControls();
  }

  async function hydrateProfile() {
    if (!isAuthenticated()) {
      resetLocalState();
      return;
    }
    const id = profileId();
    const sequence = ++hydrationSequence;
    resetLocalState();

    if (!id) {
      setInlineStatus(
        elements.enrollmentStatus,
        "Enter a profile ID to create or restore a saved setup.",
        "neutral"
      );
      return;
    }

    setInlineStatus(
      elements.enrollmentStatus,
      "Checking for an existing setup.",
      "working"
    );

    try {
      const result = await request(
        `/api/profiles/${encodeURIComponent(id)}`,
        {
          method: "GET",
          acceptNotFound: true,
        }
      );
      if (sequence !== hydrationSequence || id !== profileId()) {
        return;
      }

      if (result.notFound) {
        setAppView("session", "enrollment");
        setInlineStatus(
          elements.enrollmentStatus,
          "No saved setup found. Ready for the first check-in.",
          "neutral"
        );
        return;
      }

      enrolled = true;
      setAppView("session", "verification");
      updateEnrollmentProgress(
        result.sampleCount ?? REQUIRED_ENROLLMENT_SAMPLES
      );
      updateTrust(0, false, "Ready to verify");
      setWorkspaceControls();
      setText(
        elements.decisionReason,
        result.enrolledAt
          ? `Existing setup from ${new Date(
              result.enrolledAt
            ).toLocaleString()} is ready. Complete a verification mission.`
          : "Existing setup restored. Complete a returning session check."
      );
      setInlineStatus(
        elements.enrollmentStatus,
        "Existing setup restored.",
        "ready"
      );
    } catch (error) {
      if (sequence !== hydrationSequence) {
        return;
      }
      handleAuthenticatedError(error, elements.enrollmentStatus);
    }
  }

  async function resetProfile() {
    if (!requireAuth(elements.enrollmentStatus)) {
      return;
    }
    const id = requireProfile();
    if (!id) {
      return;
    }
    elements.resetProfile.disabled = true;
    setInlineStatus(
      elements.enrollmentStatus,
      "Removing the saved setup.",
      "working"
    );
    try {
      await request(`/api/profiles/${encodeURIComponent(id)}`, {
        method: "DELETE",
        acceptNotFound: true,
      });
      resetLocalState();
      setInlineStatus(
        elements.enrollmentStatus,
        "Profile reset. Ready for the first mission.",
        "ready"
      );
      elements.enrollmentInput.focus();
    } catch (error) {
      handleAuthenticatedError(error, elements.enrollmentStatus);
    } finally {
      setWorkspaceControls();
    }
  }

  function resetVerification() {
    if (!requireAuth(elements.verificationStatus)) {
      return;
    }
    collector.reset();
    resetChallenge("verification", { index: verificationRoundIndex });
    updateMetrics(null);
    setInlineStatus(
      elements.verificationStatus,
      "Verification mission restarted.",
      "neutral"
    );
    elements.verificationInput.focus();
  }

  function showStepUp(message, focusPassword) {
    elements.stepUpWarning.hidden = false;
    setInlineStatus(
      elements.stepUpStatus,
      message || "Confirm your password to continue.",
      "error"
    );
    if (focusPassword) {
      elements.stepUpField.focus();
    }
  }

  function requiresStepUp(error) {
    const code = String(error.code || "").toUpperCase();
    if (code) {
      return (
        code.includes("STEP_UP") ||
        code.includes("RECENT_VERIFICATION") ||
        code.includes("RECENT_AUTH")
      );
    }
    return error.status === 403;
  }

  function formatReportDate(value) {
    if (!value) {
      return "Unavailable";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "Unavailable";
    }
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function formatGrantDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) {
      return "Unavailable";
    }
    if (seconds <= 0) {
      return "Expired";
    }
    if (seconds < 60) {
      return `${Math.ceil(seconds)} seconds`;
    }
    return `${Math.ceil(seconds / 60)} minutes`;
  }

  function readableReportLabel(value) {
    const normalized = String(value || "")
      .replace(/[._-]+/g, " ")
      .trim();
    if (!normalized) {
      return "Unavailable";
    }
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  function formatReportMetric(value, unit, places = 0) {
    if (value === null || value === undefined || value === "") {
      return "Unavailable";
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return "Unavailable";
    }
    return `${numeric.toFixed(places)}${unit ? ` ${unit}` : ""}`;
  }

  function appendReportField(list, label, value) {
    const field = global.document.createElement("div");
    field.className = "security-report-field";

    const term = global.document.createElement("dt");
    term.textContent = label;
    const detail = global.document.createElement("dd");
    detail.textContent = value || "Unavailable";

    field.append(term, detail);
    list.appendChild(field);
  }

  function appendReportList(container, title, items, formatter) {
    if (!items.length) {
      return;
    }

    const section = global.document.createElement("section");
    section.className = "security-report-section";
    const heading = global.document.createElement("h5");
    heading.textContent = title;
    const list = global.document.createElement("ul");

    items.forEach((item) => {
      const row = global.document.createElement("li");
      const primary = global.document.createElement("strong");
      const secondary = global.document.createElement("span");
      const formatted = formatter(item);
      primary.textContent = formatted.primary;
      secondary.textContent = formatted.secondary;
      row.append(primary, secondary);
      list.appendChild(row);
    });

    section.append(heading, list);
    container.appendChild(section);
  }

  function appendReportOverview(container, summary, authorization) {
    const overview = global.document.createElement("section");
    overview.className = "security-report-overview";

    const posture = global.document.createElement("div");
    posture.className = "security-report-posture";
    const status = global.document.createElement("span");
    status.textContent = summary.status || "Report generated";
    const heading = global.document.createElement("h5");
    heading.textContent = summary.posture || "Authorization reviewed";
    const explanation = global.document.createElement("p");
    explanation.textContent =
      summary.explanation ||
      "Odysseus confirmed the protected action with the active session.";
    posture.append(status, heading, explanation);

    const statistics = global.document.createElement("dl");
    statistics.className = "security-report-statistics";
    const reportStatistics = [
      [
        "Latest trust",
        Number.isFinite(summary.latestTrustPercent)
          ? `${Math.round(summary.latestTrustPercent)}%`
          : "Not scored",
      ],
      ["Profiles", String(Number(summary.profileCount) || 0)],
      [
        "Enrollment samples",
        String(Number(summary.totalEnrollmentSamples) || 0),
      ],
      ["Signal features", String(Number(summary.signalFeatureCount) || 0)],
      [
        "Average key hold",
        Number.isFinite(summary.averageKeyHoldMs)
          ? `${Math.round(summary.averageKeyHoldMs)} ms`
          : "Not measured",
      ],
      ["Cadence", summary.cadencePattern || "Not measured"],
      [
        "Grant remaining",
        formatGrantDuration(authorization.grantRemainingSeconds),
      ],
    ];

    reportStatistics.forEach(([label, value]) => {
      const statistic = global.document.createElement("div");
      statistic.className = "security-report-statistic";
      const term = global.document.createElement("dt");
      term.textContent = label;
      const detail = global.document.createElement("dd");
      detail.textContent = value;
      statistic.append(term, detail);
      statistics.appendChild(statistic);
    });

    overview.append(posture, statistics);
    container.appendChild(overview);
  }

  function appendReportNotes(container, title, items, tone) {
    if (!Array.isArray(items) || items.length === 0) {
      return;
    }
    const section = global.document.createElement("section");
    section.className = `security-report-section security-report-notes${
      tone ? ` is-${tone}` : ""
    }`;
    const heading = global.document.createElement("h5");
    heading.textContent = title;
    const list = global.document.createElement("ul");
    items.forEach((item) => {
      const row = global.document.createElement("li");
      row.textContent = item;
      list.appendChild(row);
    });
    section.append(heading, list);
    container.appendChild(section);
  }

  function renderSecurityReport(result) {
    const record = result && result.record;
    if (!record || typeof record !== "object") {
      setInlineStatus(
        elements.actionStatus,
        "Access passed, but the server returned no report data.",
        "error"
      );
      return;
    }

    const account =
      record.account && typeof record.account === "object"
        ? record.account
        : {};
    const authorization =
      record.authorization && typeof record.authorization === "object"
        ? record.authorization
        : {};
    const summary =
      record.summary && typeof record.summary === "object"
        ? record.summary
        : {};
    const session =
      record.session && typeof record.session === "object"
        ? record.session
        : {};
    const device =
      record.device && typeof record.device === "object"
        ? record.device
        : null;
    const latestVerification =
      record.latestVerification &&
      typeof record.latestVerification === "object"
        ? record.latestVerification
        : null;
    const auditedSession =
      latestVerification?.sessionAggregate &&
      typeof latestVerification.sessionAggregate === "object"
        ? latestVerification.sessionAggregate
        : null;
    const behaviorDiagnostics =
      latestVerification?.behaviorDiagnostics &&
      typeof latestVerification.behaviorDiagnostics === "object"
        ? latestVerification.behaviorDiagnostics
        : null;
    const network =
      record.network && typeof record.network === "object"
        ? record.network
        : {};
    const geminiReadiness =
      record.geminiReadiness && typeof record.geminiReadiness === "object"
        ? record.geminiReadiness
        : {};
    const keyboardDiagnostics = behaviorDiagnostics?.keyboard || {};
    const pointerDiagnostics = behaviorDiagnostics?.pointer || {};
    const typingDiagnostics = behaviorDiagnostics?.typing || {};
    const slowWords = behaviorDiagnostics?.slowWords || {};
    const baselineComparison = Array.isArray(
      behaviorDiagnostics?.baselineComparison
    )
      ? behaviorDiagnostics.baselineComparison
      : [];
    const profiles = Array.isArray(record.profiles) ? record.profiles : [];
    const controls = Array.isArray(record.controls) ? record.controls : [];
    const recentActivity = Array.isArray(record.recentActivity)
      ? record.recentActivity
      : [];
    const privacy =
      record.privacy && typeof record.privacy === "object"
        ? record.privacy
        : {};
    const limitations = Array.isArray(record.limitations)
      ? record.limitations
      : [];
    const recommendations = Array.isArray(record.recommendations)
      ? record.recommendations
      : [];
    const localSession = sessionObserver
      ? sessionObserver.snapshot()
      : null;

    setText(elements.actionResult, "");
    elements.actionResult.dataset.state = "ready";
    elements.securityReport.hidden = false;
    elements.securityReport.removeAttribute("open");
    elements.actionStatus.hidden = false;
    setInlineStatus(
      elements.actionStatus,
      "Authenticated report ready. Open the detailed report when you want to inspect it.",
      "ready"
    );

    const header = global.document.createElement("div");
    header.className = "security-report-header";
    const headingBlock = global.document.createElement("div");
    const kicker = global.document.createElement("span");
    kicker.className = "security-report-kicker";
    kicker.textContent = `Server-authorized report v${
      Number(record.reportVersion) || 1
    }`;
    const heading = global.document.createElement("h4");
    heading.textContent = record.title || "Account security report";
    headingBlock.append(kicker, heading);

    const badge = global.document.createElement("span");
    badge.className = "security-report-badge";
    badge.textContent = record.classification || "Protected";
    header.append(headingBlock, badge);

    const fields = global.document.createElement("dl");
    fields.className = "security-report-grid";
    appendReportField(fields, "Receipt", record.id);
    appendReportField(fields, "Account", account.username);
    appendReportField(
      fields,
      "Current IP",
      network.currentIpAddress
    );
    appendReportField(
      fields,
      "Verification IP",
      network.latestVerificationIpAddress
    );
    appendReportField(
      fields,
      "Authorized by",
      readableReportLabel(authorization.method || result.authorizedBy)
    );
    appendReportField(
      fields,
      "Generated",
      formatReportDate(record.generatedAt)
    );
    appendReportField(
      fields,
      "Account created",
      formatReportDate(account.createdAt)
    );
    appendReportField(
      fields,
      "Session started",
      formatReportDate(session.createdAt)
    );
    appendReportField(
      fields,
      "Session expires",
      formatReportDate(session.expiresAt || authorization.sessionExpiresAt)
    );
    appendReportField(
      fields,
      "Grant expires",
      formatReportDate(authorization.grantExpiresAt)
    );

    elements.actionResult.append(header);
    appendReportOverview(elements.actionResult, summary, authorization);
    elements.actionResult.append(fields);
    appendReportList(
      elements.actionResult,
      "Latest behavior decision",
      latestVerification ? [latestVerification] : [],
      (verification) => ({
        primary: Number.isFinite(verification.trustPercent)
          ? `${Math.round(verification.trustPercent)}% trust, ${readableReportLabel(
              verification.decision
            )}`
          : readableReportLabel(verification.decision),
        secondary: `${
          verification.profileId || "Unknown profile"
        }, ${formatReportDate(verification.evaluatedAt)}${
          Number.isFinite(verification.normalizedDistance)
            ? `, distance ${verification.normalizedDistance}`
            : ""
        }`,
      })
    );
    appendReportList(
      elements.actionResult,
      "Keyboard timing",
      behaviorDiagnostics
        ? [
            {
              primary: "Average key hold",
              secondary: `${formatReportMetric(
                keyboardDiagnostics.averageKeyHoldMs,
                "ms"
              )} with ${formatReportMetric(
                keyboardDiagnostics.keyHoldVariationMs,
                "ms"
              )} variation`,
            },
            {
              primary: "Average transition between keys",
              secondary: `${formatReportMetric(
                keyboardDiagnostics.averageTransitionMs,
                "ms"
              )} with ${formatReportMetric(
                keyboardDiagnostics.transitionVariationMs,
                "ms"
              )} variation`,
            },
            {
              primary: "Average key-to-key interval",
              secondary: `${formatReportMetric(
                keyboardDiagnostics.averageKeyIntervalMs,
                "ms"
              )} with ${formatReportMetric(
                keyboardDiagnostics.intervalVariationMs,
                "ms"
              )} variation`,
            },
            {
              primary: "Observed rhythm",
              secondary: `${keyboardDiagnostics.holdConsistency || "Unavailable"}, ${
                keyboardDiagnostics.transitionPattern || "Unavailable"
              }`,
            },
          ]
        : [],
      (item) => item
    );
    appendReportList(
      elements.actionResult,
      "Typing cadence and patterns",
      behaviorDiagnostics && typingDiagnostics
        ? [
            {
              primary: typingDiagnostics.cadencePattern || "Typing cadence",
              secondary: `${formatReportMetric(
                typingDiagnostics.cadencePerMinute,
                "key timings per minute"
              )} across ${formatReportMetric(
                typingDiagnostics.totalDurationMs,
                "ms"
              )}`,
            },
            {
              primary: "Pauses",
              secondary: `${
                Number(typingDiagnostics.pauses?.count) || 0
              } pauses at or above ${formatReportMetric(
                typingDiagnostics.pauses?.thresholdMs,
                "ms"
              )}, longest ${formatReportMetric(
                typingDiagnostics.pauses?.longestMs,
                "ms"
              )}`,
            },
            {
              primary: "Typing bursts",
              secondary: `${
                Number(typingDiagnostics.bursts?.count) || 0
              } bursts averaging ${formatReportMetric(
                typingDiagnostics.bursts?.averageEvents,
                "input events",
                1
              )}`,
            },
            {
              primary: "Task timing",
              secondary: `${formatReportMetric(
                typingDiagnostics.guidedDurationMs,
                "ms"
              )} guided and ${formatReportMetric(
                typingDiagnostics.freeTypingDurationMs,
                "ms"
              )} free typing`,
            },
          ]
        : [],
      (item) => item
    );
    appendReportList(
      elements.actionResult,
      "Slowest guided words",
      Array.isArray(slowWords.guided) ? slowWords.guided : [],
      (word) => ({
        primary: word.label || `Guided word ${word.index}`,
        secondary: `${formatReportMetric(
          word.durationMs,
          "ms"
        )} across ${Number(word.characterCount) || 0} characters`,
      })
    );
    appendReportList(
      elements.actionResult,
      "Slowest free-typing positions",
      Array.isArray(slowWords.freeTyping) ? slowWords.freeTyping : [],
      (word) => ({
        primary: word.label || `Free word ${word.index}`,
        secondary: `${formatReportMetric(
          word.durationMs,
          "ms"
        )} across ${Number(word.characterCount) || 0} characters, content not stored`,
      })
    );
    appendReportList(
      elements.actionResult,
      "Current signal versus baseline",
      baselineComparison,
      (signal) => ({
        primary: signal.label || signal.key,
        secondary: `${formatReportMetric(
          signal.current,
          signal.unit,
          signal.unit === "ratio" ? 2 : 1
        )} now, ${formatReportMetric(
          signal.baseline,
          signal.unit,
          signal.unit === "ratio" ? 2 : 1
        )} baseline, difference ${formatReportMetric(
          signal.difference,
          signal.unit,
          signal.unit === "ratio" ? 2 : 1
        )}`,
      })
    );
    appendReportList(
      elements.actionResult,
      "Pointer pattern",
      behaviorDiagnostics
        ? [
            {
              primary: "Velocity",
              secondary: `${formatReportMetric(
                pointerDiagnostics.averageVelocityPxPerSecond,
                "px/s"
              )} average with ${formatReportMetric(
                pointerDiagnostics.velocityVariation,
                "px/s"
              )} variation`,
            },
            {
              primary: "Acceleration",
              secondary: `${formatReportMetric(
                pointerDiagnostics.averageAcceleration,
                "px/s²"
              )} average with ${formatReportMetric(
                pointerDiagnostics.accelerationVariation,
                "px/s²"
              )} variation`,
            },
            {
              primary: "Direction change",
              secondary: `${formatReportMetric(
                pointerDiagnostics.averageDirectionChange,
                "ratio",
                2
              )} average with ${formatReportMetric(
                pointerDiagnostics.directionChangeVariation,
                "ratio",
                2
              )} variation`,
            },
          ]
        : [],
      (item) => item
    );
    appendReportList(
      elements.actionResult,
      "Network observation",
      network.currentIpAddress
        ? [
            {
              primary: `Current IP ${network.currentIpAddress}`,
              secondary: network.source || "Observed by the Odysseus server",
            },
            {
              primary: network.sameAsLatestVerification
                ? "Matches latest verification IP"
                : "Differs from latest verification IP",
              secondary:
                network.latestVerificationIpAddress ||
                "No verification IP was available",
            },
          ]
        : [],
      (item) => item
    );
    appendReportList(
      elements.actionResult,
      "Controls evaluated",
      controls,
      (control) => ({
        primary: control.name || "Unnamed control",
        secondary: `${control.status || "Unknown"}${
          control.detail ? `: ${control.detail}` : ""
        }`,
      })
    );
    appendReportList(
      elements.actionResult,
      "Enrolled profiles",
      profiles,
      (profile) => ({
        primary: profile.profileId || "Unnamed profile",
        secondary: `${profile.maturity || "Baseline"}, ${
          Number(profile.sampleCount) || 0
        } samples, ${
          Number(profile.featureCount) || 0
        } features, updated ${formatReportDate(profile.updatedAt)}`,
      })
    );
    appendReportList(
      elements.actionResult,
      "Data boundary",
      [
        {
          primary: "Browser processing",
          secondary: privacy.browserProcessing,
        },
        {
          primary: "Submitted to server",
          secondary: privacy.transmitted,
        },
        {
          primary: "Stored by Odysseus",
          secondary: privacy.stored,
        },
      ].filter((item) => item.secondary),
      (item) => item
    );
    appendReportList(
      elements.actionResult,
      "Gemini-ready analysis boundary",
      geminiReadiness.status
        ? [
            {
              primary: geminiReadiness.status,
              secondary:
                geminiReadiness.intendedUse ||
                "Structured explanation context is available",
            },
            {
              primary: "Authorization remains deterministic",
              secondary:
                geminiReadiness.authorizationBoundary ||
                "An AI explanation cannot grant access",
            },
          ]
        : [],
      (item) => item
    );
    appendReportNotes(
      elements.actionResult,
      "Signals available to a future Gemini layer",
      Array.isArray(geminiReadiness.availableSignals)
        ? geminiReadiness.availableSignals
        : [],
      "positive"
    );
    appendReportNotes(
      elements.actionResult,
      "Context excluded from Gemini",
      Array.isArray(geminiReadiness.excludedContext)
        ? geminiReadiness.excludedContext
        : [],
      "caution"
    );
    appendReportNotes(
      elements.actionResult,
      "Explicitly excluded",
      Array.isArray(privacy.excluded) ? privacy.excluded : [],
      "positive"
    );
    appendReportList(
      elements.actionResult,
      "Recent account activity",
      recentActivity.slice(0, 8),
      (event) => ({
        primary: readableReportLabel(event.eventType),
        secondary: `${readableReportLabel(event.outcome)}${
          event.detail ? `, ${event.detail}` : ""
        }${
          event.reasonCode
            ? `, ${readableReportLabel(event.reasonCode)}`
            : ""
        }${
          event.ipAddress ? `, IP ${event.ipAddress}` : ""
        }, ${formatReportDate(event.createdAt)}`,
      })
    );
    appendReportList(
      elements.actionResult,
      "Current registered device",
      device
        ? [
            {
              primary: device.label || "Current device",
              secondary: [
                device.descriptor?.kind,
                device.descriptor?.platform,
                device.descriptor?.browserBrands,
                device.current ? "current device" : null,
              ].filter(Boolean).join(", "),
            },
          ]
        : [],
      (item) => item
    );
    appendReportList(
      elements.actionResult,
      "Session protection state",
      [
        {
          primary: "Behavior grant",
          secondary: session.behaviorGrantActive ? "active" : "inactive",
        },
        {
          primary: "Password step-up",
          secondary: session.stepUpActive ? "active" : "inactive",
        },
        {
          primary: "Device binding",
          secondary: session.deviceBound ? "present" : "not present",
        },
      ],
      (item) => item
    );
    appendReportList(
      elements.actionResult,
      "Browser display indicators",
      localSession
        ? [
            {
              primary: "Layout viewport",
              secondary: `${localSession.display.layoutViewport.widthPx ?? "Unavailable"} x ${localSession.display.layoutViewport.heightPx ?? "Unavailable"} px`,
            },
            {
              primary: "Visual viewport",
              secondary: `${localSession.display.visualViewport.widthPx ?? "Unavailable"} x ${localSession.display.visualViewport.heightPx ?? "Unavailable"} px at scale ${localSession.display.visualViewport.scale ?? "Unavailable"}`,
            },
            {
              primary: "Display scale indicators",
              secondary: `Device pixel ratio ${localSession.display.scaleIndicators.devicePixelRatio ?? "Unavailable"}. ${localSession.display.scaleIndicators.note}`,
            },
            {
              primary: "Screen",
              secondary: `${localSession.display.screen.widthPx ?? "Unavailable"} x ${localSession.display.screen.heightPx ?? "Unavailable"} px`,
            },
          ]
        : [],
      (item) => item
    );
    appendReportList(
      elements.actionResult,
      "Browser page activity",
      localSession
        ? [
            {
              primary: "Time on this page",
              secondary: formatReportMetric(
                localSession.pageSession.elapsedMs,
                "ms"
              ),
            },
            {
              primary: "Focus changes",
              secondary: `${localSession.pageSession.focusLosses} losses and ${localSession.pageSession.focusReturns} returns`,
            },
            {
              primary: "Window changes",
              secondary: `${localSession.pageSession.resizeEvents} resizes, ${localSession.pageSession.orientationChanges} orientation changes, and ${localSession.pageSession.visibilityChanges} visibility changes`,
            },
          ]
        : [],
      (item) => item
    );
    appendReportList(
      elements.actionResult,
      "Whole-session keyboard activity",
      localSession?.interaction
        ? [
            {
              primary: "Keyboard and input events",
              secondary: `${localSession.interaction.keyboard.keyDownEvents} key-down events, ${localSession.interaction.keyboard.keyUpEvents} key-up events, and ${localSession.interaction.keyboard.inputEvents} input changes`,
            },
            {
              primary: "Corrections and fixes",
              secondary: `${localSession.interaction.keyboard.correctionEvents} correction patterns, ${localSession.interaction.keyboard.deletionEvents} deletions, ${localSession.interaction.keyboard.undoEvents} undo actions, and ${localSession.interaction.keyboard.repeatedKeyEvents} repeated-key events`,
            },
            {
              primary: "Delay pattern",
              secondary: `${localSession.interaction.delays.sampleCount} intervals averaging ${formatReportMetric(
                localSession.interaction.delays.averageMs,
                "ms"
              )}, with ${formatReportMetric(
                localSession.interaction.delays.deviationMs,
                "ms"
              )} variation and ${formatReportMetric(
                localSession.interaction.delays.longestMs,
                "ms"
              )} longest`,
            },
          ]
        : [],
      (item) => item
    );
    appendReportList(
      elements.actionResult,
      "Whole-session pointer and scrolling",
      localSession?.interaction
        ? [
            {
              primary: "Pointer movement",
              secondary: `${localSession.interaction.pointer.moveEvents} movement events across about ${localSession.interaction.pointer.distancePx} px, summarized without coordinates`,
            },
            {
              primary: "Pointer actions",
              secondary: `${localSession.interaction.pointer.clickEvents} clicks, ${localSession.interaction.pointer.doubleClickEvents} double-clicks, ${localSession.interaction.pointer.pointerDownEvents} presses, and ${localSession.interaction.pointer.contextMenuEvents} context-menu actions`,
            },
            {
              primary: "Scrolling",
              secondary: `${localSession.interaction.scrolling.scrollEvents} scroll events and ${localSession.interaction.scrolling.wheelEvents} wheel events across about ${localSession.interaction.scrolling.distancePx} px`,
            },
          ]
        : [],
      (item) => item
    );
    appendReportList(
      elements.actionResult,
      "Scale and zoom indicators",
      localSession?.zoom
        ? [
            {
              primary: "Observed scale changes",
              secondary: `${localSession.zoom.changeEvents} changes, visual scale ${localSession.zoom.visualScaleMinimum ?? "Unavailable"} to ${localSession.zoom.visualScaleMaximum ?? "Unavailable"}`,
            },
            {
              primary: "Device-pixel-ratio range",
              secondary: `${localSession.zoom.devicePixelRatioMinimum ?? "Unavailable"} to ${localSession.zoom.devicePixelRatioMaximum ?? "Unavailable"}. ${localSession.zoom.interpretation}`,
            },
          ]
        : [],
      (item) => item
    );
    appendReportList(
      elements.actionResult,
      "Time by screen",
      Array.isArray(localSession?.interaction?.viewTiming)
        ? localSession.interaction.viewTiming
        : [],
      (entry) => ({
        primary: readableReportLabel(entry.view),
        secondary: formatReportMetric(entry.durationMs, "ms"),
      })
    );
    appendReportList(
      elements.actionResult,
      "Latest account-linked interaction summary",
      auditedSession
        ? [
            {
              primary: "Stored verification window",
              secondary: `${formatReportMetric(
                auditedSession.elapsedMs,
                "ms"
              )}, ${auditedSession.keyboard?.keyDownEvents || 0} key-down events, ${auditedSession.keyboard?.correctionEvents || 0} corrections`,
            },
            {
              primary: "Stored pointer and zoom totals",
              secondary: `${auditedSession.pointer?.moveEvents || 0} pointer movements, ${auditedSession.pointer?.clickEvents || 0} clicks, and ${auditedSession.zoom?.changeEvents || 0} scale changes`,
            },
          ]
        : [],
      (item) => item
    );
    appendReportNotes(
      elements.actionResult,
      "Browser-only detail boundary",
      localSession
        ? [
            localSession.privacy.location,
            localSession.privacy.excluded,
          ]
        : [],
      "positive"
    );
    appendReportNotes(
      elements.actionResult,
      "Recommended next steps",
      recommendations,
      "positive"
    );
    appendReportNotes(
      elements.actionResult,
      "Model limitations",
      limitations,
      "caution"
    );
  }

  async function performSensitiveAction() {
    if (!requireAuth(elements.actionStatus) || actionInFlight) {
      return;
    }

    actionInFlight = true;
    setWorkspaceControls();
    elements.actionStatus.hidden = false;
    setInlineStatus(
      elements.actionStatus,
      "Preparing the authenticated technical report.",
      "working"
    );

    try {
      const result = await request("/api/actions/secure-record", {
        method: "POST",
        body: JSON.stringify({}),
      });
      elements.stepUpWarning.hidden = true;
      elements.stepUpField.value = "";
      renderSecurityReport(result);
      global.document.dispatchEvent(
        new CustomEvent("odysseus:sensitive-action", {
          detail: { profileId: profileId(), trustScore, result },
        })
      );
    } catch (error) {
      if (
        error.status === 401 &&
        String(error.code).toUpperCase() === "AUTHENTICATION_REQUIRED"
      ) {
        showSignedOut("Your session ended. Sign in again.", "error");
        elements.authUsername.focus();
      } else if (requiresStepUp(error)) {
        showStepUp(
          error.message || "The server requires step-up verification.",
          true
        );
        setInlineStatus(
          elements.actionStatus,
          "Access paused until the server confirms your password.",
          "error"
        );
      } else {
        setInlineStatus(elements.actionStatus, error.message, "error");
      }
    } finally {
      actionInFlight = false;
      setWorkspaceControls();
    }
  }

  async function submitStepUp() {
    if (!requireAuth(elements.stepUpStatus)) {
      return;
    }
    const credential = elements.stepUpField.value;
    if (credential.length < 6) {
      setInlineStatus(
        elements.stepUpStatus,
        "Enter your account password to continue.",
        "error"
      );
      elements.stepUpField.focus();
      return;
    }

    elements.stepUpSubmit.disabled = true;
    setInlineStatus(
      elements.stepUpStatus,
      "Confirming your identity with the server.",
      "working"
    );
    const payload = JSON.stringify({ password: credential });
    elements.stepUpField.value = "";

    try {
      const result = await request("/api/auth/step-up", {
        method: "POST",
        body: payload,
      });
      setInlineStatus(
        elements.stepUpStatus,
        (result && result.message) ||
          "Identity confirmed. Retrying the protected action.",
        "ready"
      );
      await performSensitiveAction();
    } catch (error) {
      if (
        error.status === 401 &&
        String(error.code).toUpperCase() === "AUTHENTICATION_REQUIRED"
      ) {
        showSignedOut("Your session ended. Sign in again.", "error");
        elements.authUsername.focus();
      } else {
        showStepUp(error.message, false);
        elements.stepUpField.focus();
      }
    } finally {
      elements.stepUpSubmit.disabled = false;
    }
  }

  async function checkApi() {
    try {
      await request("/api/health", { method: "GET" });
      elements.apiStatus.classList.add("is-online");
      elements.apiStatus.classList.remove("is-offline");
      setText(elements.apiStatus, "Engine online");
    } catch (_error) {
      elements.apiStatus.classList.add("is-offline");
      elements.apiStatus.classList.remove("is-online");
      setText(elements.apiStatus, "Engine unavailable");
    }
  }

  function initializeAccountFeatures() {
    if (!global.OdysseusDevice || !global.OdysseusAccount) {
      global.console.error(
        "Odysseus device or account security module could not be loaded."
      );
      return;
    }
    global.OdysseusAccount.init({
      request,
      device: global.OdysseusDevice,
      getCurrentUser() {
        return currentUser;
      },
      getProfileId: profileId,
      getTrustScore() {
        return Math.round(trustScore * 100);
      },
      getLoginUsername() {
        return elements.authUsername.value.trim();
      },
      async onSessionChanged() {
        await hydrateAuth();
      },
      async onAccountDeleted() {
        showSignedOut(
          "Account deletion confirmed by the server. Local controls are locked.",
          "ready"
        );
        try {
          await ensureCsrfToken();
        } catch (_error) {
          setInlineStatus(
            elements.authStatus,
            "Account deleted. Refresh before creating a new account.",
            "neutral"
          );
        }
        elements.authUsername.focus();
      },
    });
  }

  function bindElements() {
    Object.keys(ids).forEach((name) => {
      elements[name] = global.document.getElementById(ids[name]);
    });
    return Object.keys(ids)
      .filter((name) => !elements[name])
      .map((name) => ids[name]);
  }

  function init() {
    if (
      !global.OdysseusChallenge ||
      !global.OdysseusDiagnostics ||
      !global.OdysseusDevice ||
      !global.OdysseusSession ||
      !global.OdysseusAccount
    ) {
      global.console.error(
        "An Odysseus browser module could not be loaded."
      );
      return;
    }
    const missing = bindElements();
    if (missing.length) {
      global.console.error(
        `Odysseus UI is missing required elements: ${missing.join(", ")}`
      );
      return;
    }

    typingDiagnostics = {
      enrollment: global.OdysseusDiagnostics.createTypingDiagnostic(),
      verification: global.OdysseusDiagnostics.createTypingDiagnostic(),
    };
    authDiagnostics = global.OdysseusDiagnostics.createTypingDiagnostic();
    authCollector = global.OdysseusTelemetry.createCollector({
      keyboardTarget: global.document,
      pointerTarget: elements.authPanel,
      minimumDwellSamples: 10,
      minimumFlightSamples: 8,
      minimumDownDownSamples: 8,
      minimumPointerSamples: 0,
      shouldCaptureKeyboard(event) {
        return (
          event.target === elements.authUsername ||
          event.target === elements.authPassword
        );
      },
    });
    collector = global.OdysseusTelemetry.createCollector({
      keyboardTarget: global.document,
      pointerTarget: global.document,
      minimumPointerSamples: 0,
      shouldCaptureKeyboard(event) {
        return (
          event.target === elements.enrollmentInput ||
          event.target === elements.enrollmentFreeInput ||
          event.target === elements.verificationInput ||
          event.target === elements.verificationFreeInput
        );
      },
    });
    authCollector.start();
    collector.start();
    sessionObserver = global.OdysseusSession.createObserver(global);
    setAppView("login", "login");

    elements.enrollmentForm.addEventListener("submit", (event) => {
      event.preventDefault();
      showSampleReadiness("enrollment");
    });
    elements.authForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitAuth();
    });
    elements.authUsername.addEventListener("input", (event) => {
      recordAuthInput("guided", event);
    });
    elements.authPassword.addEventListener("input", (event) => {
      recordAuthInput("free", event);
    });
    elements.authMode.addEventListener("change", updateAuthMode);
    elements.behaviorWarningRetry.addEventListener(
      "click",
      closeBehaviorWarning
    );
    elements.logoutButton.addEventListener("click", logout);
    global.document
      .querySelectorAll("[data-app-view-target]")
      .forEach((control) => {
        control.addEventListener("click", () => {
          navigateAppView(control.dataset.appViewTarget);
        });
      });
    elements.dashboardTheme.addEventListener("click", () => {
      const light = global.document.body.classList.toggle(
        "dashboard-light-theme"
      );
      elements.dashboardTheme.setAttribute("aria-pressed", String(light));
      setText(
        elements.dashboardTheme,
        light ? "Use dark theme" : "Use light theme"
      );
    });
    elements.verificationForm.addEventListener("submit", (event) => {
      event.preventDefault();
      showSampleReadiness("verification");
    });
    elements.stepUpForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitStepUp();
    });
    elements.resetProfile.addEventListener("click", resetProfile);
    elements.resetVerification.addEventListener("click", resetVerification);
    elements.sensitiveAction.addEventListener("click", performSensitiveAction);
    elements.enrollmentInput.addEventListener("input", (event) => {
      if (
        !recordChallengeInput(
          "enrollment",
          "guided",
          elements.enrollmentInput,
          event
        )
      ) {
        return;
      }
      if (challengeTextResult("enrollment").accepted) {
        global.setTimeout(() => {
          if (
            global.document.activeElement === elements.enrollmentInput &&
            !elements.enrollmentFreeInput.disabled
          ) {
            elements.enrollmentFreeInput.focus();
          }
        }, 120);
      }
    });
    elements.enrollmentFreeInput.addEventListener("input", (event) => {
      recordChallengeInput(
        "enrollment",
        "free",
        elements.enrollmentFreeInput,
        event
      );
    });
    elements.verificationInput.addEventListener("input", (event) => {
      if (
        !recordChallengeInput(
          "verification",
          "guided",
          elements.verificationInput,
          event
        )
      ) {
        return;
      }
      if (challengeTextResult("verification").accepted) {
        global.setTimeout(() => {
          if (
            global.document.activeElement === elements.verificationInput &&
            !elements.verificationFreeInput.disabled
          ) {
            elements.verificationFreeInput.focus();
          }
        }, 120);
      }
    });
    elements.verificationFreeInput.addEventListener("input", (event) => {
      recordChallengeInput(
        "verification",
        "free",
        elements.verificationFreeInput,
        event
      );
    });
    elements.enrollmentBoard.addEventListener("click", (event) => {
      handleChallengeTarget("enrollment", event);
    });
    elements.verificationBoard.addEventListener("click", (event) => {
      handleChallengeTarget("verification", event);
    });
    elements.profileId.addEventListener("change", async () => {
      await hydrateProfile();
      if (global.OdysseusAccount) {
        global.OdysseusAccount.refresh();
      }
    });

    resetLocalState();
    updateAuthMode();
    initializeAccountFeatures();
    ensureCsrfToken()
      .catch(() => null)
      .then(checkApi)
      .then(hydrateAuth);

    intervalId = global.setInterval(() => {
      const readiness = collector.readiness();
      const inputIsActive =
        global.document.activeElement === elements.verificationInput ||
        global.document.activeElement === elements.verificationFreeInput;
      if (
         isAuthenticated() &&
         enrolled &&
         challengeTasksComplete("verification") &&
         readiness.ready &&
        !inputIsActive
      ) {
        verify("continuous");
      }
    }, VERIFICATION_INTERVAL_MS);
  }

  function destroy() {
    cancelAutoSubmit("enrollment");
    cancelAutoSubmit("verification");
    if (intervalId !== null) {
      global.clearInterval(intervalId);
      intervalId = null;
    }
    if (collector) {
      collector.destroy();
    }
    if (authCollector) {
      authCollector.destroy();
      authCollector = null;
    }
    authDiagnostics = null;
    if (sessionObserver) {
      sessionObserver.destroy();
      sessionObserver = null;
    }
    if (global.OdysseusAccount) {
      global.OdysseusAccount.destroy();
    }
  }

  function loadTelemetry() {
    if (global.OdysseusTelemetry) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const script = global.document.createElement("script");
      script.src = "/telemetry.js";
      script.onload = resolve;
      script.onerror = () =>
        reject(new Error("The browser telemetry module could not be loaded."));
      global.document.head.appendChild(script);
    });
  }

  function startWhenReady() {
    const domReady =
      global.document.readyState === "loading"
        ? new Promise((resolve) => {
            global.document.addEventListener("DOMContentLoaded", resolve, {
              once: true,
            });
          })
        : Promise.resolve();

    Promise.all([domReady, loadTelemetry()])
      .then(init)
      .catch((error) => global.console.error(error));
  }

  global.OdysseusApp = Object.freeze({
    init,
    destroy,
    verify: () => verify("explicit"),
    resetProfile,
    ids,
  });

  if (global.document) {
    startWhenReady();
    global.addEventListener("pagehide", destroy, { once: true });
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
