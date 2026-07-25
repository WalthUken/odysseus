"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  WebAuthnConfigurationError,
  WebAuthnVerificationError,
  createWebAuthnService,
  decodeClientData,
  hashChallenge,
  makeExpectedChallenge,
  normalizeStoredCredential,
} = require("../src/webauthn-service");

function createProvider(overrides = {}) {
  return {
    async generateAuthenticationOptions(options) {
      return { challenge: "auth-challenge-value", options };
    },
    async generateRegistrationOptions(options) {
      return { challenge: "registration-challenge-value", options };
    },
    async verifyAuthenticationResponse() {
      return {
        verified: true,
        authenticationInfo: {
          credentialID: "credential-id",
          newCounter: 4,
          userVerified: true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
          origin: "http://localhost:3000",
          rpID: "localhost",
        },
      };
    },
    async verifyRegistrationResponse() {
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: "credential-id",
            publicKey: Buffer.from("credential-public-key"),
            counter: 0,
          },
          aaguid: "00000000-0000-0000-0000-000000000000",
          userVerified: true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
        },
      };
    },
    ...overrides,
  };
}

test("challenge digests can be checked without storing the challenge", () => {
  const challenge = "0123456789abcdefghijklmnop";
  const digest = hashChallenge(challenge);
  const expectedChallenge = makeExpectedChallenge(digest);

  assert.equal(expectedChallenge(challenge), true);
  assert.equal(expectedChallenge(`${challenge}x`), false);
});

test("client challenge extraction validates ceremony type", () => {
  const encoded = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge: "0123456789abcdefghijklmnop",
    origin: "http://localhost:3000",
    crossOrigin: false,
  })).toString("base64url");

  assert.equal(
    decodeClientData(
      { response: { clientDataJSON: encoded } },
      "webauthn.get",
    ).challenge,
    "0123456789abcdefghijklmnop",
  );
  assert.throws(
    () => decodeClientData(
      { response: { clientDataJSON: encoded } },
      "webauthn.create",
    ),
    WebAuthnVerificationError,
  );
});

test("registration options use a pseudonymous user handle and required UV", async () => {
  let observed;
  const provider = createProvider({
    async generateRegistrationOptions(options) {
      observed = options;
      return { challenge: "registration-challenge-value" };
    },
  });
  const service = createWebAuthnService({ provider });

  const options = await service.createRegistrationOptions({
    user: { id: 19, username: "casey" },
    challenge: "server-registration-challenge",
    credentials: [{
      credentialId: Buffer.from("existing"),
      transports: ["internal"],
    }],
  });

  assert.equal(options.challenge, "registration-challenge-value");
  assert.equal(observed.userName, "casey");
  assert.equal(observed.challenge, "server-registration-challenge");
  assert.equal(observed.userID.length, 32);
  assert.equal(observed.authenticatorSelection.userVerification, "required");
  assert.equal(observed.attestationType, "none");
  assert.deepEqual(observed.excludeCredentials, [{
    id: Buffer.from("existing").toString("base64url"),
    transports: ["internal"],
  }]);
});

test("authentication can be discoverable or credential restricted", async () => {
  const calls = [];
  const provider = createProvider({
    async generateAuthenticationOptions(options) {
      calls.push(options);
      return { challenge: `challenge-${calls.length}` };
    },
  });
  const service = createWebAuthnService({ provider });

  await service.createAuthenticationOptions();
  await service.createAuthenticationOptions({
    challenge: "server-authentication-challenge",
    credentials: [{
      credentialId: Buffer.from("known"),
      transports: ["usb"],
    }],
  });

  assert.equal(calls[0].allowCredentials, undefined);
  assert.deepEqual(calls[1].allowCredentials, [{
    id: Buffer.from("known").toString("base64url"),
    transports: ["usb"],
  }]);
  assert.equal(calls[1].challenge, "server-authentication-challenge");
  assert.equal(calls[0].userVerification, "required");
});

test("verified registration preserves backup and authenticator metadata", async () => {
  let verificationOptions;
  const provider = createProvider({
    async verifyRegistrationResponse(options) {
      verificationOptions = options;
      return createProvider().verifyRegistrationResponse();
    },
  });
  const service = createWebAuthnService({ provider });
  const challenge = "abcdefghijklmnopqrstuvwxyz123456";

  const credential = await service.verifyRegistration({
    response: {
      response: {
        transports: ["internal", "hybrid"],
      },
    },
    challengeHash: hashChallenge(challenge),
    origin: "http://localhost:3000",
    name: "Laptop passkey",
  });

  assert.equal(
    verificationOptions.expectedChallenge(challenge),
    true,
  );
  assert.equal(verificationOptions.requireUserVerification, true);
  assert.equal(credential.name, "Laptop passkey");
  assert.equal(credential.backupEligible, true);
  assert.equal(credential.backupState, true);
  assert.deepEqual(credential.transports, ["hybrid", "internal"]);
});

test("verified authentication exposes the new counter and backup flags", async () => {
  let verificationOptions;
  const provider = createProvider({
    async verifyAuthenticationResponse(options) {
      verificationOptions = options;
      return createProvider().verifyAuthenticationResponse();
    },
  });
  const service = createWebAuthnService({ provider });

  const result = await service.verifyAuthentication({
    response: { id: "credential-id" },
    credential: {
      credentialId: Buffer.from("credential-id"),
      publicKey: Buffer.from("credential-public-key"),
      counter: 3,
      transports: ["internal"],
    },
    challengeHash: hashChallenge("abcdefghijklmnopqrstuvwxyz123456"),
    origin: "http://localhost:3000",
  });

  assert.equal(verificationOptions.credential.counter, 3);
  assert.equal(result.counter, 4);
  assert.equal(result.userVerified, true);
  assert.equal(result.backupEligible, true);
  assert.equal(result.backupState, true);
});

test("origin allowlist rejects host-header substitution", async () => {
  const service = createWebAuthnService({
    provider: createProvider(),
    expectedOrigins: ["http://localhost:3000"],
  });

  await assert.rejects(
    () => service.verifyAuthentication({
      response: { id: "credential-id" },
      credential: {
        credentialId: Buffer.from("credential-id"),
        publicKey: Buffer.from("credential-public-key"),
        counter: 3,
      },
      challengeHash: hashChallenge("abcdefghijklmnopqrstuvwxyz123456"),
      origin: "https://attacker.example",
    }),
    WebAuthnVerificationError,
  );
});

test("invalid provider configuration fails at startup", () => {
  assert.throws(
    () => createWebAuthnService({ provider: {} }),
    WebAuthnConfigurationError,
  );
});

test("stored credentials reject invalid key material", () => {
  assert.throws(
    () => normalizeStoredCredential({
      credentialId: "valid-id",
      publicKey: "$$$",
    }),
    WebAuthnVerificationError,
  );
});
