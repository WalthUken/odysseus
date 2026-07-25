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

// Gemini Interactions API. Verified against the official documentation on
// 2026-07-25: https://ai.google.dev/gemini-api/docs/interactions/quickstart
// The key travels in the x-goog-api-key header, never in the URL.
const GEMINI_API_ROOT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FEATURE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 5_000;

// Advisory prose must never sound authoritative. The filter is deliberately
// word-order independent: "grant access" and "access granted" are the same
// claim, and either one would let generated prose impersonate a decision.
const AUTHORIZATION_OBJECT =
  "(?:access|entry|admission|login|log[ -]?in|sign[ -]?in)";
const AUTHORIZATION_SUBJECT =
  "(?:access|entry|admission|login|log[ -]?in|sign[ -]?in"
  + "|(?:the|this|that|their)\\s+"
  + "(?:user|person|account|session|request|device|actor|attempt))";
const AUTHORIZATION_VERB =
  "(?:grants?|granted|granting|den(?:y|ies|ied|ying)"
  + "|allows?|allowed|allowing|approves?|approved|approving"
  + "|permits?|permitted|permitting|blocks?|blocked|blocking"
  + "|rejects?|rejected|rejecting|clears?|cleared|clearing)";
const AUTHORIZATION_PARTICIPLE =
  "(?:granted|denied|allowed|approved|permitted|blocked|rejected"
  + "|cleared|trusted|authori[sz]ed)";
const AUTHORIZATION_MODAL =
  "(?:is|are|was|were|has\\s+been|have\\s+been|had\\s+been|to\\s+be|be"
  + "|(?:should|shall|can|could|may|might|must|will|would)\\s+be)";
const AUTHORIZATION_CHALLENGE =
  "(?:verification|authentication|challenges?|step[ -]?up|checks?"
  + "|review|scrutiny)";
const AUTHORIZATION_LANGUAGE = new RegExp(
  [
    // "authorize", "authorised", "authorization"
    "\\bauthori[sz](?:e|es|ed|ing|ation|ations)\\b",
    // Verb first: "grant access", "denied the user access".
    "\\b" + AUTHORIZATION_VERB + "\\s+"
      + "(?:(?:the|this|that|their)\\s+)?"
      + "(?:(?:user|person|account|session|request|device)(?:'s|s')?\\s+)?"
      + AUTHORIZATION_OBJECT + "\\b",
    // Object first: "access granted", "the user should be trusted".
    "\\b" + AUTHORIZATION_SUBJECT + "\\s+"
      + "(?:" + AUTHORIZATION_MODAL + "\\s+)?"
      + AUTHORIZATION_PARTICIPLE + "\\b",
    // Subjectless verdicts: "should be trusted", "can be allowed".
    "\\b(?:should|shall|can|could|may|might|must|will|would)\\s+"
      + "(?:be\\s+)?(?:safely\\s+)?" + AUTHORIZATION_PARTICIPLE + "\\b",
    // "let this user proceed", "allow them to proceed".
    "\\b(?:lets?|allows?|permits?)\\s+"
      + "(?:(?:this|the|that|their|them|him|her|it|us)\\s+)?"
      + "(?:(?:user|person|account|session|request|device)\\s+)?"
      + "(?:to\\s+)?proceed\\b",
    "\\b(?:may|can|should|shall|must|will|free\\s+to|safe\\s+to"
      + "|ok(?:ay)?\\s+to|clear(?:ed)?\\s+to)\\s+proceed\\b",
    // "no further verification needed" and its variants.
    "\\bno\\s+(?:further|additional|more|extra|other)\\s+"
      + AUTHORIZATION_CHALLENGE + "\\b",
    "\\bno\\s+(?:(?:further|additional|more|extra|other)\\s+)?"
      + AUTHORIZATION_CHALLENGE + "\\s+(?:(?:is|are|was|were)\\s+)?"
      + "(?:needed|required|necessary|warranted)\\b",
    "\\b" + AUTHORIZATION_CHALLENGE + "\\s+(?:(?:is|are|was|were)\\s+)?"
      + "(?:not\\s+(?:needed|required|necessary)|unnecessary"
      + "|no\\s+longer\\s+(?:needed|required|necessary))\\b",
  ].join("|"),
  "i"
);

const EXPLANATION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    headline: { type: "string", maxLength: 120 },
    summary: { type: "string", maxLength: 800 },
    observations: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: { type: "string", maxLength: 240 },
    },
    nextStep: { type: "string", maxLength: 240 },
  },
  required: ["headline", "summary", "observations", "nextStep"],
});

function resolveTimeoutMs(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const timeoutMs = Number(value);
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 30_000
  ) {
    throw new TypeError(
      "Gemini timeoutMs must be an integer between 1 and 30000."
    );
  }
  return timeoutMs;
}

// One bounded retry, and only for failures the transport marked retryable
// (HTTP 429, HTTP 5xx, transport loss, timeout). A caller-driven abort is
// never retried, so worst-case wall clock stays at two timeout windows.
async function fetchJsonWithSingleRetry(request) {
  try {
    return await fetchJson(request);
  } catch (error) {
    if (
      !error
      || error.retryable !== true
      || error.code === "PROVIDER_ABORTED"
      || (request.signal && request.signal.aborted)
    ) {
      throw error;
    }
    return fetchJson(request);
  }
}

function validateBehaviorReport(report) {
  requireExactKeys(
    report,
    ["version", "assessment", "signals"],
    "Behavior report"
  );
  if (report.version !== 1) {
    throw new ProviderInputError("Behavior report version must be 1.");
  }

  requireExactKeys(
    report.assessment,
    [
      "decision",
      "trustPercent",
      "normalizedDistance",
      "acceptanceThreshold",
      "reasonCodes",
    ],
    "Behavior report assessment"
  );
  if (!["allow", "step_up", "deny"].includes(report.assessment.decision)) {
    throw new ProviderInputError(
      "Behavior report decision is not recognized."
    );
  }
  const reasonCodes = report.assessment.reasonCodes;
  if (!Array.isArray(reasonCodes) || reasonCodes.length > 12) {
    throw new ProviderInputError(
      "Behavior report reasonCodes must contain at most 12 values."
    );
  }
  const normalizedReasons = reasonCodes.map((value, index) =>
    boundedString(value, `reasonCodes[${index}]`, {
      maximum: 64,
      pattern: REASON_PATTERN,
    })
  );

  if (!Array.isArray(report.signals) || report.signals.length > 24) {
    throw new ProviderInputError(
      "Behavior report signals must contain at most 24 values."
    );
  }
  const signals = report.signals.map((signal, index) => {
    requireExactKeys(
      signal,
      ["name", "direction", "deviationRatio"],
      `Behavior report signal ${index}`
    );
    if (!["higher", "lower", "stable"].includes(signal.direction)) {
      throw new ProviderInputError(
        `Behavior report signal ${index} direction is invalid.`
      );
    }
    return {
      name: boundedString(signal.name, `signals[${index}].name`, {
        maximum: 64,
        pattern: FEATURE_PATTERN,
      }),
      direction: signal.direction,
      deviationRatio: boundedNumber(
        signal.deviationRatio,
        `signals[${index}].deviationRatio`,
        { minimum: 0, maximum: 100 }
      ),
    };
  });

  return {
    version: 1,
    assessment: {
      decision: report.assessment.decision,
      trustPercent: boundedNumber(
        report.assessment.trustPercent,
        "assessment.trustPercent",
        { minimum: 0, maximum: 100 }
      ),
      normalizedDistance: boundedNumber(
        report.assessment.normalizedDistance,
        "assessment.normalizedDistance",
        { minimum: 0, maximum: 1_000_000 }
      ),
      acceptanceThreshold: boundedNumber(
        report.assessment.acceptanceThreshold,
        "assessment.acceptanceThreshold",
        { minimum: 0, maximum: 1_000_000 }
      ),
      reasonCodes: normalizedReasons,
    },
    signals,
  };
}

function validateExplanation(value) {
  requireExactKeys(
    value,
    ["headline", "summary", "observations", "nextStep"],
    "Gemini explanation"
  );
  if (
    !Array.isArray(value.observations)
    || value.observations.length < 1
    || value.observations.length > 5
  ) {
    throw new ProviderInputError(
      "Gemini explanation observations are invalid.",
      "INVALID_PROVIDER_RESPONSE"
    );
  }
  const explanation = {
    headline: boundedString(value.headline, "explanation.headline", {
      maximum: 120,
    }),
    summary: boundedString(value.summary, "explanation.summary", {
      maximum: 800,
    }),
    observations: value.observations.map((observation, index) =>
      boundedString(
        observation,
        `explanation.observations[${index}]`,
        { maximum: 240 }
      )
    ),
    nextStep: boundedString(value.nextStep, "explanation.nextStep", {
      maximum: 240,
    }),
  };
  if (
    [
      explanation.headline,
      explanation.summary,
      explanation.nextStep,
      ...explanation.observations,
    ].some((text) => AUTHORIZATION_LANGUAGE.test(text))
  ) {
    throw new ProviderInputError(
      "Gemini explanation attempted to make an authorization statement.",
      "INVALID_PROVIDER_RESPONSE"
    );
  }
  return explanation;
}

function explanationProse(explanation) {
  return [
    `AI-generated explanation: ${explanation.headline}`,
    `Summary: ${explanation.summary}`,
    "Observations:",
    ...explanation.observations.map((value) => `* ${value}`),
    `Suggested next step: ${explanation.nextStep}`,
    "Authority: Advisory only. Odysseus policy remains authoritative.",
  ].join("\n");
}

class GeminiExplanationAdapter {
  constructor(options = {}) {
    this.apiKey = options.apiKey || null;
    this.model = String(options.model ?? "gemini-3.6-flash");
    this.fetchImpl = options.fetchImpl;
    const env = options.env ?? process.env;
    this.timeoutMs = resolveTimeoutMs(
      options.timeoutMs ?? env.ODYSSEUS_GEMINI_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    );
    this.monitoring = options.monitoring;
    this.state = this.apiKey ? "unchecked" : "disabled";
    if (!MODEL_PATTERN.test(this.model)) {
      throw new TypeError("Gemini model name is invalid.");
    }
    if (
      this.apiKey
      && (
        typeof this.apiKey !== "string"
        || this.apiKey.length < 8
        || this.apiKey.length > 512
      )
    ) {
      throw new TypeError("Gemini apiKey is invalid.");
    }
  }

  readiness() {
    if (!this.apiKey) {
      return {
        ready: false,
        disabled: true,
        provider: "gemini",
        reason: "disabled",
      };
    }
    return {
      ready: this.state === "available",
      provider: "gemini",
      reason: this.state === "available" ? null : this.state,
    };
  }

  async explain(report, options = {}) {
    const validated = validateBehaviorReport(report);
    if (!this.apiKey) {
      recordProviderObservation(this.monitoring, "gemini", "disabled");
      return {
        available: false,
        generated: false,
        disabled: true,
        provider: "gemini",
        code: "GEMINI_DISABLED",
        advisoryOnly: true,
        authorizationDecision: null,
      };
    }
    const requestBody = {
      model: this.model,
      input: JSON.stringify(validated),
      system_instruction: [
        "Explain the supplied behavioral authentication report.",
        "Use neutral language and do not infer identity or intent.",
        "Do not make, change, or recommend an authorization decision.",
        "Return only the JSON object required by the response schema.",
      ].join(" "),
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: EXPLANATION_SCHEMA,
      },
      store: false,
      background: false,
      generation_config: {
        max_output_tokens: 600,
        thinking_level: "minimal",
      },
    };

    const started = Date.now();
    try {
      const response = await fetchJsonWithSingleRetry({
        fetchImpl: this.fetchImpl,
        url: GEMINI_API_ROOT,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(requestBody),
        timeoutMs: this.timeoutMs,
        maximumBytes: 256 * 1_024,
        signal: options.signal,
      });
      // A safety block, a failed interaction, or an empty step timeline is a
      // clean provider failure, never a partially trusted explanation.
      // `promptFeedback` covers blocked payloads from the older response shape.
      const steps =
        response && Array.isArray(response.steps) ? response.steps : [];
      if (
        !response
        || response.promptFeedback
        || response.status === "failed"
        || response.status === "cancelled"
        || steps.length === 0
      ) {
        throw new ProviderInputError(
          "Gemini blocked or failed the interaction.",
          "INVALID_PROVIDER_RESPONSE"
        );
      }
      const modelOutput = [...steps]
        .reverse()
        .find((step) => step && step.type === "model_output");
      const textPart = modelOutput
        && Array.isArray(modelOutput.content)
        && modelOutput.content.find(
          (part) => part && part.type === "text"
        );
      const text = textPart && textPart.text;
      if (typeof text !== "string" || text.length > 16_000) {
        throw new ProviderInputError(
          "Gemini response did not contain structured text.",
          "INVALID_PROVIDER_RESPONSE"
        );
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_error) {
        throw new ProviderInputError(
          "Gemini response was not valid structured JSON.",
          "INVALID_PROVIDER_RESPONSE"
        );
      }
      let explanation;
      try {
        explanation = validateExplanation(parsed);
      } catch (error) {
        if (error instanceof ProviderInputError) {
          error.code = "INVALID_PROVIDER_RESPONSE";
        }
        throw error;
      }
      this.state = "available";
      recordProviderObservation(
        this.monitoring,
        "gemini",
        "success",
        Date.now() - started
      );
      return {
        available: true,
        generated: true,
        provider: "gemini",
        model: this.model,
        label: "AI-generated explanation",
        explanation,
        prose: explanationProse(explanation),
        advisoryOnly: true,
        authorizationDecision: null,
      };
    } catch (error) {
      this.state =
        error.code === "PROVIDER_TIMEOUT" ? "timeout" : "unavailable";
      recordProviderObservation(
        this.monitoring,
        "gemini",
        error.code === "INVALID_PROVIDER_RESPONSE"
          ? "invalid"
          : this.state,
        Date.now() - started
      );
      return {
        generated: false,
        advisoryOnly: true,
        ...providerFailure("gemini", error),
      };
    }
  }
}

function createGeminiExplanationAdapter(options) {
  return new GeminiExplanationAdapter(options);
}

module.exports = {
  AUTHORIZATION_LANGUAGE,
  EXPLANATION_SCHEMA,
  GEMINI_API_ROOT,
  GeminiExplanationAdapter,
  createGeminiExplanationAdapter,
  explanationProse,
  validateBehaviorReport,
  validateExplanation,
};
