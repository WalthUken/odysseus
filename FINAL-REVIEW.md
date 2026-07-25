# Odysseus final review

Review date: July 25, 2026

## Verdict

The reviewed branch is a functional local behavioral account-security beta.
The current implementation passed the complete server test suite and the final
Chromium and Firefox browser journeys.

This result is not a production security certification. The application still
needs representative calibration, verified enrollment proof, baseline version
history, accessibility evaluation, production shared infrastructure, operational
monitoring, and an independent security assessment before protecting real
accounts.

## Final validation results

| Check | Result |
| --- | --- |
| Node server and unit suite | 133 passed, 0 failed |
| Chromium browser journeys | 9 passed, 0 failed |
| Firefox browser journeys | 9 passed, 0 failed |
| JavaScript syntax | 61 files checked, 0 failures |
| Gemini synthetic provider check | HTTP 401, provider unavailable |
| Local Git commits before release commit | 14 |
| Target release commit | Commit 15 |

The first browser pass exposed stale automated selectors after the interface was
made quieter and account controls were collapsed. The application continued to
complete registration, CSRF, logout, and passkey tests. The selectors were
updated to the current accessible names and collapsed-control workflow. The
complete final pass then succeeded in both browsers.

## Current product behavior

### Account access

- Account registration and sign-in
- Six-character minimum password for local testing
- Scrypt password hashing with independent random salts
- Opaque server sessions
- HttpOnly and SameSite Strict session cookies
- Session-bound CSRF credentials
- Same-origin request validation
- Idempotent logout that clears stale authentication state
- Password step-up for protected operations
- Recovery request, recovery-code rotation, password reset, and session
  revocation
- Account deletion with explicit confirmation

### Behavioral check-ins

- Five different enrollment questions
- Separate guided typing and free-typing tasks
- A six-target pointer route
- Automatic round completion when all requirements are met
- Final guided character remains typeable before automatic acceptance
- Period-free guided examples
- Local typo-tolerant phrase checking
- Rejection of basic script-dispatched keyboard, input, and pointer events
- Verification rounds with different questions
- Scaled Manhattan Distance comparison against the active baseline
- Short behavior grants for matching sessions
- Password step-up after drift or mismatch

### Device and session controls

- Coarse browser and display recognition
- Account-owned device registration and listing
- Hashed device credentials
- Account-scoped client-visitor HMAC where the optional library is available
- Device-to-profile associations
- Restricted profile transfer and destination recalibration
- WebAuthn passkey registration and authentication
- Trusted-device confidence rules that do not overclaim proof
- Redis-backed rate-limit option with fail-closed behavior

### Protected report

The protected authenticated report includes:

- Current authorization method and active-grant state
- Latest behavior result and coarse confidence
- Profile and enrollment quality summaries
- Aggregate key hold, transition, pause, burst, and cadence timing
- Approximate anonymous word positions, lengths, and duration bands
- Pointer distance, speed, timing, and direction-change summaries
- Current device and account-owned device state
- Current session protection state
- Layout viewport, visual viewport, screen size, pixel ratio, and viewport scale
- Page elapsed time, focus, visibility, resize, and orientation-change counts
- Server-observed network context with explicit limitations
- Recent account audit outcomes
- Stored, transmitted, and excluded data boundaries
- Operational limitations and recommended stronger factors

The report is behind authenticated server authorization and collapsed by
default. Page-level browser observations are collected only for the current
page lifetime and are not a persistent visitor identity.

## Data-boundary findings

The browser sends bounded aggregate features. It does not send guided text,
free-typing text, passwords, key identities, keycodes, raw key events, raw cursor
coordinates, full pointer trajectories, cookies, CSRF credentials, session
credentials, or a persistent page-activity identifier.

The server strictly validates diagnostic shape and size. Aggregate browser
diagnostics can enrich a report but do not directly issue a grant. Audit records
exclude passwords, provider keys, typed text, session credentials, and raw
behavior vectors.

## Baseline safety review

Current template evolution already rejects updates from unverified, duplicate,
distant, inconsistent, and denied sessions. Eligible updates require successful
verification, bounded movement, recent strong authorization, and distinct
sessions. Each accepted update is capped and cannot loosen the threshold.

The requested future contract is documented but not fully implemented:

1. Five human-assured check-ins create baseline version 1.
2. Version 1 becomes immutable and recoverable.
3. Later sessions compare with the active version before learning is considered.
4. Automated, denied, or sufficiently different sessions are quarantined and
   cannot replace or train the baseline.
5. Mild drift builds a separate candidate only across repeated strongly
   authorized sessions.
6. Promotion creates a new immutable version and retains a rollback target.
7. Promotion, quarantine, rejection, and rollback are auditable.

Missing implementation pieces are a versioned baseline table, explicit
quarantine records, promotion policy, rollback endpoints and interface, and
enrollment proof that cannot be bypassed by a direct API client.

## Gemini review

The Gemini integration is advisory only and optional. The browser can request an
explanation explicitly. The server resolves an owned finalized audit record and
builds the provider report itself. Client-provided scores, thresholds, decisions,
signals, and free-form context are rejected.

The provider request uses the Interactions API with:

- The key in the `x-goog-api-key` header
- No key in the URL or request body
- `store: false`
- `background: false`
- A strict JSON response schema
- No sampling temperature
- A fixed system instruction that prohibits authorization decisions

Provider output is schema-validated and returned with
`authorizationDecision: null`. Gemini is not a required readiness provider.
Provider failure leaves local authentication and reporting operational.

The user-level key remains outside the repository. A synthetic request returned
HTTP 401, so the current provider-side key authorization is not usable. I am
unsure whether the key itself is invalid, lacks access to the selected model, or
needs a different Google project authorization setup because the provider
returned only an authentication failure for this check. No provider response
body or key was written to the repository.

## RLS review

Local development uses SQLite. The PostgreSQL deployment contract lists every
account-scoped table and requires RLS to be enabled and forced. It also forbids
an application role that bypasses RLS and confines administrator aggregates to
narrow security-definer functions without row-level identifiers.

RLS was not disabled or weakened by this work.

## Known limitations

1. Five samples from one session are a starter baseline, not a mature profile.
2. Behavioral thresholds are not calibrated against representative genuine,
   impostor, accessibility, device, and long-term drift cohorts.
3. Trusted browser-event flags block basic dispatched events but not advanced
   automation or direct API clients.
4. Browser timing is controlled by the client and cannot be treated as perfect
   proof.
5. Display and network information describe context, not identity.
6. Exact browser zoom is not available through a standard browser API. The
   report exposes pixel ratio and visual viewport scale with that limitation.
7. SQLite is for one local instance.
8. Redis and PostgreSQL production deployment still need operational tests.
9. Baseline version history, quarantine, promotion, and rollback are roadmap
   items.
10. Gemini is currently unavailable because the configured key check returned
    HTTP 401.
11. No independent penetration test, load test, disaster-recovery exercise, or
    production privacy review has been completed.

## Recommendation

Use this version for local demonstrations and controlled evaluation. The next
security milestone should be immutable baseline versioning with quarantine and
rollback, paired with passkey-backed enrollment and server-validated human
assurance. Production rollout should wait for consented multi-session
calibration, accessibility validation, shared infrastructure with forced RLS,
operational monitoring, and independent review.
