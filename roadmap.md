# Odysseus roadmap

## Goal

Build an account-security system that quietly collects useful interaction
signals, preserves a known-good behavioral baseline, explains uncertainty
clearly, and always falls back to stronger account factors.

## Baseline versioning and poisoning resistance

This is the next major data-model project.

### Enrollment

- Require a verified account factor before behavioral enrollment.
- Require server-validated human assurance for every enrollment check-in.
- Collect five accepted guided typing, free typing, and pointer sessions.
- Reject synthetic browser events and repeated or implausible timing patterns.
- Create baseline version 1 only when all five sessions pass quality checks.
- Freeze version 1 as a recoverable, auditable record.

### Later sessions

- Compare every later session with the active baseline.
- Keep the result in one of three lanes:
  - accepted and eligible for drift observation
  - uncertain and quarantined
  - rejected and excluded from all learning
- Never update the active baseline from a single session.
- Never update from a failed human-assurance result.
- Never update from a denied or sufficiently different result.
- Never allow an advisory provider result to affect learning eligibility.

### Candidate promotion

- Store eligible mild drift in a separate candidate profile.
- Require several accepted sessions across distinct authenticated sessions.
- Require recent strong authorization before a candidate can advance.
- Require stable direction across multiple days where practical.
- Re-run automation, device, accessibility, and anomaly checks at promotion.
- Create a new immutable version rather than editing the active version.
- Retain the prior version for rollback.
- Record creation, quarantine, promotion, rejection, and rollback in the audit.

### Recovery and transparency

- Add an authenticated baseline-version timeline.
- Explain why a candidate was promoted or quarantined using fixed reason codes.
- Let the account owner restore a prior trusted version after strong
  authorization.
- Alert the owner when a new candidate appears or promotion is attempted.
- Provide an administrator aggregate view without exposing account-level
  behavioral records.

## Better enrollment assurance

- Complete Turnstile deployment with exact hostname and action checks.
- Make WebAuthn user verification the preferred enrollment proof.
- Bind five check-ins to a short-lived, single-use server enrollment ceremony.
- Detect duplicate samples, impossible timing, and robotic regularity.
- Add consent and an accessible alternative to behavioral collection.
- Test browser automation and direct API clients.

Human assurance is layered risk reduction. Browser event flags alone cannot
prove a person is present or that the person owns the account.

## Evaluation and calibration

- Collect consented multi-session data across days and devices.
- Separate enrollment, genuine verification, impostor, automation, and
  accessibility cohorts.
- Measure false acceptance, false rejection, equal error, and abstention rates.
- Calibrate thresholds per feature set without hiding uncertainty.
- Compare the current transparent distance model with shadow-only anomaly
  models.
- Keep all experimental models outside the authorization path until independent
  validation is complete.

## Device and session security

- Add user-visible device naming and history.
- Detect meaningful device drift without relying on a persistent invasive
  identifier.
- Add session revocation, unusual-session notices, and recovery alerts.
- Test passkeys across platform and roaming authenticators.
- Separate network observations from identity claims.

## Provider work

- Keep Gemini disabled until the authorization key passes a safe synthetic
  request.
- Finish the coarse privacy-projection schema described in the integration
  document.
- Add policy-invariance tests proving provider success and failure cannot change
  local authorization state.
- Keep Hugging Face experiments in shadow mode with no grant effect.
- Add cost, concurrency, retention, outage, and provider kill-switch controls.

## Production infrastructure

- Move multi-instance state to managed PostgreSQL and Redis.
- Enable and force PostgreSQL RLS on every account-scoped table.
- Never use a role that bypasses RLS.
- Add migrations, backup restoration, disaster recovery, and load tests.
- Add content-free metrics and operational alerting.
- Complete privacy, accessibility, legal, and independent security reviews.
