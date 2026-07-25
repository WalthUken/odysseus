"use strict";

function buildContentSecurityPolicy(options = {}) {
  const directives = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'none'",
    "worker-src 'none'",
    "manifest-src 'self'",
  ];
  if (options.production) {
    directives.push("upgrade-insecure-requests");
  }
  return directives.join("; ");
}

function createSecurityHeaders(options = {}) {
  const contentSecurityPolicy = buildContentSecurityPolicy(options);

  return function securityHeaders(request, response, next) {
    response.set("Content-Security-Policy", contentSecurityPolicy);
    response.set("Cross-Origin-Opener-Policy", "same-origin");
    response.set("Cross-Origin-Resource-Policy", "same-origin");
    response.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.set("Referrer-Policy", "no-referrer");
    response.set("X-Content-Type-Options", "nosniff");
    response.set("X-Frame-Options", "DENY");

    if (options.production) {
      response.set(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains"
      );
    }
    if (request.path.startsWith("/api/")) {
      response.set("Cache-Control", "no-store");
      response.set("Pragma", "no-cache");
    }
    next();
  };
}

function normalizeOrigin(value) {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch (_error) {
    return null;
  }
}

function expectedOrigins(request, configuredOrigins) {
  if (typeof configuredOrigins === "function") {
    return expectedOrigins(request, configuredOrigins(request));
  }
  if (configuredOrigins) {
    const values = Array.isArray(configuredOrigins)
      ? configuredOrigins
      : [configuredOrigins];
    return new Set(values.map(normalizeOrigin).filter(Boolean));
  }

  const host = request.get("host");
  const derived = host ? normalizeOrigin(`${request.protocol}://${host}`) : null;
  return new Set(derived ? [derived] : []);
}

function isSameOrigin(request, configuredOrigins) {
  const allowed = expectedOrigins(request, configuredOrigins);
  const origin = normalizeOrigin(request.get("origin"));
  if (origin) {
    return allowed.has(origin);
  }

  const referer = normalizeOrigin(request.get("referer"));
  if (referer) {
    return allowed.has(referer);
  }

  return request.get("sec-fetch-site") === "same-origin";
}

function createSameOriginGuard(options = {}) {
  return function sameOriginGuard(request, response, next) {
    if (isSameOrigin(request, options.allowedOrigins)) {
      next();
      return;
    }

    response.status(403).json({
      error: {
        code: "ORIGIN_REJECTED",
        message: "The request did not come from this application origin.",
      },
    });
  };
}

module.exports = {
  buildContentSecurityPolicy,
  createSameOriginGuard,
  createSecurityHeaders,
  expectedOrigins,
  isSameOrigin,
  normalizeOrigin,
};
