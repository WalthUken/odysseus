"use strict";

const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  return number;
}

function escapeHelp(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabel(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function renderNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value));
}

class MetricsRegistry {
  constructor(options = {}) {
    this.prefix = String(options.prefix ?? "odysseus");
    if (!METRIC_NAME_PATTERN.test(this.prefix)) {
      throw new TypeError("Metrics prefix is invalid.");
    }
    this.metrics = new Map();
  }

  defineMetric(type, name, help, options = {}) {
    if (!METRIC_NAME_PATTERN.test(name)) {
      throw new TypeError("Metric name is invalid.");
    }
    const fullName = `${this.prefix}_${name}`;
    if (this.metrics.has(fullName)) {
      throw new TypeError(`Metric "${fullName}" is already registered.`);
    }
    if (typeof help !== "string" || !help || help.length > 240) {
      throw new TypeError("Metric help must be 1 to 240 characters.");
    }

    const labelNames = Object.freeze([...(options.labelNames || [])]);
    const allowedLabelValues = Object.create(null);
    for (const label of labelNames) {
      if (!LABEL_NAME_PATTERN.test(label)) {
        throw new TypeError(`Metric label "${label}" is invalid.`);
      }
      const values = options.allowedLabelValues
        && options.allowedLabelValues[label];
      if (!Array.isArray(values) || values.length < 1 || values.length > 64) {
        throw new TypeError(
          `Metric label "${label}" requires a bounded value allowlist.`
        );
      }
      allowedLabelValues[label] = new Set(values.map(String));
    }

    const metric = {
      type,
      name: fullName,
      help,
      labelNames,
      allowedLabelValues,
      series: new Map(),
      buckets: options.buckets,
    };
    this.metrics.set(fullName, metric);
    return type === "counter"
      ? this.counterHandle(metric)
      : this.histogramHandle(metric);
  }

  labelsFor(metric, supplied = {}) {
    if (
      supplied === null
      || typeof supplied !== "object"
      || Array.isArray(supplied)
    ) {
      throw new TypeError("Metric labels must be an object.");
    }
    const unexpected = Object.keys(supplied).filter(
      (name) => !metric.labelNames.includes(name)
    );
    if (unexpected.length) {
      throw new TypeError("Metric labels contain undeclared names.");
    }

    const labels = Object.create(null);
    for (const name of metric.labelNames) {
      const value = String(supplied[name] ?? "other");
      const allowed = metric.allowedLabelValues[name];
      if (allowed.has(value)) {
        labels[name] = value;
      } else if (allowed.has("other")) {
        labels[name] = "other";
      } else {
        throw new TypeError(
          `Metric label "${name}" is outside its allowlist.`
        );
      }
    }
    return labels;
  }

  seriesKey(metric, labels) {
    return metric.labelNames.map((name) => labels[name]).join("\u0000");
  }

  counterHandle(metric) {
    const registry = this;
    if (metric.labelNames.length === 0) {
      metric.series.set("", {
        labels: Object.create(null),
        value: 0,
      });
    }
    return Object.freeze({
      inc(labels, amount) {
        let suppliedLabels = labels;
        let suppliedAmount = amount;
        if (typeof labels === "number" && amount === undefined) {
          suppliedLabels = {};
          suppliedAmount = labels;
        }
        const normalizedLabels = registry.labelsFor(
          metric,
          suppliedLabels || {}
        );
        const increment = finiteNumber(suppliedAmount ?? 1, "Counter amount");
        if (increment < 0) {
          throw new TypeError("Counter amount must not be negative.");
        }
        const key = registry.seriesKey(metric, normalizedLabels);
        const series = metric.series.get(key) || {
          labels: normalizedLabels,
          value: 0,
        };
        series.value += increment;
        metric.series.set(key, series);
      },
    });
  }

  histogramHandle(metric) {
    const registry = this;
    if (metric.labelNames.length === 0) {
      metric.series.set("", {
        labels: Object.create(null),
        bucketCounts: metric.buckets.map(() => 0),
        count: 0,
        sum: 0,
      });
    }
    return Object.freeze({
      observe(labels, value) {
        let suppliedLabels = labels;
        let suppliedValue = value;
        if (typeof labels === "number" && value === undefined) {
          suppliedLabels = {};
          suppliedValue = labels;
        }
        const normalizedLabels = registry.labelsFor(
          metric,
          suppliedLabels || {}
        );
        const observation = finiteNumber(
          suppliedValue,
          "Histogram observation"
        );
        const key = registry.seriesKey(metric, normalizedLabels);
        const series = metric.series.get(key) || {
          labels: normalizedLabels,
          bucketCounts: metric.buckets.map(() => 0),
          count: 0,
          sum: 0,
        };
        metric.buckets.forEach((boundary, index) => {
          if (observation <= boundary) {
            series.bucketCounts[index] += 1;
          }
        });
        series.count += 1;
        series.sum += observation;
        metric.series.set(key, series);
      },
    });
  }

  counter(name, help, options) {
    return this.defineMetric("counter", name, help, options);
  }

  histogram(name, help, options = {}) {
    const buckets = [...(options.buckets || [])]
      .map((value) => finiteNumber(value, "Histogram bucket"))
      .sort((left, right) => left - right);
    if (
      buckets.length < 1
      || buckets.length > 32
      || buckets.some((value, index) =>
        index > 0 && value === buckets[index - 1]
      )
    ) {
      throw new TypeError(
        "Histogram requires 1 to 32 unique numeric buckets."
      );
    }
    return this.defineMetric("histogram", name, help, {
      ...options,
      buckets,
    });
  }

  renderLabels(metric, labels, additional) {
    const values = metric.labelNames.map(
      (name) => `${name}="${escapeLabel(labels[name])}"`
    );
    if (additional) {
      values.push(additional);
    }
    return values.length ? `{${values.join(",")}}` : "";
  }

  render() {
    const lines = [];
    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      for (const series of metric.series.values()) {
        if (metric.type === "counter") {
          lines.push(
            `${metric.name}${this.renderLabels(
              metric,
              series.labels
            )} ${renderNumber(series.value)}`
          );
          continue;
        }

        metric.buckets.forEach((boundary, index) => {
          lines.push(
            `${metric.name}_bucket${this.renderLabels(
              metric,
              series.labels,
              `le="${escapeLabel(boundary)}"`
            )} ${series.bucketCounts[index]}`
          );
        });
        lines.push(
          `${metric.name}_bucket${this.renderLabels(
            metric,
            series.labels,
            'le="+Inf"'
          )} ${series.count}`
        );
        lines.push(
          `${metric.name}_sum${this.renderLabels(
            metric,
            series.labels
          )} ${renderNumber(series.sum)}`
        );
        lines.push(
          `${metric.name}_count${this.renderLabels(
            metric,
            series.labels
          )} ${series.count}`
        );
      }
    }
    return `${lines.join("\n")}\n`;
  }
}

function createMetricsRegistry(options) {
  return new MetricsRegistry(options);
}

function createOdysseusMonitoring(options = {}) {
  const registry = createMetricsRegistry(options);
  const providerValues = [
    "turnstile",
    "gemini",
    "hugging_face",
    "in_app",
    "webhook",
    "email",
    "other",
  ];
  const outcomeValues = [
    "success",
    "failure",
    "timeout",
    "disabled",
    "invalid",
    "other",
  ];
  const routeValues = [
    "health",
    "auth",
    "profile",
    "enroll",
    "verify",
    "audit",
    "secure_action",
    "static",
    "other",
  ];
  const methodValues = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "other",
  ];

  return Object.freeze({
    registry,
    httpRequests: registry.counter(
      "http_requests_total",
      "HTTP requests handled by bounded route and status groups.",
      {
        labelNames: ["method", "route", "status"],
        allowedLabelValues: {
          method: methodValues,
          route: routeValues,
          status: ["2xx", "3xx", "4xx", "5xx", "other"],
        },
      }
    ),
    providerRequests: registry.counter(
      "provider_requests_total",
      "External provider calls by bounded provider and outcome.",
      {
        labelNames: ["provider", "outcome"],
        allowedLabelValues: {
          provider: providerValues,
          outcome: outcomeValues,
        },
      }
    ),
    providerDuration: registry.histogram(
      "provider_duration_seconds",
      "External provider request duration in seconds.",
      {
        labelNames: ["provider"],
        allowedLabelValues: { provider: providerValues },
        buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
      }
    ),
    requestDuration: registry.histogram(
      "http_request_duration_seconds",
      "HTTP request duration by bounded route and method.",
      {
        labelNames: ["method", "route"],
        allowedLabelValues: {
          method: methodValues,
          route: routeValues,
        },
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      }
    ),
    render() {
      return registry.render();
    },
  });
}

module.exports = {
  MetricsRegistry,
  createOdysseusMonitoring,
  createMetricsRegistry,
  escapeHelp,
  escapeLabel,
};
