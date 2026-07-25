# Odysseus

Odysseus is a local behavioral account-security beta. It combines ordinary
account authentication with an account-scoped interaction baseline, device
recognition, passkey support, recovery controls, audit records, and a protected
report that only a local operator can open.

The behavioral result is a secondary signal. It does not prove identity, prove
humanity, replace a password or passkey, or authorize anything outside the
server's deterministic policy.

## Two front ends

The repository ships two browser-facing surfaces against one engine.

| Surface | Command | Port | What it is |
| --- | --- | --- | --- |
| Odysseus console | `npm start` | 3000 | The engine plus its own account console (`public/`) |
| OptionsFlow mockup | `npm run mockup` | 4000 | A fake trading site (`mockup_website/`) that uses Odysseus for accounts |

The mockup is the realistic demo: it looks like an ordinary trading site and
never mentions that anything behavioral is happening. It holds no accounts of
its own. Every account action is forwarded server-to-server to Odysseus, so the
browser only ever talks to port 4000 and never sees an Odysseus cookie.

## The user flow

**On the mockup (`http://127.0.0.1:4000`):**

1. Sign in, or create an account. Recovery questions during signup are optional
   and collapsed behind "Add password recovery questions (optional)".
2. Sign-in lands directly on the trading dashboard. There is no challenge, no
   enrollment round, and no typing mission on this path.
3. From then on, telemetry is collected passively and silently during ordinary
   use. Keystroke timing comes from the order-ticket **Quantity** and **Limit
   price** inputs only; pointer movement is collected across the whole page. A
   sample is attempted every 1.5 seconds and uploaded only when enough
   observations have accumulated.
4. The first five complete samples enroll the account baseline. Every later
   sample is compared against it.
5. Security questions appear only behind **"Forgot your password?"**, as a
   password-recovery step. They are not part of signup or sign-in.

**On the Odysseus console (`http://127.0.0.1:3000`):**

Sign-in opens the account's security-questions view first, which collects five
short setup rounds, and the dashboard opens once those are saved. Telemetry
then continues passively on the dashboard. This console is the engineering
surface; the mockup is the surface that shows the intended end-user experience.

Whichever surface is used, the behavioral machinery is silent. Reaching the
dashboard is the only feedback a successful check produces.

## Nothing behavioral is shown to the user

No trust score, decision, reason code, automation verdict, similarity result,
or profiling progress is rendered anywhere in either front end. This is
enforced, not incidental:

- The console's behavioral review panel, trust panel, automation card, signal
  metrics, technical report, setup-progress counter, and round tag are all
  permanently hidden. The markup survives only because `public/app.js` aborts
  start-up if one of its bound element ids is missing; nothing writes to them.
- A behavioral refusal on the console produces the same generic message as any
  other failed sign-in: "We could not complete this sign-in. Check your details
  and try again." The mockup shows "We could not complete this sign-in. Please
  try again."
- The mockup's telemetry relay answers every upload with the same bare
  acknowledgement, whether Odysseus accepted it, rejected it, or was not
  running at all.
- The simulated network-restriction notice is retired. Nothing tells a user
  that an address was restricted, because nothing ever was.

`e2e/odysseus.spec.js` holds this contract to a byte comparison: apart from the
single status line, the rendered page after a behavioral denial is identical to
the rendered page after a wrong password.

The only way to see a verdict is the local report viewer described below.

## The protected report

`/admin` and `/admin/test` are served only when `ODYSSEUS_DEMO_ADMIN_BYPASS` is
set, only outside production, and only to a loopback client. Any other request
gets a plain 404.

That environment variable is an on/off switch for the viewer. It is not a
credential and is never accepted as one. The form itself takes the target
account's own **username and password** — the same credentials used to sign in.
Failed attempts are rate limited and audited, and a successful one does not
create an admin session.

`/admin` shows the saved baseline, comparisons, identity similarity, automation
risk, decision reasons, feature contributions, sample totals, and fingerprint
update history. `/admin/test` collects three fresh samples and can strengthen
the active baseline when all three match and all three read as human-like.

The report omits passwords, password hashes, session and CSRF credentials,
device fingerprint digests, passkey keys, ciphertext, encryption keys, typed
content, and raw events.

The mockup does not host a viewer of its own. Its "Admin report viewer" link
points at the Odysseus origin's `/admin`, and the mockup server reports that
origin through `GET /api/config` so the link stays correct when
`ODYSSEUS_ORIGIN` is changed.

## Collected and excluded data

`public/telemetry.js` computes a 20-value feature vector in the browser. Only
that vector, plus bounded aggregate diagnostics, is sent.

Timing summaries, each as a mean plus a mean absolute deviation:

- Key hold time (dwell)
- Flight time, from one key release to the next key press
- Key interval (down-to-down)
- Pointer velocity
- Pointer acceleration
- Pointer direction change

Burst and pause structure, derived from inter-keydown gaps alone:

- The share of gaps that are thinking pauses rather than in-burst typing. A gap
  of 500 ms or more is a pause; a gap of 60 s or more is the user walking away
  and counts as neither.
- The mean in-burst gap

Key-class transition timing — six numbers, each saying how much slower or
faster one coarse class of transition runs than the same person's own in-burst
average:

- Same-hand transitions
- Alternating-hand transitions
- Vowel to consonant
- Consonant runs
- Word boundaries (space, Enter, Tab)
- Symbols and digits

Separately, a bounded page-level summary is sent with a login or a check: word
counts and per-word character counts (from a mask in which every non-space
character has already been replaced with `x`), typing duration, cadence, pause
and burst counts, correction, deletion, replacement and rollback counts,
viewport and screen size, pixel ratio and visual-viewport scale, focus,
visibility, resize and orientation-change counts, page-wide event and scroll
counts, and time spent in each view.

### The raw-key promise

**The browser never sends key identities, keycodes, raw key events, or typed
text.** This is verified in the code and it must stay true.

The key-class features deserve a precise statement rather than a comfortable
one. Each keydown *is* read at collection time and immediately reduced to one
of eight coarse classes — other, whitespace, digit, symbol, left consonant,
left vowel, right consonant, right vowel. The key itself is discarded in the
same statement that produced the class, is never stored, and never leaves
`classifyKey()`. Twenty-six letters share four buckets, so a class carries
about two bits and a transition pair about four — and even that is only ever
released as a mean over an entire window of keystrokes, not as a sequence. An
aggregate of that shape cannot be inverted into a key, a keycode, or text.

The browser does not send:

- Typed text, in any field, in any form
- Passwords, recovery codes, session credentials, or CSRF credentials
- Key identities, keycodes, or raw key events
- Raw cursor coordinates or full pointer paths
- Cookies, a persistent visitor identifier, or the user-agent string

Browser-supplied diagnostics are reporting context, not trusted authorization
inputs. A direct API client can forge them; the server treats them as
supporting evidence only.

The mockup serves a different origin, so `mockup_website/app.js` carries its
own copy of the collector rather than importing this one. The two are kept to
the same twenty features with the same semantics; if you change one, change
both.

## What this can and cannot separate

Typing timing is the load-bearing signal. Mouse-only data distinguishes people
far more weakly: pointer velocity, acceleration, and direction-change
distributions overlap heavily between people, and they move with the input
device, the surface, the pointer-acceleration setting, and the task far more
than key timing does. A session in which someone only moves and clicks
exercises almost none of the discriminative path, which is why the demo bot is
written to type into the order ticket rather than only navigate.

The acceptance threshold is derived from a five-sample enrollment set and has
not been calibrated against a representative population. Treat it as a demo
heuristic, not a biometric accuracy claim. Accessibility tools, injury,
hardware changes, fatigue, language, practice, and mobile input can all cause
false warnings, and skilled automation can evade the current signals.

## Security architecture

- Scrypt password hashing with independent random salts
- Opaque server sessions and session-bound CSRF credentials
- Same-origin checks for state-changing requests, and a `default-src 'self'`
  content security policy
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
server-created aggregate report — a decision band, a coarse trust band, reason
codes, and up to 24 named feature directions — after an authenticated user
explicitly requests an explanation. The request excludes typed text,
identifiers, network data, device data, and raw events; an unexpected field is
rejected before transport. Provider output cannot change a score, threshold,
grant, profile, session, device association, or authorization decision, and the
adapter always returns `authorizationDecision: null`.

The endpoint is correct. The adapter posts to
`https://generativelanguage.googleapis.com/v1beta/interactions`, which is the
current Gemini Interactions API; `generateContent` is the legacy path. Storage
and background execution are both disabled, and the key travels in the
`x-goog-api-key` header, never in the URL.

The locally configured key was rejected with HTTP 401 during the July 25, 2026
validation. **That is a credentials or project-access problem, not a wrong
URL** — a wrong path returns 404, not 401. The endpoint needs no change. Gemini
should be treated as unavailable until the provider-side authorization is
corrected and a safe synthetic check succeeds. Without a configured key the
provider reports `disabled`, the explanation route answers 501, and the
application continues normally.

Note that the "Explain this result" control is part of the hidden
session-consistency card, so the explanation route is currently not reachable
from the console UI at all.

## Hugging Face status

The Hugging Face anomaly adapter is **wired for readiness only and is never
invoked.** `analyze()` has no call sites in `server.js`, `src/`, or `scripts/`;
the only callers anywhere are three unit tests. Calling it "shadow mode"
overstates it — there is no shadow path, because nothing runs and nothing is
recorded. The adapter's `shadowOnly: true` and `grantEffect: "none"` labels
describe what its output *would* be if some future call site existed.

Do not list `hugging_face` in `ODYSSEUS_REQUIRED_PROVIDERS`. Neither it nor
`gemini` can report ready before a first successful live call, so requiring
either would pin `/api/ready` at 503 forever. `server.js` currently strips both
names out of that variable defensively, so the only value it accepts in
practice is `turnstile`.

## Run locally

Requirements:

- Node.js 24 or newer
- A supported Chromium or Firefox browser for browser tests

Install:

```powershell
npm ci
```

Start the engine, and the mockup site in a second terminal:

```powershell
npm start          # Odysseus on http://127.0.0.1:3000
npm run mockup     # OptionsFlow on http://127.0.0.1:4000
```

**Both servers must be running.** The mockup holds no accounts; with Odysseus
down, sign-in, signup, and password reset return "The account service is not
running. Start it with npm start, then try again." Static pages still load, and
telemetry uploads fail silently by design.

Open `http://127.0.0.1:4000` for the demo site, or `http://127.0.0.1:3000` for
the console. The seeded demo account is `username` / `password`.

The demo bot drives the mockup in a visible browser window:

```powershell
npm run bot
```

It types the credentials character by character, then opens ticker cards and
fills the order ticket, because the quantity and limit fields are the only
keyboard source on that page. **It must reach the site over HTTP** — sign-in,
recovery, and telemetry upload are all same-origin `fetch` calls that fail from
a `file://` page. `MOCKUP_ORIGIN`, `LOGIN_USER`, `LOGIN_PASS`, and `SLOW`
configure it.

The mockup reads only process environment variables, not `.env`; `MOCKUP_PORT`,
`MOCKUP_HOST`, and `ODYSSEUS_ORIGIN` override its defaults.

Run the automated suites:

```powershell
npm test             # node:test unit and integration suites
npx playwright test  # e2e, starts its own server on port 3217
```

The Playwright config starts an isolated Odysseus instance on port 3217 with a
temporary database, so it does not disturb a running demo on 3000 or 4000.

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

The demo also still lacks a server-issued, single-use behavior challenge, so a
direct API client can forge or replay a browser summary. Before production,
every sample needs a nonce, account and profile binding, short expiry,
single-use consumption, and duplicate-evidence detection.

See [SECURITY.md](SECURITY.md), [roadmap.md](roadmap.md),
[docs/DETECTION-AND-SECURITY-REPORT.md](docs/DETECTION-AND-SECURITY-REPORT.md),
and [docs/GEMINI-INTEGRATION.md](docs/GEMINI-INTEGRATION.md) for the detailed
boundaries and planned work.
