(function (global) {
  "use strict";

  const LOCAL_FINGERPRINT_ADAPTER =
    "/vendor/fingerprintjs.min.js";

  let registeredFingerprintAdapter = null;
  let adapterLoadPromise = null;

  function text(value, fallback) {
    return typeof value === "string" && value.trim()
      ? value.trim()
      : fallback;
  }

  function numberBucket(value, ranges, unavailable) {
    if (!Number.isFinite(Number(value))) {
      return unavailable;
    }
    const numeric = Number(value);
    const match = ranges.find((range) => numeric <= range.maximum);
    return match ? match.label : ranges[ranges.length - 1].overflow;
  }

  function screenClass(screenValue) {
    const width = Number(screenValue && screenValue.width);
    const height = Number(screenValue && screenValue.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return "Unavailable";
    }
    const longest = Math.max(width, height);
    if (longest < 800) return "Compact";
    if (longest < 1400) return "Medium";
    if (longest < 2200) return "Large";
    return "Extra large";
  }

  function hardwareClass(value) {
    return numberBucket(
      value,
      [
        { maximum: 2, label: "2 or fewer logical cores" },
        { maximum: 4, label: "3 to 4 logical cores" },
        { maximum: 8, label: "5 to 8 logical cores" },
        {
          maximum: Number.POSITIVE_INFINITY,
          label: "More than 8 logical cores",
          overflow: "More than 8 logical cores",
        },
      ],
      "Unavailable"
    );
  }

  function memoryClass(value) {
    return numberBucket(
      value,
      [
        { maximum: 2, label: "2 GB or less" },
        { maximum: 4, label: "3 to 4 GB" },
        { maximum: 8, label: "5 to 8 GB" },
        {
          maximum: Number.POSITIVE_INFINITY,
          label: "More than 8 GB",
          overflow: "More than 8 GB",
        },
      ],
      "Unavailable"
    );
  }

  function deviceKind(navigatorValue, screenValue, mobileHint) {
    if (mobileHint === true) return "Mobile";
    const touchPoints = Number(navigatorValue && navigatorValue.maxTouchPoints);
    const width = Number(screenValue && screenValue.width);
    if (touchPoints > 0 && Number.isFinite(width) && width < 900) {
      return "Touch device";
    }
    if (Number.isFinite(width) && width >= 900) return "Desktop class";
    return "Unknown device class";
  }

  function safeTimezone(environment) {
    try {
      return text(
        environment.Intl.DateTimeFormat().resolvedOptions().timeZone,
        "Unavailable"
      );
    } catch (_error) {
      return "Unavailable";
    }
  }

  async function clientHints(navigatorValue) {
    const uaData = navigatorValue && navigatorValue.userAgentData;
    if (!uaData) {
      return {
        available: false,
        brands: [],
        mobile: null,
        platform: "",
        platformVersion: "",
        architecture: "",
        bitness: "",
        model: "",
      };
    }

    let highEntropy = {};
    if (typeof uaData.getHighEntropyValues === "function") {
      try {
        highEntropy = await uaData.getHighEntropyValues([
          "architecture",
          "bitness",
          "model",
          "platformVersion",
          "uaFullVersion",
          "fullVersionList",
        ]);
      } catch (_error) {
        highEntropy = {};
      }
    }

    const brands = Array.isArray(highEntropy.fullVersionList)
      ? highEntropy.fullVersionList
      : Array.isArray(uaData.brands)
        ? uaData.brands
        : [];

    return {
      available: true,
      brands: brands
        .filter((brand) => brand && brand.brand)
        .map((brand) => ({
          brand: String(brand.brand),
          version: text(brand.version, "Unknown"),
        })),
      mobile:
        typeof uaData.mobile === "boolean" ? uaData.mobile : null,
      platform: text(uaData.platform, ""),
      platformVersion: text(highEntropy.platformVersion, ""),
      architecture: text(highEntropy.architecture, ""),
      bitness: text(highEntropy.bitness, ""),
      model: text(highEntropy.model, ""),
    };
  }

  async function describe(environment) {
    const scope = environment || global;
    const navigatorValue = scope.navigator || {};
    const screenValue = scope.screen || {};
    const hints = await clientHints(navigatorValue);
    const model = text(hints.model, "Unavailable");
    const platform = text(
      hints.platform,
      text(navigatorValue.platform, "Unavailable")
    );
    const browserBrands = hints.brands.length
      ? hints.brands.map((brand) => brand.brand).join(", ")
      : "Browser details limited";

    return Object.freeze({
      kind: deviceKind(navigatorValue, screenValue, hints.mobile),
      platform,
      platformVersion: text(hints.platformVersion, "Unavailable"),
      architecture: text(
        [hints.architecture, hints.bitness].filter(Boolean).join(" "),
        "Unavailable"
      ),
      model,
      browserBrands,
      screenClass: screenClass(screenValue),
      touch:
        Number(navigatorValue.maxTouchPoints) > 0
          ? "Touch capable"
          : "No touch signal",
      language: text(navigatorValue.language, "Unavailable"),
      timezone: safeTimezone(scope),
      hardwareClass: hardwareClass(navigatorValue.hardwareConcurrency),
      memoryClass: memoryClass(navigatorValue.deviceMemory),
      clientHintsAvailable: hints.available,
      exactModelAvailable: model !== "Unavailable",
      capturedAt: new Date().toISOString(),
    });
  }

  function coarseBrowserFamily(descriptor, environment) {
    const scope = environment || global;
    const navigatorValue = scope.navigator || {};
    const source = [
      descriptor && descriptor.browserBrands,
      navigatorValue.userAgent,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (source.includes("edge") || source.includes("edg/")) return "edge";
    if (source.includes("firefox")) return "firefox";
    if (source.includes("chrome") || source.includes("chromium")) {
      return "chrome";
    }
    if (source.includes("safari")) return "safari";
    return "other";
  }

  function coarseDeviceClass(descriptor, environment) {
    const scope = environment || global;
    const navigatorValue = scope.navigator || {};
    const userAgent = text(navigatorValue.userAgent, "").toLowerCase();
    const platform = text(navigatorValue.platform, "").toLowerCase();
    const kind = text(descriptor && descriptor.kind, "").toLowerCase();
    const size = text(
      descriptor && descriptor.screenClass,
      ""
    ).toLowerCase();
    if (
      userAgent.includes("iphone") ||
      userAgent.includes("ipod") ||
      userAgent.includes("mobile")
    ) {
      return "mobile";
    }
    if (
      userAgent.includes("ipad") ||
      userAgent.includes("tablet") ||
      userAgent.includes("android") ||
      (platform === "macintel" &&
        Number(navigatorValue.maxTouchPoints) > 1)
    ) {
      return "tablet";
    }
    if (kind.includes("mobile")) return "mobile";
    if (kind.includes("desktop")) return "desktop";
    if (kind.includes("touch")) {
      return size === "compact" ? "mobile" : "tablet";
    }
    return "unknown";
  }

  function coarseInputMode(descriptor, environment) {
    const touch = text(descriptor && descriptor.touch, "").toLowerCase();
    const deviceClass = coarseDeviceClass(descriptor, environment);
    if (touch.includes("capable")) {
      return deviceClass === "desktop" ? "hybrid" : "touch";
    }
    if (touch.includes("no touch") && deviceClass === "desktop") {
      return "keyboard-pointer";
    }
    return "unknown";
  }

  function coarseOsFamily(descriptor, environment) {
    const scope = environment || global;
    const navigatorValue = scope.navigator || {};
    const source = [
      descriptor && descriptor.platform,
      navigatorValue.platform,
      navigatorValue.userAgent,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (source.includes("android")) return "android";
    if (
      source.includes("iphone") ||
      source.includes("ipad") ||
      source.includes("ipod") ||
      (source.includes("macintel") &&
        Number(navigatorValue.maxTouchPoints) > 1)
    ) {
      return "ios";
    }
    if (source.includes("cros") || source.includes("chrome os")) {
      return "chromeos";
    }
    if (source.includes("windows") || source.includes("win32")) {
      return "windows";
    }
    if (source.includes("mac")) return "macos";
    if (source.includes("linux")) return "linux";
    return "other";
  }

  function coarseLocaleLanguage(descriptor) {
    const candidate = text(
      descriptor && descriptor.language,
      "und"
    ).split(/[-_]/)[0];
    return /^[A-Za-z]{2,3}$/.test(candidate)
      ? candidate.toLowerCase()
      : "und";
  }

  function coarseDescriptor(descriptor, environment) {
    const scope = environment || global;
    const DateConstructor = scope.Date || Date;
    const timezoneOffsetMinutes = Number(
      new DateConstructor().getTimezoneOffset()
    );
    return Object.freeze({
      browserFamily: coarseBrowserFamily(descriptor, scope),
      deviceClass: coarseDeviceClass(descriptor, scope),
      inputMode: coarseInputMode(descriptor, scope),
      localeLanguage: coarseLocaleLanguage(descriptor),
      osFamily: coarseOsFamily(descriptor, scope),
      timezoneOffsetMinutes: Number.isFinite(timezoneOffsetMinutes)
        ? Math.max(-720, Math.min(840, timezoneOffsetMinutes))
        : 0,
    });
  }

  function descriptorLabel(descriptor) {
    const source = descriptor || {};
    return [
      text(source.kind, "Unknown device"),
      text(source.platform, "Unknown platform"),
      text(source.browserBrands, "Unknown browser"),
    ].join(" | ");
  }

  function registerFingerprintAdapter(adapter) {
    registeredFingerprintAdapter = adapter || null;
  }

  function activeFingerprintAdapter() {
    return registeredFingerprintAdapter || global.FingerprintJS || null;
  }

  async function fingerprint() {
    const adapter = activeFingerprintAdapter();
    if (!adapter || typeof adapter.load !== "function") {
      return Object.freeze({
        available: false,
        visitorId: null,
        confidence: null,
        reason: "Optional local FingerprintJS adapter is not installed.",
      });
    }
    try {
      const agent = await adapter.load();
      const result = await agent.get();
      return Object.freeze({
        available: Boolean(result && result.visitorId),
        visitorId: result && result.visitorId ? result.visitorId : null,
        confidence:
          result &&
          result.confidence &&
          Number.isFinite(Number(result.confidence.score))
            ? Number(result.confidence.score)
            : null,
        reason: result && result.visitorId
          ? ""
          : "The local fingerprint adapter returned no identifier.",
      });
    } catch (error) {
      return Object.freeze({
        available: false,
        visitorId: null,
        confidence: null,
        reason: `Local fingerprint adapter unavailable: ${error.message}`,
      });
    }
  }

  function loadLocalFingerprintAdapter(path) {
    const source = path || LOCAL_FINGERPRINT_ADAPTER;
    if (activeFingerprintAdapter()) {
      return Promise.resolve(activeFingerprintAdapter());
    }
    if (!global.document || !global.location) {
      return Promise.resolve(null);
    }
    const resolved = new URL(source, global.location.origin);
    if (resolved.origin !== global.location.origin) {
      return Promise.reject(
        new Error("Fingerprint adapter must be served from this origin.")
      );
    }
    if (!adapterLoadPromise) {
      adapterLoadPromise = new Promise((resolve) => {
        const script = global.document.createElement("script");
        script.src = resolved.pathname;
        script.async = true;
        script.dataset.odysseusFingerprintAdapter = "true";
        script.onload = () => resolve(activeFingerprintAdapter());
        script.onerror = () => resolve(null);
        global.document.head.appendChild(script);
      }).finally(() => {
        adapterLoadPromise = null;
      });
    }
    return adapterLoadPromise;
  }

  function bytesFromBase64Url(value) {
    if (value instanceof ArrayBuffer) {
      return value;
    }
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength
      );
    }
    if (typeof value !== "string") {
      throw new TypeError("WebAuthn binary value must be base64url text.");
    }
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    if (typeof global.atob === "function") {
      const binary = global.atob(padded);
      const bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0)
      );
      return bytes.buffer;
    }
    if (typeof Buffer !== "undefined") {
      const bytes = Buffer.from(padded, "base64");
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      );
    }
    throw new Error("No base64 decoder is available.");
  }

  function base64UrlFromBytes(value) {
    if (value === null || value === undefined) return null;
    const bytes =
      value instanceof Uint8Array
        ? value
        : new Uint8Array(
            value instanceof ArrayBuffer ? value : value.buffer
          );
    let base64;
    if (typeof global.btoa === "function") {
      let binary = "";
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      base64 = global.btoa(binary);
    } else if (typeof Buffer !== "undefined") {
      base64 = Buffer.from(bytes).toString("base64");
    } else {
      throw new Error("No base64 encoder is available.");
    }
    return base64
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  function mapCredentialIds(credentials) {
    if (!Array.isArray(credentials)) return credentials;
    return credentials.map((credential) => ({
      ...credential,
      id: bytesFromBase64Url(credential.id),
    }));
  }

  function prepareCreationOptions(options) {
    const source = options && options.publicKey
      ? options.publicKey
      : options;
    if (!source || !source.challenge || !source.user) {
      throw new TypeError("Passkey registration options are incomplete.");
    }
    return {
      ...source,
      challenge: bytesFromBase64Url(source.challenge),
      user: {
        ...source.user,
        id: bytesFromBase64Url(source.user.id),
      },
      excludeCredentials: mapCredentialIds(source.excludeCredentials),
    };
  }

  function prepareRequestOptions(options) {
    const source = options && options.publicKey
      ? options.publicKey
      : options;
    if (!source || !source.challenge) {
      throw new TypeError("Passkey login options are incomplete.");
    }
    return {
      ...source,
      challenge: bytesFromBase64Url(source.challenge),
      allowCredentials: mapCredentialIds(source.allowCredentials),
    };
  }

  function extensionResults(credential) {
    return typeof credential.getClientExtensionResults === "function"
      ? credential.getClientExtensionResults()
      : {};
  }

  function serializeRegistration(credential) {
    if (!credential || !credential.response) {
      throw new TypeError("Passkey registration credential is missing.");
    }
    return {
      id: credential.id,
      rawId: base64UrlFromBytes(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || null,
      clientExtensionResults: extensionResults(credential),
      response: {
        clientDataJSON: base64UrlFromBytes(
          credential.response.clientDataJSON
        ),
        attestationObject: base64UrlFromBytes(
          credential.response.attestationObject
        ),
        transports:
          typeof credential.response.getTransports === "function"
            ? credential.response.getTransports()
            : [],
      },
    };
  }

  function serializeAuthentication(credential) {
    if (!credential || !credential.response) {
      throw new TypeError("Passkey authentication credential is missing.");
    }
    return {
      id: credential.id,
      rawId: base64UrlFromBytes(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || null,
      clientExtensionResults: extensionResults(credential),
      response: {
        clientDataJSON: base64UrlFromBytes(
          credential.response.clientDataJSON
        ),
        authenticatorData: base64UrlFromBytes(
          credential.response.authenticatorData
        ),
        signature: base64UrlFromBytes(credential.response.signature),
        userHandle: base64UrlFromBytes(credential.response.userHandle),
      },
    };
  }

  function supportsPasskeys(navigatorValue) {
    const value = navigatorValue || global.navigator;
    return Boolean(
      value &&
      value.credentials &&
      typeof value.credentials.create === "function" &&
      typeof value.credentials.get === "function" &&
      global.PublicKeyCredential
    );
  }

  async function createPasskey(options, navigatorValue) {
    const value = navigatorValue || global.navigator;
    if (!supportsPasskeys(value)) {
      throw new Error("Passkeys are unavailable in this browser.");
    }
    const credential = await value.credentials.create({
      publicKey: prepareCreationOptions(options),
    });
    return serializeRegistration(credential);
  }

  async function getPasskey(options, navigatorValue) {
    const value = navigatorValue || global.navigator;
    if (!supportsPasskeys(value)) {
      throw new Error("Passkeys are unavailable in this browser.");
    }
    const credential = await value.credentials.get({
      publicKey: prepareRequestOptions(options),
    });
    return serializeAuthentication(credential);
  }

  const api = Object.freeze({
    LOCAL_FINGERPRINT_ADAPTER,
    base64UrlFromBytes,
    bytesFromBase64Url,
    coarseDescriptor,
    createPasskey,
    describe,
    descriptorLabel,
    fingerprint,
    getPasskey,
    loadLocalFingerprintAdapter,
    prepareCreationOptions,
    prepareRequestOptions,
    registerFingerprintAdapter,
    serializeAuthentication,
    serializeRegistration,
    supportsPasskeys,
  });

  global.OdysseusDevice = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
