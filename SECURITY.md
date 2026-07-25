# Odysseus security model

## Trust boundaries

The server's deterministic policy is the only component allowed to create or
clear access grants. Browser diagnostics, IP observations, device indicators,
Hugging Face experiments, and Gemini explanations cannot directly authorize a
request.

Behavioral matching is a secondary signal. It must be combined with a real
account factor for enrollment, recovery, profile replacement, profile transfer,
and sensitive account changes.

## Baseline protection

The active profile must not learn from every session.

Current template evolution requires a successful verification, recent strong
authorization, and distinct sessions. Denied and ordinary unmatched sessions do
not evolve the profile.

The future production contract is stricter:

1. The first five accepted check-ins create baseline version 1 only after
   primary-factor and human-assurance checks pass.
2. Baseline version 1 becomes immutable and recoverable.
3. Every later session is scored against the active version before any update
   is considered.
4. Sessions that appear automated, fail human assurance, or differ beyond the
   configured quarantine boundary cannot train or replace any baseline.
5. Mild drift creates a separate candidate version only after repeated
   successful sessions with recent strong authorization.
6. Candidate promotion requires policy checks, an audit event, and a retained
   rollback target.
7. A user or administrator can inspect version history and restore a prior
   trusted version without deleting the audit trail.

This prevents a single unusual or hostile session from poisoning the known-good
profile.

## Browser telemetry boundary

The browser may submit bounded aggregate timing, cadence, word-position,
pointer, viewport, display, and page-activity summaries.

The browser must not submit:

- Typed content
- Key identities or keycodes
- Raw keyboard or pointer events
- Raw cursor coordinates
- Full cursor trajectories
- Passwords or recovery material
- Session, CSRF, device, or provider credentials
- Cookies
- A persistent browser visitor identifier

Client-reported values are not proof. The server validates their shape and size,
uses them for behavior comparison or reporting only as designed, and keeps
authorization decisions server-side.

## Stored security data

The local database stores:

- Scrypt password hashes
- Hashed session and CSRF credentials
- Encrypted behavioral profiles
- Account-owned device records and associations
- Passkey public credential records
- Recovery request state
- In-app security notices
- Aggregate verification and account audit metadata

Behavioral profile encryption uses AES-256-GCM. The account and profile identity
are authenticated encryption context, so encrypted records cannot be moved
between owners or profiles without detection.

## Provider boundary

Gemini is an optional explanation renderer. It is not an authentication
component. A provider request must be explicit, authenticated, same-origin,
CSRF-protected, rate-limited, and backed by recent strong authorization.

The provider receives only a fixed allowlist of coarse, server-owned aggregate
signals. It receives no typed text, raw events, account or profile identifiers,
IP addresses, device information, credentials, policy grants, or browser-supplied
free-form context.

Provider output is schema-validated, rendered as text, labeled advisory, and
returned with `authorizationDecision: null`. Provider failure must not affect
core readiness, login, verification, grants, or the deterministic report.

## PostgreSQL and RLS

SQLite is the local single-instance store. A PostgreSQL deployment must enable
and force row-level security on every account-scoped table. Policies must scope
rows through the authenticated immutable account identifier. Administrator
aggregate access must use narrowly defined security-definer functions that do
not return row-level identifiers.

RLS must never be disabled for testing, migration shortcuts, maintenance, or
provider integration.

## Production requirements

Before real account protection:

1. Keep encryption and provider keys in a managed secret store.
2. Use exact HTTPS origins and a controlled proxy-hop configuration.
3. Use WebAuthn user verification for high-assurance enrollment and recovery.
4. Validate bot-management tokens on the server.
5. Replace local-only shared state with production Redis and PostgreSQL.
6. Keep PostgreSQL RLS enabled and forced.
7. Calibrate thresholds with consented genuine and impostor sessions.
8. Measure false acceptance, false rejection, and equal error rates.
9. Test assistive technology, mobile, touch, zoom, and motor variability.
10. Add centralized alerting, backup restoration, load testing, and incident
    response exercises.
11. Complete privacy, legal, penetration, and independent security reviews.
12. Test profile rollback and baseline-poisoning response.

## Reporting issues

Do not put passwords, tokens, keys, databases, raw user data, or credential
screenshots in an issue. Share sensitive evidence through a private channel
chosen by the repository owner.
