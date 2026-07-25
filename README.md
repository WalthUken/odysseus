# Odysseus

Odysseus is a local behavioral account-security beta. It combines ordinary
account authentication with a five-part interaction baseline, later comparison
sessions, device recognition, passkey support, recovery controls, audit records,
and a protected account report.

The behavioral result is a secondary signal. It does not prove identity, prove
humanity, replace a password or passkey, or authorize anything outside the
server's deterministic policy.

## Current user flow

1. Create an account and sign in.
2. Complete five short check-ins that include guided typing, free typing, and
   pointer movement.
3. The browser sends aggregate timing and movement features, not typed text.
4. The server builds an encrypted account-scoped profile.
5. A later check-in is compared with the active profile.
6. A match can create a short behavior grant. Drift or mismatch requires a
   stronger account factor.
7. The authenticated security report explains the decision, recent account
   activity, device state, session state, and bounded browser observations.

The public page uses a compact account-console layout. Technical collection
details and account settings are collapsed by default so routine use stays
calm. The detailed report remains available after the server verifies the
session and recent authorization.

## Collected and excluded data

The browser calculates aggregate features such as:

- Key hold and transition timing summaries
- Pause, burst, and cadence summaries
- Approximate anonymous word positions, lengths, and durations
- Pointer timing, distance, speed, direction changes, and target completion
- Viewport size, screen size, pixel ratio, and visual viewport scale
- Page focus, visibility, resize, and orientation-change counts

The browser does not send:

- Guided or free-typing text
- Passwords, recovery codes, session credentials, or CSRF credentials
- Key identities, keycodes, or raw key events
- Raw cursor coordinates or full pointer paths
- Cookies, a persistent visitor identifier, or the user-agent string

The protected report describes the available aggregates and their limitations.
Browser-supplied diagnostics are reporting context, not trusted authorization
inputs.

## Security architecture

- Scrypt password hashing with independent random salts
- Opaque server sessions and session-bound CSRF credentials
- Same-origin checks for state-changing requests
- HttpOnly and SameSite Strict session cookies
- AES-256-GCM encryption for behavioral profiles
- Account and profile identifiers bound as authenticated encryption context
- Server-side profile ownership and protected-action checks
- Short behavior and password step-up grants
- Rejection clears any active behavior grant
- Process-local or Redis-backed rate limiting
- Passkey registration and authentication through WebAuthn
- Optional server-validated Turnstile human proof
- Content-free provider monitoring and readiness states
- SQLite for local use and a documented PostgreSQL RLS deployment contract

Row-level security must remain enabled and forced on every account-scoped table
when PostgreSQL is used. The application role must never bypass RLS.

## Gemini status

Gemini is optional and advisory only. The server can send a strict,
server-created aggregate report after an authenticated user explicitly requests
an explanation. The request excludes typed text, identifiers, network data,
device data, and raw events. Provider output cannot change a score, threshold,
grant, profile, session, device association, or authorization decision.

The integration uses the Interactions API with storage and background execution
disabled. Without a configured key, the application continues normally and the
provider remains disabled.

The locally configured authorization key was rejected by the provider with HTTP
401 during the July 25, 2026 validation. The key remains outside the repository.
Gemini should be treated as unavailable until the provider-side authorization
configuration is corrected and the safe synthetic check succeeds.

## Run locally

Requirements:

- Node.js 24 or newer
- A supported Chromium or Firefox browser for browser tests

Install and run:

```powershell
npm ci
npm start
```

Open `http://127.0.0.1:3000`.

Run the automated suite:

```powershell
npm test
npx playwright test
```

Copy `.env.example` to `.env` only for local configuration. Never commit `.env`,
database files, generated encryption keys, provider credentials, or screenshots
containing credentials.

## Production limits

This repository is suitable for local demonstrations and controlled evaluation.
It is not a production identity system or a security certification. Production
use still requires representative false-acceptance and false-rejection
calibration, enrollment proof, accessibility testing, load testing, shared
infrastructure, monitoring, recovery exercises, privacy review, and an
independent security assessment.

See [SECURITY.md](SECURITY.md), [roadmap.md](roadmap.md), and
[docs/GEMINI-INTEGRATION.md](docs/GEMINI-INTEGRATION.md) for the detailed
boundaries and planned work.
