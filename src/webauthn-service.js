"use strict";

const crypto = require("node:crypto");

const simpleWebAuthn = require("@simplewebauthn/server");

const { sha256 } = require("./crypto");
const {
  normalizeCredential,
  normalizeOrigin,
  normalizeRpId,
  normalizeTransports,
} = require("./webauthn-data");

const DEFAULT_TIMEOUT_MS = 60_000;

class WebAuthnConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WebAuthnConfigurationError";
    this.code = "WEBAUTHN_CONFIGURATION_ERROR";
  }
}

class WebAuthnVerificationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "WebAuthnVerificationError";
    this.code = "WEBAUTHN_VERIFICATION_FAILED";
    this.details = details;
  }
}

function normalizeOrigins(value) {
  const origins = Array.isArray(value) ? value : [value];
  if (origins.length < 1 || origins.length > 20) {
    throw new WebAuthnConfigurationError(
      "At least one and at most 20 WebAuthn origins are required.",
    );
  }
  try {
    return Object.freeze([...new Set(origins.map(normalizeOrigin))]);
  } catch (error) {
    throw new WebAuthnConfigurationError(error.message);
  }
}

function normalizeTimeout(value = DEFAULT_TIMEOUT_MS) {
  if (!Number.isSafeInteger(value) || value < 15_000 || value > 300_000) {
    throw new WebAuthnConfigurationError(
      "WebAuthn timeout must be between 15000 and 300000 milliseconds.",
    );
  }
  return value;
}

function credentialIdString(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64url");
  }
  if (
    typeof value === "string"
    && value.length >= 1
    && value.length <= 1366
    && /^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return value;
  }
  throw new WebAuthnVerificationError("Credential ID is invalid.");
}

function publicKeyBytes(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value)) {
    return new Uint8Array(Buffer.from(value, "base64url"));
  }
  throw new WebAuthnVerificationError("Credential public key is invalid.");
}

function normalizeStoredCredential(credential) {
  if (!credential || typeof credential !== "object") {
    throw new WebAuthnVerificationError("Stored credential is unavailable.");
  }
  return {
    id: credentialIdString(credential.credentialId ?? credential.id),
    publicKey: publicKeyBytes(
      credential.publicKey ?? credential.credentialPublicKey,
    ),
    counter: Number(credential.counter ?? 0),
    transports: normalizeTransports(credential.transports ?? []),
  };
}

function makeExpectedChallenge(challengeHash) {
  const expected = Buffer.from(challengeHash);
  if (expected.length !== 32) {
    throw new WebAuthnVerificationError("Stored challenge digest is invalid.");
  }
  return (candidate) => {
    const actual = sha256(`odysseus:webauthn-challenge:v1:${candidate}`);
    return crypto.timingSafeEqual(actual, expected);
  };
}

function hashChallenge(challenge) {
  if (
    typeof challenge !== "string"
    || challenge.length < 16
    || challenge.length > 1024
  ) {
    throw new WebAuthnVerificationError("WebAuthn challenge is invalid.");
  }
  return sha256(`odysseus:webauthn-challenge:v1:${challenge}`);
}

function decodeClientData(response, expectedType) {
  const encoded = response?.response?.clientDataJSON;
  if (
    typeof encoded !== "string"
    || encoded.length < 1
    || encoded.length > 16_384
    || !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw new WebAuthnVerificationError(
      "WebAuthn client data is missing or invalid.",
    );
  }
  let clientData;
  try {
    clientData = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new WebAuthnVerificationError(
      "WebAuthn client data could not be decoded.",
    );
  }
  if (
    !clientData
    || typeof clientData !== "object"
    || clientData.type !== expectedType
    || typeof clientData.challenge !== "string"
    || clientData.challenge.length < 16
    || clientData.challenge.length > 1024
  ) {
    throw new WebAuthnVerificationError(
      "WebAuthn client data has an invalid type or challenge.",
    );
  }
  return Object.freeze({
    challenge: clientData.challenge,
    crossOrigin: clientData.crossOrigin === true,
    origin: clientData.origin,
    type: clientData.type,
  });
}

function normalizeRegistrationResult(result, response, name = "Passkey") {
  if (!result || result.verified !== true || !result.registrationInfo) {
    throw new WebAuthnVerificationError(
      "The authenticator registration could not be verified.",
    );
  }
  const info = result.registrationInfo;
  const credential = info.credential;
  return normalizeCredential({
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    aaguid: info.aaguid,
    transports:
      response?.response?.transports
      ?? credential.transports
      ?? [],
    userVerified: info.userVerified,
    backupEligible: info.credentialDeviceType === "multiDevice",
    backupState: info.credentialBackedUp,
    name,
  });
}

function normalizeAuthenticationResult(result) {
  if (!result || result.verified !== true || !result.authenticationInfo) {
    throw new WebAuthnVerificationError(
      "The authenticator assertion could not be verified.",
    );
  }
  const info = result.authenticationInfo;
  return Object.freeze({
    credentialId: credentialIdString(info.credentialID),
    counter: info.newCounter,
    userVerified: info.userVerified,
    backupEligible: info.credentialDeviceType === "multiDevice",
    backupState: info.credentialBackedUp,
    origin: info.origin,
    rpId: info.rpID,
  });
}

function createWebAuthnService(options = {}) {
  let rpId;
  try {
    rpId = normalizeRpId(options.rpId ?? "localhost");
  } catch (error) {
    throw new WebAuthnConfigurationError(error.message);
  }
  const rpName = String(options.rpName ?? "Odysseus").trim();
  if (rpName.length < 1 || rpName.length > 100) {
    throw new WebAuthnConfigurationError(
      "WebAuthn relying party name must contain 1 to 100 characters.",
    );
  }
  const expectedOrigins = normalizeOrigins(
    options.expectedOrigins ?? ["http://localhost:3000"],
  );
  const timeout = normalizeTimeout(options.timeout);
  const provider = options.provider ?? simpleWebAuthn;
  for (const method of [
    "generateAuthenticationOptions",
    "generateRegistrationOptions",
    "verifyAuthenticationResponse",
    "verifyRegistrationResponse",
  ]) {
    if (typeof provider[method] !== "function") {
      throw new WebAuthnConfigurationError(
        `WebAuthn provider is missing ${method}.`,
      );
    }
  }

  function expectedOrigin(origin) {
    let normalized;
    try {
      normalized = normalizeOrigin(origin);
    } catch (error) {
      throw new WebAuthnVerificationError(error.message);
    }
    if (!expectedOrigins.includes(normalized)) {
      throw new WebAuthnVerificationError(
        "The WebAuthn response origin is not allowed.",
      );
    }
    return normalized;
  }

  async function createRegistrationOptions(input) {
    const user = input?.user;
    if (
      !user
      || !Number.isSafeInteger(user.id)
      || user.id < 1
      || typeof user.username !== "string"
    ) {
      throw new WebAuthnVerificationError(
        "A persisted user is required for passkey registration.",
      );
    }
    const credentials = Array.isArray(input.credentials)
      ? input.credentials
      : [];
    return provider.generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userName: user.username,
      userDisplayName: user.username,
      userID: new Uint8Array(
        sha256(`odysseus:webauthn-user-handle:v1:${user.id}`),
      ),
      ...(input.challenge ? { challenge: input.challenge } : {}),
      timeout,
      attestationType: "none",
      excludeCredentials: credentials.map((credential) => ({
        id: credentialIdString(
          credential.credentialId ?? credential.id,
        ),
        transports: normalizeTransports(credential.transports ?? []),
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    });
  }

  async function verifyRegistration(input) {
    const origin = expectedOrigin(input?.origin);
    const expectedChallenge = input.expectedChallenge
      ?? makeExpectedChallenge(input.challengeHash);
    const result = await provider.verifyRegistrationResponse({
      response: input.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserPresence: true,
      requireUserVerification: true,
    });
    return normalizeRegistrationResult(
      result,
      input.response,
      input.name,
    );
  }

  async function createAuthenticationOptions(input = {}) {
    const credentials = Array.isArray(input.credentials)
      ? input.credentials
      : null;
    return provider.generateAuthenticationOptions({
      rpID: rpId,
      ...(input.challenge ? { challenge: input.challenge } : {}),
      timeout,
      userVerification: "required",
      allowCredentials: credentials
        ? credentials.map((credential) => ({
          id: credentialIdString(
            credential.credentialId ?? credential.id,
          ),
          transports: normalizeTransports(credential.transports ?? []),
        }))
        : undefined,
    });
  }

  async function verifyAuthentication(input) {
    const origin = expectedOrigin(input?.origin);
    const expectedChallenge = input.expectedChallenge
      ?? makeExpectedChallenge(input.challengeHash);
    const result = await provider.verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: normalizeStoredCredential(input.credential),
      requireUserVerification: true,
    });
    return normalizeAuthenticationResult(result);
  }

  return Object.freeze({
    createAuthenticationOptions,
    createRegistrationOptions,
    expectedOrigins,
    hashChallenge,
    rpId,
    rpName,
    verifyAuthentication,
    verifyRegistration,
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  WebAuthnConfigurationError,
  WebAuthnVerificationError,
  createWebAuthnService,
  credentialIdString,
  decodeClientData,
  hashChallenge,
  makeExpectedChallenge,
  normalizeAuthenticationResult,
  normalizeRegistrationResult,
  normalizeStoredCredential,
};
