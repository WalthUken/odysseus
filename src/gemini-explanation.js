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

const GEMINI_API_ROOT =
  "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FEATURE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const AUTHORIZATION_LANGUAGE =
  /\b(authori[sz](?:e|ed|ation)|grant(?:ed)? access|deny access|access (?:is )?(?:allowed|denied)|approve(?:d)? access)\b/i;

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
    this.model = String(options.model ?? "gemini-2.5-flash");
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = Number(options.timeoutMs ?? 5_000);
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
      systemInstruction: {
        parts: [
          {
            text: [
              "Explain the supplied behavioral authentication report.",
              "Use neutral language and do not infer identity or intent.",
              "Do not make, change, or recommend an authorization decision.",
              "Return only the JSON object required by the response schema.",
            ].join(" "),
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: JSON.stringify(validated) }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: EXPLANATION_SCHEMA,
        temperature: 0.2,
        maxOutputTokens: 600,
      },
    };

    const started = Date.now();
    try {
      const response = await fetchJson({
        fetchImpl: this.fetchImpl,
        url: `${GEMINI_API_ROOT}/${encodeURIComponent(
          this.model
        )}:generateContent`,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(requestBody),
        timeoutMs: this.timeoutMs,
        maximumBytes: 256 * 1_024,
        signal: options.signal,
      });
      const text =
        response
        && Array.isArray(response.candidates)
        && response.candidates[0]
        && response.candidates[0].content
        && Array.isArray(response.candidates[0].content.parts)
        && response.candidates[0].content.parts[0]
        && response.candidates[0].content.parts[0].text;
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
