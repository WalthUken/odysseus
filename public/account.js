(function (global) {
  "use strict";

  const ENDPOINTS = Object.freeze({
    devices: "/api/devices",
    registerDevice: "/api/devices",
    revokeDevice(deviceId) {
      return `/api/devices/${encodeURIComponent(deviceId)}`;
    },
    passkeyRegisterOptions: "/api/auth/passkeys/register/options",
    passkeyRegisterVerify: "/api/auth/passkeys/register/verify",
    passkeyLoginOptions: "/api/auth/passkeys/login/options",
    passkeyLoginVerify: "/api/auth/passkeys/login/verify",
    turnstileConfig: "/api/security/turnstile",
    recoveryCodes: "/api/account/recovery-codes",
    recoveryStart: "/api/auth/recovery/start",
    recoveryReset: "/api/auth/recovery/reset",
    deleteAccount: "/api/account",
    notifications: "/api/notifications",
    markNotificationRead(notificationId) {
      return `/api/notifications/${encodeURIComponent(notificationId)}/read`;
    },
    adminSummary: "/api/admin/summary",
    explanation: "/api/explanations",
    securitySummary: "/api/security/summary",
  });

  const ids = Object.freeze({
    securityCenter: "security-center",
    securityUser: "security-user",
    deviceSummary: "current-device-summary",
    deviceKind: "device-kind",
    devicePlatform: "device-platform",
    deviceBrowser: "device-browser",
    deviceModel: "device-model",
    deviceScreen: "device-screen",
    deviceFingerprint: "device-fingerprint-status",
    deviceStatus: "device-status",
    registerDevice: "register-device",
    refreshDevices: "refresh-devices",
    deviceList: "device-list",
    passkeyLogin: "passkey-login",
    passkeyLoginStatus: "passkey-login-status",
    passkeyRegister: "passkey-register",
    passkeyStatus: "passkey-status",
    turnstileContainer: "turnstile-container",
    turnstileStatus: "turnstile-status",
    recoveryPanel: "account-recovery-panel",
    recoveryStartForm: "recovery-start-form",
    recoveryUsername: "recovery-username",
    recoveryStartSubmit: "recovery-start-submit",
    recoveryStartStatus: "recovery-start-status",
    recoveryResetForm: "recovery-reset-form",
    recoveryResetUsername: "recovery-reset-username",
    recoveryCode: "recovery-code",
    recoveryPassword:
      "recovery-password",
    recoveryResetSubmit: "recovery-reset-submit",
    recoveryResetStatus: "recovery-reset-status",
    generateRecoveryCodes: "generate-recovery-codes",
    downloadRecoveryCodes: "download-recovery-codes",
    clearRecoveryCodes: "clear-recovery-codes",
    recoveryCodes: "recovery-codes",
    recoveryCodesStatus: "recovery-codes-status",
    notificationRefresh: "notification-refresh",
    notificationCount: "notification-count",
    notificationList: "notification-list",
    notificationStatus: "notification-status",
    calibrationValue: "calibration-value",
    driftValue: "drift-value",
    deviceConfidenceValue: "device-confidence-value",
    confidenceStatus: "confidence-status",
    explanationRequest: "explanation-request",
    explanationText: "explanation-text",
    explanationStatus: "explanation-status",
    deleteForm: "delete-account-form",
    deleteConfirmation: "delete-account-confirmation",
    deleteAcknowledgement: "delete-account-acknowledgement",
    deleteSubmit: "delete-account-submit",
    deleteStatus: "delete-account-status",
    adminPanel: "admin-dashboard",
    adminStatus: "admin-status",
    adminUsers: "admin-users",
    adminSessions: "admin-sessions",
    adminAlerts: "admin-alerts",
  });

  const elements = {};
  const state = {
    config: null,
    user: null,
    descriptor: null,
    recoveryCodes: [],
    turnstileToken: "",
    turnstileWidgetId: null,
    initialized: false,
    destroyed: false,
    localNotifications: [],
    automaticDeviceAttemptedForUser: null,
  };

  function setText(element, value) {
    if (element) {
      element.textContent =
        value === null || value === undefined ? "" : String(value);
    }
  }

  function setStatus(element, message, status) {
    setText(element, message);
    if (element) {
      element.dataset.state = status || "neutral";
    }
  }

  function bindElements() {
    Object.entries(ids).forEach(([name, id]) => {
      elements[name] = global.document.getElementById(id);
    });
    return Object.entries(ids)
      .filter(([, id]) => !global.document.getElementById(id))
      .map(([, id]) => id);
  }

  function authenticated() {
    return Boolean(state.user);
  }

  function request(path, options) {
    if (!state.config || typeof state.config.request !== "function") {
      return Promise.reject(
        new Error("Odysseus account API client is not configured.")
      );
    }
    return state.config.request(path, options || {});
  }

  function optionalError(error) {
    return [404, 405, 501].includes(Number(error && error.status));
  }

  function errorMessage(error, fallback) {
    return error && error.message ? error.message : fallback;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? date.toLocaleString()
      : "Time unavailable";
  }

  function formatPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "Unavailable";
    const percent = numeric <= 1 ? numeric * 100 : numeric;
    return `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  }

  function firstValue(source, names) {
    for (const name of names) {
      if (source && source[name] !== undefined && source[name] !== null) {
        return source[name];
      }
    }
    return null;
  }

  function normalizeDevices(result) {
    const devices =
      result && Array.isArray(result.devices)
        ? result.devices
        : Array.isArray(result)
          ? result
          : [];
    return devices.map((device, index) => ({
      id: String(device.id || device.deviceId || `device-${index + 1}`),
      name: String(
        device.name ||
          device.label ||
          device.descriptorLabel ||
          "Recognized device"
      ),
      current: Boolean(device.current || device.isCurrent),
      trusted: Boolean(device.trusted || device.status === "trusted"),
      lastSeenAt: device.lastSeenAt || device.lastSeen || device.updatedAt,
      confidence: firstValue(device, [
        "confidence",
        "deviceConfidence",
        "confidenceScore",
      ]),
    }));
  }

  function normalizeNotifications(result) {
    const remote =
      result && Array.isArray(result.notifications)
        ? result.notifications
        : Array.isArray(result)
          ? result
          : [];
    return [
      ...state.localNotifications,
      ...remote.map((notification, index) => ({
        id: String(
          notification.id || notification.notificationId || `notice-${index}`
        ),
        title: String(notification.title || "Account update"),
        message: String(
          notification.message || notification.body || "No details provided."
        ),
        createdAt:
          notification.createdAt ||
          notification.timestamp ||
          new Date().toISOString(),
        read: Boolean(notification.read || notification.readAt),
        local: false,
      })),
    ];
  }

  function createElement(tag, className, value) {
    const node = global.document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }

  function clearChildren(element) {
    if (element) {
      element.replaceChildren();
    }
  }

  function renderDescriptor() {
    const descriptor = state.descriptor;
    if (!descriptor) {
      setText(elements.deviceSummary, "Collecting coarse device signals.");
      return;
    }
    setText(
      elements.deviceSummary,
      state.config.device.descriptorLabel(descriptor)
    );
    setText(elements.deviceKind, descriptor.kind);
    setText(
      elements.devicePlatform,
      [descriptor.platform, descriptor.platformVersion]
        .filter((value) => value && value !== "Unavailable")
        .join(" ") || "Unavailable"
    );
    setText(elements.deviceBrowser, descriptor.browserBrands);
    setText(elements.deviceModel, descriptor.model);
    setText(elements.deviceScreen, descriptor.screenClass);
  }

  async function initializeDescriptor() {
    try {
      state.descriptor = await state.config.device.describe(global);
      renderDescriptor();
      await state.config.device.loadLocalFingerprintAdapter();
      const fingerprint = await state.config.device.fingerprint();
      setStatus(
        elements.deviceFingerprint,
        fingerprint.available
          ? `Optional adapter available, confidence ${formatPercent(
              fingerprint.confidence
            )}.`
          : fingerprint.reason,
        fingerprint.available ? "ready" : "neutral"
      );
    } catch (error) {
      setStatus(
        elements.deviceStatus,
        `Device description unavailable: ${error.message}`,
        "error"
      );
    }
  }

  function renderDevices(devices) {
    clearChildren(elements.deviceList);
    if (!devices.length) {
      const empty = createElement(
        "li",
        "empty-state",
        "No managed devices were returned by the API."
      );
      elements.deviceList.appendChild(empty);
      return;
    }
    devices.forEach((device) => {
      const item = createElement("li", "managed-device");
      const copy = createElement("div", "managed-device-copy");
      const title = createElement("strong", "", device.name);
      const detail = createElement(
        "span",
        "",
        [
          device.current ? "Current session" : "Other session",
          device.trusted ? "Trusted" : "Unverified",
          device.lastSeenAt
            ? `Last seen ${formatDate(device.lastSeenAt)}`
            : "Last seen unavailable",
          device.confidence === null
            ? null
            : `Confidence ${formatPercent(device.confidence)}`,
        ]
          .filter(Boolean)
          .join(" | ")
      );
      copy.append(title, detail);
      item.appendChild(copy);
      if (!device.current) {
        const button = createElement("button", "button button-quiet", "Revoke");
        button.type = "button";
        button.dataset.revokeDevice = device.id;
        button.setAttribute("aria-label", `Revoke ${device.name}`);
        item.appendChild(button);
      }
      elements.deviceList.appendChild(item);
    });
  }

  async function refreshDevices() {
    if (!authenticated()) return;
    elements.refreshDevices.disabled = true;
    setStatus(elements.deviceStatus, "Loading managed devices.", "working");
    try {
      const result = await request(ENDPOINTS.devices, { method: "GET" });
      const devices = normalizeDevices(result);
      renderDevices(devices);
      setStatus(
        elements.deviceStatus,
        `${devices.length} managed ${
          devices.length === 1 ? "device" : "devices"
        } returned.`,
        "ready"
      );
      return devices;
    } catch (error) {
      renderDevices([]);
      setStatus(
        elements.deviceStatus,
        optionalError(error)
          ? "Device management is not enabled by this API."
          : errorMessage(error, "Managed devices could not be loaded."),
        optionalError(error) ? "neutral" : "error"
      );
      return null;
    } finally {
      elements.refreshDevices.disabled = false;
    }
  }

  async function registerCurrentDevice() {
    if (!authenticated()) return;
    elements.registerDevice.disabled = true;
    setStatus(
      elements.deviceStatus,
      "Registering this coarse device descriptor.",
      "working"
    );
    try {
      if (!state.descriptor) {
        await initializeDescriptor();
      }
      const fingerprint = await state.config.device.fingerprint();
      await request(ENDPOINTS.registerDevice, {
        method: "POST",
        body: JSON.stringify({
          label: state.config.device
            .descriptorLabel(state.descriptor)
            .slice(0, 80),
          descriptor: state.config.device.coarseDescriptor(
            state.descriptor,
            global
          ),
          clientFingerprint:
            fingerprint.available
            && /^[a-f0-9]{32}$/i.test(fingerprint.visitorId)
              ? fingerprint.visitorId
              : null,
        }),
      });
      pushNotification(
        "Device registered",
        "The API accepted this browser descriptor.",
        "ready"
      );
      await refreshDevices();
    } catch (error) {
      setStatus(
        elements.deviceStatus,
        optionalError(error)
          ? "Device registration is not enabled by this API."
          : errorMessage(error, "This device could not be registered."),
        optionalError(error) ? "neutral" : "error"
      );
    } finally {
      elements.registerDevice.disabled = false;
    }
  }

  async function revokeDevice(deviceId, button) {
    if (!authenticated() || !deviceId) return;
    button.disabled = true;
    try {
      await request(ENDPOINTS.revokeDevice(deviceId), {
        method: "DELETE",
        body: JSON.stringify({}),
      });
      pushNotification(
        "Device revoked",
        "The selected device was removed from this account.",
        "ready"
      );
      await refreshDevices();
    } catch (error) {
      setStatus(elements.deviceStatus, error.message, "error");
      button.disabled = false;
    }
  }

  function passkeyUnavailableMessage() {
    return "Passkeys require WebAuthn support and a compatible secure browser context.";
  }

  async function registerPasskey() {
    if (!authenticated()) return;
    if (!state.config.device.supportsPasskeys(global.navigator)) {
      setStatus(elements.passkeyStatus, passkeyUnavailableMessage(), "error");
      return;
    }
    elements.passkeyRegister.disabled = true;
    setStatus(
      elements.passkeyStatus,
      "Requesting passkey registration options.",
      "working"
    );
    try {
      const options = await request(ENDPOINTS.passkeyRegisterOptions, {
        method: "POST",
        body: JSON.stringify({
          device: state.descriptor,
        }),
      });
      const credential = await state.config.device.createPasskey(options);
      await request(ENDPOINTS.passkeyRegisterVerify, {
        method: "POST",
        body: JSON.stringify({ credential }),
      });
      setStatus(
        elements.passkeyStatus,
        "Passkey registered for this account.",
        "ready"
      );
      pushNotification(
        "Passkey added",
        "A new WebAuthn credential was registered.",
        "ready"
      );
    } catch (error) {
      setStatus(
        elements.passkeyStatus,
        optionalError(error)
          ? "Passkey registration is not enabled by this API."
          : errorMessage(error, "Passkey registration was cancelled."),
        optionalError(error) ? "neutral" : "error"
      );
    } finally {
      elements.passkeyRegister.disabled = false;
    }
  }

  async function loginWithPasskey() {
    if (!state.config.device.supportsPasskeys(global.navigator)) {
      setStatus(
        elements.passkeyLoginStatus,
        passkeyUnavailableMessage(),
        "error"
      );
      return;
    }
    elements.passkeyLogin.disabled = true;
    setStatus(
      elements.passkeyLoginStatus,
      "Requesting a passkey challenge.",
      "working"
    );
    try {
      const username =
        typeof state.config.getLoginUsername === "function"
          ? state.config.getLoginUsername()
          : "";
      const options = await request(ENDPOINTS.passkeyLoginOptions, {
        method: "POST",
        body: JSON.stringify({ username: username || undefined }),
      });
      const credential = await state.config.device.getPasskey(options);
      await request(ENDPOINTS.passkeyLoginVerify, {
        method: "POST",
        body: JSON.stringify({ credential }),
      });
      setStatus(
        elements.passkeyLoginStatus,
        "Passkey accepted. Restoring your session.",
        "ready"
      );
      if (typeof state.config.onSessionChanged === "function") {
        await state.config.onSessionChanged();
      }
    } catch (error) {
      setStatus(
        elements.passkeyLoginStatus,
        optionalError(error)
          ? "Passkey login is not enabled by this API."
          : errorMessage(error, "Passkey login was cancelled."),
        optionalError(error) ? "neutral" : "error"
      );
    } finally {
      elements.passkeyLogin.disabled = false;
    }
  }

  function resetTurnstile() {
    state.turnstileToken = "";
    if (
      state.turnstileWidgetId !== null &&
      global.turnstile &&
      typeof global.turnstile.reset === "function"
    ) {
      global.turnstile.reset(state.turnstileWidgetId);
    }
  }

  function renderTurnstile(siteKey, action) {
    elements.turnstileContainer.dataset.sitekey = siteKey;
    elements.turnstileContainer.hidden = false;
    global.document.dispatchEvent(
      new CustomEvent("odysseus:turnstile-config", {
        detail: {
          siteKey,
          container: elements.turnstileContainer,
        },
      })
    );
    if (
      global.turnstile &&
      typeof global.turnstile.render === "function"
    ) {
      state.turnstileWidgetId = global.turnstile.render(
        elements.turnstileContainer,
        {
          sitekey: siteKey,
          ...(action ? { action } : {}),
          callback(token) {
            state.turnstileToken = token;
            setStatus(
              elements.turnstileStatus,
              "Challenge completed.",
              "ready"
            );
          },
          "expired-callback"() {
            state.turnstileToken = "";
            setStatus(
              elements.turnstileStatus,
              "Challenge expired. Complete it again.",
              "error"
            );
          },
        }
      ) ?? null;
      setStatus(
        elements.turnstileStatus,
        "Complete the locally integrated challenge.",
        "neutral"
      );
      return;
    }
    setStatus(
      elements.turnstileStatus,
      "A site key was returned, but no locally served Turnstile adapter is loaded.",
      "neutral"
    );
  }

  async function loadTurnstileConfig() {
    try {
      const result = await request(ENDPOINTS.turnstileConfig, {
        method: "GET",
      });
      const siteKey = result && (result.siteKey || result.sitekey);
      if (typeof siteKey === "string" && siteKey.trim()) {
        renderTurnstile(
          siteKey.trim(),
          typeof result.action === "string"
            ? result.action.trim()
            : ""
        );
      }
    } catch (error) {
      if (!optionalError(error)) {
        setStatus(elements.turnstileStatus, error.message, "error");
      }
    }
  }

  async function startRecovery() {
    const username = elements.recoveryUsername.value.trim();
    if (!username) {
      setStatus(
        elements.recoveryStartStatus,
        "Enter the account username.",
        "error"
      );
      elements.recoveryUsername.focus();
      return;
    }
    elements.recoveryStartSubmit.disabled = true;
    try {
      const result = await request(ENDPOINTS.recoveryStart, {
        method: "POST",
        body: JSON.stringify({
          username,
          turnstileToken:
            state.turnstileToken || undefined,
        }),
      });
      setStatus(
        elements.recoveryStartStatus,
        (result && result.message) ||
          "If the account is eligible, recovery instructions are now available.",
        "ready"
      );
      resetTurnstile();
    } catch (error) {
      setStatus(
        elements.recoveryStartStatus,
        optionalError(error)
          ? "Account recovery is not enabled by this API."
          : errorMessage(error, "Recovery could not be started."),
        optionalError(error) ? "neutral" : "error"
      );
    } finally {
      elements.recoveryStartSubmit.disabled = false;
    }
  }

  async function completeRecovery() {
    const username = elements.recoveryResetUsername.value.trim();
    const code = elements.recoveryCode.value.trim();
    const password =
      elements.recoveryPassword.value;
    if (!username || !code || !password) {
      setStatus(
        elements.recoveryResetStatus,
        "Enter the username, recovery code, and new password.",
        "error"
      );
      return;
    }
    elements.recoveryResetSubmit.disabled = true;
    const payload = JSON.stringify({
      username,
      code,
      newPassword: password,
      turnstileToken:
        state.turnstileToken || undefined,
    });
    elements.recoveryPassword.value = "";
    try {
      const result = await request(ENDPOINTS.recoveryReset, {
        method: "POST",
        body: payload,
      });
      setStatus(
        elements.recoveryResetStatus,
        (result && result.message) ||
          "Password reset completed. Return to sign in.",
        "ready"
      );
      elements.recoveryCode.value = "";
      resetTurnstile();
    } catch (error) {
      setStatus(
        elements.recoveryResetStatus,
        optionalError(error)
          ? "Recovery-code reset is not enabled by this API."
          : errorMessage(error, "The account could not be reset."),
        optionalError(error) ? "neutral" : "error"
      );
    } finally {
      elements.recoveryResetSubmit.disabled = false;
    }
  }

  function renderRecoveryCodes() {
    clearChildren(elements.recoveryCodes);
    if (!state.recoveryCodes.length) {
      elements.recoveryCodes.hidden = true;
      elements.downloadRecoveryCodes.disabled = true;
      elements.clearRecoveryCodes.disabled = true;
      return;
    }
    state.recoveryCodes.forEach((code) => {
      elements.recoveryCodes.appendChild(
        createElement("li", "", code)
      );
    });
    elements.recoveryCodes.hidden = false;
    elements.downloadRecoveryCodes.disabled = false;
    elements.clearRecoveryCodes.disabled = false;
  }

  async function generateRecoveryCodes() {
    if (!authenticated()) return;
    elements.generateRecoveryCodes.disabled = true;
    try {
      const result = await request(ENDPOINTS.recoveryCodes, {
        method: "POST",
        body: JSON.stringify({ rotate: true }),
      });
      const codes =
        result && Array.isArray(result.codes)
          ? result.codes
          : result && Array.isArray(result.recoveryCodes)
            ? result.recoveryCodes
            : [];
      state.recoveryCodes = codes.map(String);
      renderRecoveryCodes();
      setStatus(
        elements.recoveryCodesStatus,
        codes.length
          ? "Save these one-time codes now. Odysseus will not keep them in this page after sign-out."
          : "The API returned no recovery codes.",
        codes.length ? "ready" : "error"
      );
    } catch (error) {
      setStatus(
        elements.recoveryCodesStatus,
        optionalError(error)
          ? "Recovery-code generation is not enabled by this API."
          : errorMessage(error, "Recovery codes could not be generated."),
        optionalError(error) ? "neutral" : "error"
      );
    } finally {
      elements.generateRecoveryCodes.disabled = false;
    }
  }

  function clearRecoveryCodes() {
    state.recoveryCodes = [];
    renderRecoveryCodes();
    setStatus(
      elements.recoveryCodesStatus,
      "Recovery codes cleared from this page.",
      "neutral"
    );
  }

  function downloadRecoveryCodes() {
    if (!state.recoveryCodes.length || !global.URL || !global.Blob) return;
    const content = [
      "Odysseus recovery codes",
      `Account: ${state.user ? state.user.username : "unknown"}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      ...state.recoveryCodes,
      "",
      "Each code should be used once.",
    ].join("\n");
    const url = global.URL.createObjectURL(
      new Blob([content], { type: "text/plain;charset=utf-8" })
    );
    const link = global.document.createElement("a");
    link.href = url;
    link.download = "odysseus-recovery-codes.txt";
    link.hidden = true;
    global.document.body.appendChild(link);
    link.click();
    link.remove();
    global.setTimeout(() => global.URL.revokeObjectURL(url), 0);
  }

  function renderNotifications(notifications) {
    clearChildren(elements.notificationList);
    const unread = notifications.filter((notification) => !notification.read);
    setText(elements.notificationCount, String(unread.length));
    elements.notificationCount.hidden = unread.length === 0;
    if (!notifications.length) {
      elements.notificationList.appendChild(
        createElement(
          "li",
          "empty-state",
          "No account notifications are available."
        )
      );
      return;
    }
    notifications.forEach((notification) => {
      const item = createElement(
        "li",
        notification.read ? "notification is-read" : "notification"
      );
      const copy = createElement("div", "notification-copy");
      copy.append(
        createElement("strong", "", notification.title),
        createElement("p", "", notification.message),
        createElement("time", "", formatDate(notification.createdAt))
      );
      item.appendChild(copy);
      if (!notification.read && !notification.local) {
        const button = createElement(
          "button",
          "button button-quiet",
          "Mark read"
        );
        button.type = "button";
        button.dataset.notificationRead = notification.id;
        item.appendChild(button);
      }
      elements.notificationList.appendChild(item);
    });
  }

  async function refreshNotifications() {
    if (!authenticated()) return;
    elements.notificationRefresh.disabled = true;
    setStatus(
      elements.notificationStatus,
      "Loading account notifications.",
      "working"
    );
    try {
      const result = await request(ENDPOINTS.notifications, {
        method: "GET",
      });
      const notifications = normalizeNotifications(result);
      renderNotifications(notifications);
      setStatus(
        elements.notificationStatus,
        `${notifications.length} ${
          notifications.length === 1 ? "notification" : "notifications"
        } available.`,
        "ready"
      );
    } catch (error) {
      const local = normalizeNotifications([]);
      renderNotifications(local);
      setStatus(
        elements.notificationStatus,
        optionalError(error)
          ? "Remote notifications are not enabled. Local security notices still appear here."
          : errorMessage(error, "Notifications could not be loaded."),
        optionalError(error) ? "neutral" : "error"
      );
    } finally {
      elements.notificationRefresh.disabled = false;
    }
  }

  async function markNotificationRead(notificationId, button) {
    button.disabled = true;
    try {
      await request(ENDPOINTS.markNotificationRead(notificationId), {
        method: "POST",
        body: JSON.stringify({}),
      });
      await refreshNotifications();
    } catch (error) {
      setStatus(elements.notificationStatus, error.message, "error");
      button.disabled = false;
    }
  }

  function pushNotification(title, message, status) {
    state.localNotifications.unshift({
      id: `local-${Date.now()}-${state.localNotifications.length}`,
      title: String(title || "Security update"),
      message: String(message || ""),
      createdAt: new Date().toISOString(),
      read: false,
      local: true,
      status: status || "neutral",
    });
    if (authenticated() && elements.notificationList) {
      renderNotifications(normalizeNotifications([]));
    }
  }

  async function refreshSecuritySummary() {
    if (!authenticated()) return;
    setStatus(
      elements.confidenceStatus,
      "Loading setup quality and session consistency.",
      "working"
    );
    try {
      const profileId =
        typeof state.config.getProfileId === "function"
          ? state.config.getProfileId()
          : "";
      const query = profileId
        ? `?profileId=${encodeURIComponent(profileId)}`
        : "";
      const result = await request(
        `${ENDPOINTS.securitySummary}${query}`,
        { method: "GET" }
      );
      setText(
        elements.calibrationValue,
        formatPercent(
          firstValue(result, [
            "calibration",
            "calibrationConfidence",
            "baselineQuality",
          ])
        )
      );
      setText(
        elements.driftValue,
        formatPercent(
          firstValue(result, [
            "drift",
            "driftScore",
            "behaviorDrift",
          ])
        )
      );
      setText(
        elements.deviceConfidenceValue,
        formatPercent(
          firstValue(result, [
            "deviceConfidence",
            "deviceScore",
            "confidence",
          ])
        )
      );
      setStatus(
        elements.confidenceStatus,
        (result && result.message) ||
          "Signals returned by the account security API.",
        "ready"
      );
    } catch (error) {
      setText(elements.calibrationValue, "Unavailable");
      setText(elements.driftValue, "Unavailable");
      setText(elements.deviceConfidenceValue, "Unavailable");
      setStatus(
        elements.confidenceStatus,
        optionalError(error)
          ? "Setup quality, session consistency, and device status are not exposed by this API."
          : errorMessage(error, "Confidence signals could not be loaded."),
        optionalError(error) ? "neutral" : "error"
      );
    }
  }

  async function requestExplanation() {
    if (!authenticated()) return;
    elements.explanationRequest.disabled = true;
    setStatus(
      elements.explanationStatus,
      "Requesting a plain-language explanation.",
      "working"
    );
    try {
      const result = await request(ENDPOINTS.explanation, {
        method: "POST",
        body: JSON.stringify({
          profileId:
            typeof state.config.getProfileId === "function"
              ? state.config.getProfileId()
              : undefined,
        }),
      });
      const explanation =
        result &&
        (result.explanation || result.summary || result.message);
      setText(
        elements.explanationText,
        explanation ||
          "The explanation service returned no narrative."
      );
      setStatus(
        elements.explanationStatus,
        "AI-generated explanation received. It is non-authoritative and may be incomplete.",
        "ready"
      );
    } catch (error) {
      setText(
        elements.explanationText,
        "No AI explanation is available. Use the measured signals and server policy result as the source of record."
      );
      setStatus(
        elements.explanationStatus,
        optionalError(error)
          ? "AI explanation is not enabled by this API."
          : errorMessage(error, "An explanation could not be generated."),
        optionalError(error) ? "neutral" : "error"
      );
    } finally {
      elements.explanationRequest.disabled = false;
    }
  }

  async function deleteAccount() {
    if (!authenticated()) return;
    const confirmation = elements.deleteConfirmation.value.trim();
    const acknowledged = elements.deleteAcknowledgement.checked;
    if (confirmation !== state.user.username || !acknowledged) {
      setStatus(
        elements.deleteStatus,
        `Type ${state.user.username} and acknowledge permanent deletion.`,
        "error"
      );
      return;
    }
    elements.deleteSubmit.disabled = true;
    try {
      await request(ENDPOINTS.deleteAccount, {
        method: "DELETE",
        body: JSON.stringify({
          confirmation,
          deleteAccount: true,
        }),
      });
      clearRecoveryCodes();
      pushNotification(
        "Account deleted",
        "The server confirmed account deletion.",
        "ready"
      );
      if (typeof state.config.onAccountDeleted === "function") {
        await state.config.onAccountDeleted();
      }
    } catch (error) {
      setStatus(
        elements.deleteStatus,
        optionalError(error)
          ? "Account deletion is not enabled by this API."
          : errorMessage(error, "The account was not deleted."),
        optionalError(error) ? "neutral" : "error"
      );
      elements.deleteSubmit.disabled = false;
    }
  }

  function renderAdminSummary(result) {
    const apiReportsAdmin = Boolean(
      result &&
      (result.isAdmin === true ||
        result.admin === true ||
        result.role === "admin" ||
        (result.user && result.user.isAdmin === true))
    );
    if (!apiReportsAdmin) {
      elements.adminPanel.hidden = true;
      return false;
    }
    elements.adminPanel.hidden = false;
    setText(
      elements.adminUsers,
      firstValue(result, ["users", "userCount", "totalUsers"]) ??
        "Unavailable"
    );
    setText(
      elements.adminSessions,
      firstValue(result, ["sessions", "sessionCount", "activeSessions"]) ??
        "Unavailable"
    );
    setText(
      elements.adminAlerts,
      firstValue(result, ["alerts", "alertCount", "openAlerts"]) ??
        "Unavailable"
    );
    setStatus(
      elements.adminStatus,
      "Administrative summary returned by the API.",
      "ready"
    );
    return true;
  }

  async function refreshAdminSummary() {
    elements.adminPanel.hidden = true;
    if (!authenticated()) return;
    try {
      const result = await request(ENDPOINTS.adminSummary, {
        method: "GET",
      });
      renderAdminSummary(result);
    } catch (_error) {
      elements.adminPanel.hidden = true;
    }
  }

  async function refreshAuthenticatedPanels() {
    if (!authenticated()) return;
    const devices = await refreshDevices();
    if (
      Array.isArray(devices)
      && !devices.some((device) => device.current === true)
      && state.automaticDeviceAttemptedForUser !== state.user.username
    ) {
      state.automaticDeviceAttemptedForUser = state.user.username;
      await registerCurrentDevice();
    }
    await Promise.allSettled([
      refreshNotifications(),
      refreshSecuritySummary(),
      refreshAdminSummary(),
    ]);
  }

  function setAuthenticatedUser(user) {
    state.user = user || null;
    const signedIn = authenticated();
    elements.securityCenter.hidden = !signedIn;
    elements.recoveryPanel.hidden = signedIn;
    elements.passkeyLogin.hidden = signedIn;
    elements.passkeyRegister.hidden = !signedIn;
    setText(elements.securityUser, signedIn ? state.user.username : "");
    elements.deleteConfirmation.value = "";
    elements.deleteAcknowledgement.checked = false;
    setStatus(elements.deleteStatus, "", "neutral");
    if (!signedIn) {
      state.automaticDeviceAttemptedForUser = null;
      clearRecoveryCodes();
      state.localNotifications = [];
      elements.adminPanel.hidden = true;
      renderNotifications([]);
      return;
    }
    refreshAuthenticatedPanels();
  }

  function attachEvents() {
    elements.registerDevice.addEventListener("click", registerCurrentDevice);
    elements.refreshDevices.addEventListener("click", refreshDevices);
    elements.deviceList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-revoke-device]");
      if (button) revokeDevice(button.dataset.revokeDevice, button);
    });
    elements.passkeyRegister.addEventListener("click", registerPasskey);
    elements.passkeyLogin.addEventListener("click", loginWithPasskey);
    elements.recoveryStartForm.addEventListener("submit", (event) => {
      event.preventDefault();
      startRecovery();
    });
    elements.recoveryResetForm.addEventListener("submit", (event) => {
      event.preventDefault();
      completeRecovery();
    });
    elements.generateRecoveryCodes.addEventListener(
      "click",
      generateRecoveryCodes
    );
    elements.downloadRecoveryCodes.addEventListener(
      "click",
      downloadRecoveryCodes
    );
    elements.clearRecoveryCodes.addEventListener(
      "click",
      clearRecoveryCodes
    );
    elements.notificationRefresh.addEventListener(
      "click",
      refreshNotifications
    );
    elements.notificationList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-notification-read]");
      if (button) {
        markNotificationRead(button.dataset.notificationRead, button);
      }
    });
    elements.explanationRequest.addEventListener(
      "click",
      requestExplanation
    );
    elements.deleteForm.addEventListener("submit", (event) => {
      event.preventDefault();
      deleteAccount();
    });
  }

  function init(configuration) {
    if (state.initialized) return api;
    if (!global.document) return api;
    state.config = {
      device: global.OdysseusDevice,
      ...(configuration || {}),
    };
    if (!state.config.device) {
      throw new Error("Odysseus device module is required.");
    }
    const missing = bindElements();
    if (missing.length) {
      global.console.error(
        `Odysseus account UI is missing required elements: ${missing.join(", ")}`
      );
      return api;
    }
    state.initialized = true;
    attachEvents();
    renderRecoveryCodes();
    renderNotifications([]);
    setAuthenticatedUser(
      typeof state.config.getCurrentUser === "function"
        ? state.config.getCurrentUser()
        : null
    );
    initializeDescriptor();
    loadTurnstileConfig();
    return api;
  }

  function destroy() {
    state.destroyed = true;
    state.recoveryCodes = [];
    state.turnstileToken = "";
    state.config = null;
    state.user = null;
  }

  function getTurnstileToken() {
    return state.turnstileToken;
  }

  const api = Object.freeze({
    ENDPOINTS,
    destroy,
    formatPercent,
    getTurnstileToken,
    ids,
    init,
    normalizeDevices,
    normalizeNotifications,
    pushNotification,
    refresh: refreshAuthenticatedPanels,
    resetTurnstile,
    setAuthenticatedUser,
  });

  global.OdysseusAccount = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
