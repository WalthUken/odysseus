"use strict";

const {
  ProviderInputError,
  boundedNumber,
  boundedString,
  fetchJson,
  providerFailure,
  recordProviderObservation,
  requireExactKeys,
} = require("./provider-utils");

const FEATURE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  "api-inference.huggingface.co",
  "router.huggingface.co",
]);

function validateShadowReport(report) {
  requireExactKeys(
    report,
    ["version", "aggregateDistance", "localDecision", "featureDeltas"],
    "Shadow anomaly report"
  );
  if (report.version !== 1) {
    throw new ProviderInputError("Shadow anomaly report version must be 1.");
  }
  if (!["allow", "step_up", "deny"].includes(report.localDecision)) {
    throw new ProviderInputError(
      "Shadow anomaly report localDecision is invalid."
    );
  }
  if (
    !Array.isArray(report.featureDeltas)
    || report.featureDeltas.length < 1
    || report.featureDeltas.length > 32
  ) {
    throw new ProviderInputError(
      "Shadow anomaly report requires 1 to 32 feature deltas."
    );
  }
  return {
    version: 1,
    aggregateDistance: boundedNumber(
      report.aggregateDistance,
      "aggregateDistance",
      { minimum: 0, maximum: 1_000_000 }
    ),
    localDecision: report.localDecision,
    featureDeltas: report.featureDeltas.map((feature, index) => {
      requireExactKeys(
        feature,
        ["name", "normalizedDelta"],
        `featureDeltas[${index}]`
      );
      return {
        name: boundedString(feature.name, `featureDeltas[${index}].name`, {
          maximum: 64,
          pattern: FEATURE_PATTERN,
        }),
        normalizedDelta: boundedNumber(
          feature.normalizedDelta,
          `featureDeltas[${index}].normalizedDelta`,
          { minimum: -100, maximum: 100 }
        ),
      };
    }),
  };
}

function validateShadowResponse(response) {
  requireExactKeys(
    response,
    ["anomalyScore", "label", "modelVersion"],
    "Hugging Face shadow response",
    ["anomalyScore", "label"]
  );
  if (!["normal", "anomalous", "uncertain"].includes(response.label)) {
    throw new ProviderInputError(
      "Hugging Face shadow response label is invalid.",
      "INVALID_PROVIDER_RESPONSE"
    );
  }
  return {
    anomalyScore: boundedNumber(
      response.anomalyScore,
      "response.anomalyScore",
      { minimum: 0, maximum: 1 }
    ),
    label: response.label,
    modelVersion:
      response.modelVersion === undefined
        ? null
        : boundedString(response.modelVersion, "response.modelVersion", {
            maximum: 64,
            pattern: VERSION_PATTERN,
          }),
  };
}

function allowedEndpoint(endpoint, additionalHosts) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (_error) {
    throw new TypeError("Hugging Face endpointUrl is invalid.");
  }
  const allowedHosts = new Set([
    ...DEFAULT_ALLOWED_HOSTS,
    ...(additionalHosts || []).map((value) => String(value).toLowerCase()),
  ]);
  const hostname = url.hostname.toLowerCase();
  const hostedEndpoint = hostname.endsWith(".endpoints.huggingface.cloud");
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || (!allowedHosts.has(hostname) && !hostedEndpoint)
  ) {
    throw new TypeError(
      "Hugging Face endpointUrl must be an approved HTTPS inference host."
    );
  }
  return url.toString();
}

class HuggingFaceAnomalyAdapter {
  constructor(options = {}) {
    this.endpointUrl = options.endpointUrl
      ? allowedEndpoint(options.endpointUrl, options.allowedHosts)
      : null;
    this.apiToken =
      options.apiToken || null;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = Number(options.timeoutMs ?? 3_000);
    this.monitoring = options.monitoring;
    this.state = this.endpointUrl ? "unchecked" : "disabled";
    if (
      this.apiToken
      && (
        typeof this.apiToken !== "string"
        || this.apiToken.length < 8
        || this.apiToken.length > 4_096
        || /[\r\n]/.test(this.apiToken)
      )
    ) {
      throw new TypeError("Hugging Face apiToken is invalid.");
    }
  }

  readiness() {
    if (!this.endpointUrl) {
      return {
        ready: false,
        disabled: true,
        provider: "hugging_face",
        reason: "disabled",
      };
    }
    return {
      ready: this.state === "available",
      provider: "hugging_face",
      reason: this.state === "available" ? null : this.state,
    };
  }

  async analyze(report, options = {}) {
    const validated = validateShadowReport(report);
    if (!this.endpointUrl) {
      recordProviderObservation(
        this.monitoring,
        "hugging_face",
        "disabled"
      );
      return {
        available: false,
        analyzed: false,
        disabled: true,
        provider: "hugging_face",
        code: "HUGGING_FACE_DISABLED",
        shadowOnly: true,
        grantEffect: "none",
        authorizationDecision: null,
      };
    }
    const headers = { "Content-Type": "application/json" };
    if (this.apiToken) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    }

    const started = Date.now();
    try {
      const response = await fetchJson({
        fetchImpl: this.fetchImpl,
        url: this.endpointUrl,
        headers,
        body: JSON.stringify({
          inputs: validated,
          options: {
            use_cache: false,
            wait_for_model: false,
          },
        }),
        timeoutMs: this.timeoutMs,
        maximumBytes: 128 * 1_024,
        signal: options.signal,
      });
      let analysis;
      try {
        analysis = validateShadowResponse(response);
      } catch (error) {
        if (error instanceof ProviderInputError) {
          error.code = "INVALID_PROVIDER_RESPONSE";
        }
        throw error;
      }
      this.state = "available";
      recordProviderObservation(
        this.monitoring,
        "hugging_face",
        "success",
        Date.now() - started
      );
      return {
        available: true,
        analyzed: true,
        provider: "hugging_face",
        analysis,
        shadowOnly: true,
        grantEffect: "none",
        advisoryOnly: true,
        authorizationDecision: null,
      };
    } catch (error) {
      this.state =
        error.code === "PROVIDER_TIMEOUT" ? "timeout" : "unavailable";
      recordProviderObservation(
        this.monitoring,
        "hugging_face",
        error.code === "INVALID_PROVIDER_RESPONSE"
          ? "invalid"
          : this.state,
        Date.now() - started
      );
      return {
        analyzed: false,
        shadowOnly: true,
        grantEffect: "none",
        advisoryOnly: true,
        ...providerFailure("hugging_face", error),
      };
    }
  }
}

function createHuggingFaceAnomalyAdapter(options) {
  return new HuggingFaceAnomalyAdapter(options);
}

module.exports = {
  DEFAULT_ALLOWED_HOSTS,
  HuggingFaceAnomalyAdapter,
  allowedEndpoint,
  createHuggingFaceAnomalyAdapter,
  validateShadowReport,
  validateShadowResponse,
};
