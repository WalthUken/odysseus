# Odysseus identity, automation, and security report

Review date: July 25, 2026

## Executive summary

Odysseus now exposes two separate demo assessments:

1. Identity similarity asks whether a returning interaction resembles the
   selected account baseline.
2. Automation risk asks whether the interaction contains patterns associated
   with scripted or agent-driven input.

This separation is essential. Human B can be a real person and still differ
from Human A. An automated agent can attempt to imitate Human A. A repeat from
Human A can also drift because of fatigue, injury, hardware, accessibility
tools, stress, practice, or time.

Neither assessment proves legal identity, humanity, intent, account ownership,
or fraud. Passwords, passkeys, recovery controls, and server policy remain the
real authorization factors.

The local demo now supports:

- The new dark market-terminal frontend with separate dashboard, session, and
  account-security views
- Human A enrollment as Report 1
- Human A returning-session comparisons
- Human B returning-session comparisons
- An Automated agent comparison label
- Separate similarity and automation-risk results
- A local `/admin` report that shows baseline centers, variation, scales,
  thresholds, comparisons, and audit outcomes
- Account-name plus local admin-code access to that report
- A local `/admin/test` flow that can strengthen Human A's active demo
  fingerprint from three trusted, matching samples
- Credential-burst and password-spray limiting with explicit automation flags
- Numbered route boxes that make the intended target clear

The subject label is display and evaluation metadata only. It never changes a
score, threshold, grant, or authorization decision.

## Current operational status

| Component | Current status | Security role |
| --- | --- | --- |
| New market-terminal frontend | Working | Current demo interface for all account and session flows |
| Password authentication | Working | Primary account factor |
| Passkeys | Implemented | Strong account factor |
| Behavioral baseline | Working | Secondary identity-similarity signal |
| Human A versus Human A | Working | Compare a labeled repeat with Report 1 |
| Human B versus Human A | Working | Compare a labeled Human B session with Report 1 |
| Automation-risk estimate | Working | Separate reporting plus login denial at high risk |
| Credential burst defense | Working | Blocks fast password attacks and records bot-risk flags |
| Local `/admin` report | Working when configured | Local demo inspection only |
| Local `/admin/test` report | Working when configured | Three-sample Human A comparison with guarded, bounded baseline strengthening |
| Gemini explanation | Code path works, provider returns HTTP 401 | Advisory explanation only |
| Hugging Face anomaly adapter | Implemented but disabled and not invoked | Future shadow experiment |
| Turnstile | Not configured | Optional server-validated human assurance |
| Redis | Not configured | Needed for shared multi-instance limits |
| PostgreSQL | Contract only | Production persistence with forced RLS |

## Demo protocol

### Human A enrollment and repeat

1. Start Odysseus and open `/`.
2. Create an account. `test06` is acceptable only as a local demo password.
3. Leave the subject label on `Human A`.
4. Complete five enrollment rounds. These create the active behavioral
   baseline, shown as Report 1 in the local admin viewer.
5. Complete a returning-session check with `Human A` still selected.
6. Review identity similarity and automation risk as separate results.

This is the Human A versus Human A repeat test. Run it across multiple sessions,
days, devices, and conditions to measure normal within-person variation.

Once an account has Report 1, a later password login must include fresh
behavior evidence. A close Human A repeat with human-like automation evidence
can create a session. Missing evidence does not bypass the fingerprint check.
A new account with no report is the only `baseline_missing` case, because it
must be allowed to reach enrollment.

### Human B comparison

1. Keep the same enrolled Human A account and baseline.
2. Select `Human B`.
3. Have Human B complete a returning-session check.
4. Compare its normalized distance and feature differences with the Human A
   repeat.

A sufficiently different Human B interaction is classified as
`suspicious_identity`. The demo does not create an authenticated session and
shows a simulated network restriction warning. The warning must say that it is
simulated. Its contract is `displayed: true` and `enforced: false`. No firewall,
router, operating-system, proxy, database, or real IP block is changed.

Sharing one account credential is acceptable only for this controlled local
experiment. It is not an acceptable production test design. A production study
should use a consented evaluation ceremony that lets Human B submit a test
sample without learning Human A's password.

### Automated agent comparison

1. Select `Automated agent`.
2. Run the chosen automation harness.
3. Record whether the browser accepts the interaction, the automation-risk
   result, and the identity-similarity result.

An `automation_likely` login is denied even if its submitted feature vector is
close to Human A. It receives no session and cannot strengthen the template.
This policy demonstrates two independent axes: identity similarity can say
"close" while automation risk still says "likely automated."

Basic script-dispatched events are rejected because their browser `isTrusted`
flag is false. Advanced browser automation can still create trusted events,
call the API directly, imitate timing distributions, or operate through a real
browser. Browser event trust is therefore one weak signal, not proof.

### Local admin report

1. Open `/admin` on the same computer.
2. Enter the target account username.
3. Enter that account's sign-in password.
4. Prepare the report.

The viewer takes the same credentials as the sign-in page. `.env` still gates
whether the viewer exists at all through `ODYSSEUS_DEMO_ADMIN_BYPASS`, but that
value is now only an on/off switch and is never accepted as a credential. The
route is rejected in production and for non-loopback clients. It is CSRF
protected, rate limited, audited, marked `no-store`, and does not create an
admin session.

Password authentication means an account reads only its own saved report. This
remains a local demo convenience and is not a production administrator design:
it grants the full record dump to anyone holding the account password on this
machine.

The report deliberately omits passwords, password hashes, session credentials,
CSRF credentials, device fingerprint digests, passkey keys, encrypted
ciphertext, encryption keys, typed content, and raw events.

### Stronger local report

1. Open `/admin/test` on the same computer.
2. Enter the target account name and that account's sign-in password.
3. Select the saved profile and label the test as Human A, Human B, or
   Automated agent.
4. Complete three fresh rounds in the new interface.
5. Review the aggregate similarity, all three sample decisions, automation
   assessment, and feature-level averages.
6. Return to `/admin` to see the saved stronger report in that account's
   history.

The stronger report compares each sample independently with Report 1 and then
summarizes the three results. The samples can strengthen the active demo
template only when every sample matches the existing baseline and every
automation assessment is
`human_like_interaction`. Strengthening uses the bounded template-evolution
algorithm. It does not issue a login session or loosen the acceptance
threshold. Mixed, distant, or automation-risk samples remain report-only and
cannot amend the template. The Human A, Human B, and Automated agent selectors
are experiment labels only. They never change a score, decision, or
strengthening eligibility.

## Finalized behavioral login lifecycle

The intended local demo lifecycle is:

1. Person A creates an account and completes five enrollment samples.
2. The server creates encrypted Report 1 for that account.
3. `/admin/test` can collect three additional Person A samples.
4. The server evaluates identity similarity and automation risk independently.
5. Only a fully matching, human-like batch can make a small bounded amendment
   to the active template, regardless of its display label.
6. A later password login for an enrolled account must carry fresh behavior
   evidence for the selected profile.
7. A close, human-like Person A repeat is allowed.
8. A close repeat becomes a bounded reinforcement candidate only after the
   password is valid, the evidence is sufficient, identity similarity allows
   it, and automation risk is human-like.
9. Human B is treated as suspicious identity, receives no session, and sees a
   simulated-only restriction warning.
10. An automated interaction is denied, receives no session, and cannot
    become training data.
11. `/admin` exposes a redacted account report after local account-name and
    admin-code authorization.

The password answers "does the caller know the account credential?" Identity
similarity answers "does this interaction resemble the saved account
baseline?" Automation risk answers "does this interaction contain
automation-like evidence?" None of these questions substitutes for the other
two.

### Decision and amendment matrix

| Baseline state | Identity result | Automation result | Login result | Template result |
| --- | --- | --- | --- | --- |
| Missing on a new account | Not available | Not available | Continue to enrollment | No amendment |
| Present, evidence missing | Not evaluated | Insufficient evidence | Review, no session | No amendment |
| Present | Close | Human-like | Allow | Pending or bounded trusted reinforcement |
| Present | Different | Human-like | Suspicious warning, no session | No amendment |
| Present | Close or different | Automation likely | Deny, no session | No amendment |
| Present | Any uncertain combination | Elevated or insufficient | Review, no session | No amendment |

`review` is fail-closed for session creation in this demo. It is not a silent
allow.

### Thresholds and bounds

Identity matching uses each template's calibrated Scaled Manhattan Distance
threshold. The threshold is derived from the small enrollment set and has not
been calibrated on a representative population. It must be treated as a demo
heuristic, not a biometric accuracy claim.

Automation risk is currently:

- Low below 40
- Elevated review from 40 through 69
- High and `automation_likely` from 70 through 100

The password-login reinforcement path uses:

- One sufficiently evidenced `trusted_return`
- At least 10 dwell samples, 8 flight samples, 8 down-down samples, and 8
  pointer samples before each corresponding feature family is eligible
- At least four compared features and at least two available feature families,
  unless the enrolled template itself contains fewer
- Candidate distance no greater than 0.75 times the acceptance threshold
- Learning rate of 0.01
- Per-login mean movement capped at 0.02 of the original feature scale
- Cumulative movement capped at 0.25 of the original enrollment anchor scale
- Movement only for features that had enough samples and were actually
  compared
- No scale or acceptance-threshold change

The `/admin/test` strengthening path uses:

- Exactly three matching, sufficiently evidenced, human-like samples
- At least 10 dwell, 8 flight, 8 down-down, and 8 pointer samples in every
  round
- A robust consistency filter across the batch
- Learning rate of 0.08
- Candidate distance no greater than the acceptance threshold
- Per-update mean movement capped at 0.25 of the prior feature scale
- Per-update scale movement capped to five percent
- No acceptance-threshold change

The authenticated-session drift path separately requires at least three
distinct, strongly verified, internally consistent sessions. Its default
candidate envelope is 1.25 times the acceptance threshold.

These constants reduce risk but are not scientifically validated operating
points. Accessibility tools, injury, hardware changes, fatigue, language,
practice, and mobile input can cause false warnings. Skilled automation can
also evade the current signals.

### Poisoning and replay rules

The active template must never learn directly from:

- Identity mismatches
- Elevated, high, or missing automation evidence
- Missing behavior evidence
- Failed passwords
- Replayed or duplicated samples
- Samples from a transferred profile awaiting recalibration

The current bounded update logic protects against distant and inconsistent
samples, but the demo still lacks a server-issued, single-use behavior
challenge. A direct API client may forge browser summaries or replay a
previously accepted vector. Before production, every sample needs a nonce,
account and profile binding, prompt and route binding, short expiry,
single-use consumption, and duplicate-evidence detection.

### Demo and production boundary

The simulated network restriction is a presentation-only warning. It does not
ban an address. The shared local admin code, cohort selector, in-place active
template amendment, and direct sharing of Person A's credentials with Person B
are also demo mechanisms. They are not production security designs.

Production needs immutable template versions, quarantined candidates,
promotion and rollback, user notification, formal review, calibrated cohort
thresholds, replay-resistant ceremonies, shared rate limiting, strong
administrator authentication, and forced RLS. RLS must never be disabled.

## What the similarity model measures

Odysseus uses Scaled Manhattan Distance. For each enrolled feature:

1. Calculate the baseline center.
2. Calculate ordinary enrollment variation.
3. Define a normalization scale that does not collapse to zero.
4. Measure the absolute difference between the current value and baseline.
5. Divide that difference by the feature scale.
6. Add the normalized feature differences.
7. Divide by the feature count to get normalized distance.

The active report exposes:

- Baseline center
- Normal variation
- Normalization scale
- Current value
- Difference from baseline
- Normalized distance
- Acceptance threshold
- Step-up threshold
- Trust percentage
- Contributing reason codes

Lower normalized distance means closer to the baseline. The trust percentage is
a monotonic presentation of that distance. It is not a statistical probability
that the person is Human A.

### Useful Human A versus Human A indicators

- Stable key-hold center with ordinary variation
- Stable transition and key-interval centers
- Similar pause and burst structure
- Similar aggregate pointer velocity
- Similar pointer acceleration and direction-change distributions
- Similar behavior across multiple days, not just one session
- Similarity that remains acceptable after ordinary device and posture changes

### Useful Human A versus Human B indicators

- Several feature differences moving in the same direction
- Normalized distance beyond Human A's repeat-session distribution
- Stable separation across multiple sessions
- Differences that persist after device, task, fatigue, and accessibility
  factors are controlled

One Human B trial is not enough. A good study needs many Human A repeats and
many impostor comparisons. Without those cohorts, the current threshold is a
starter heuristic.

## Automation and agent detection

### Bot versus agent

A bot is usually deterministic or narrowly scripted. It repeats an action,
submits requests, or drives a browser according to fixed rules.

An agent can perceive state, plan, call tools, recover from errors, answer
questions, and adapt its behavior. An AI browser agent is a more capable subset
of automation. It can still use a simple bot underneath for clicks or requests.

The practical difference is adaptability, not a clean technical boundary.
Detection should therefore score observable behavior and request patterns
instead of trying to label the underlying software architecture with certainty.

### Signals implemented now

The current deterministic automation assessment reviews:

- Missing aggregate typing diagnostics
- Missing browser event-integrity evidence
- Script-dispatched events rejected by the browser collector
- Trusted-event checking being disabled
- Page-wide keydown, keyup, input, repeat, deletion, correction, and undo counts
- Page-wide pointer movement, distance, down, up, click, and context-menu counts
- Scrolling event counts and aggregate distance
- Aggregate interaction-delay mean, variation, and maximum
- Browser scale changes and time spent in each application view
- Inconsistencies between whole-page counts and the submitted challenge sample
- Impossibly or unusually short task duration
- Impossibly or unusually high input cadence
- Input count inconsistencies
- Implausibly short average key holds
- Extremely low variation across several keyboard timing families
- Extremely low pointer velocity and direction-change variation
- An unusually short telemetry window

The result is one of:

- `human_like_interaction`
- `elevated_review`
- `automation_likely`
- `insufficient_evidence`

An `automation_likely` result cannot issue a behavior grant or login session.
It does not claim fraud, prove that an agent was responsible, disable the
account, or create a real network ban.

The version 2 whole-page summary is bounded and text-free. It excludes key
identities, input content, raw pointer coordinates, user-agent strings,
cookies, tokens, and persistent browser identifiers. It is still
browser-reported data, so a direct API client can forge it. The server treats
it as supporting evidence, never as proof.

### High-value additions

#### Server-issued challenge ceremonies

- Issue an unpredictable server nonce for every check.
- Bind prompt, route, expected task order, account, session, and expiry to it.
- Make the ceremony short-lived and single-use.
- Reject replayed, expired, cross-account, or out-of-order submissions.
- Store only bounded outcome evidence.

This closes the current direct-API gap better than adding more browser-only
checks.

#### Sequence and timing evidence

- Time from challenge issue to first action
- Time between task transitions
- Ordering mistakes and recoveries
- Pointer overshoot, correction, hesitation, and submovement structure
- Key timing autocorrelation and spectral regularity
- Cross-round repeated timing templates
- Reused vectors or nearly identical diagnostics
- Reused challenge responses
- Event timestamps inconsistent with server elapsed time

#### Browser and runtime integrity

- WebDriver and headless indicators as weak signals
- Focus, visibility, navigation, resize, and permission anomalies
- Browser feature-consistency checks
- Automation extension or debugging-protocol indicators
- Attestation on platforms that support it
- Detection of direct API clients that never complete a browser ceremony

These signals are spoofable and can affect privacy or accessibility. They
should be coarse, consented, retention-limited, and never the only control.

#### Human assurance

- Server-validated Turnstile with exact action and hostname
- User-verified WebAuthn for enrollment
- Single-use enrollment ceremony
- Accessible alternative challenge
- Manual review lane for uncertain cases

A challenge provider can reduce automation risk. It still cannot prove that the
same person who solved the challenge produced all later input.

#### Semantic tasks

The current subtle account, stock, and security-style questions diversify free
typing without storing the answer text. They can help collect a more natural
cadence sample. They are not a reliable AI detector because an agent can answer
them.

If semantic evaluation is added, do not transmit private free text by default.
Prefer local extraction of coarse properties such as response length, edit
count, time-to-start, and revision pattern. Content-based AI detectors have
high error rates and should not control authorization.

#### Numbered boxes

Visible `Box 1` through `Box 9` labels improve task clarity and accessibility.
The highlighted target records movement between changing locations.

The labels are not a security secret. An agent can read the DOM and find the
active box. The useful evidence is route timing, movement shape, corrections,
challenge freshness, and replay resistance.

## Credential attack protection

The login and password step-up paths now have three layers:

| Dimension | Default limit | Purpose |
| --- | --- | --- |
| Network burst | 10 attempts per 2 seconds | Stop very fast tools before repeated scrypt work |
| Target account | 10 attempts per 15 minutes | Slow password spraying against one account across networks |
| Network sustained | 20 attempts per 15 minutes | Bound broader authentication traffic |

The eleventh attempt in a two-second burst is blocked with HTTP 429, so a tool
attempting 100 passwords in two seconds is stopped before reaching 100.

The first blocked request and every fiftieth continued request record an
`auth.automation_flag` audit event with:

- `CREDENTIAL_BURST_AUTOMATION` or `ACCOUNT_PASSWORD_SPRAY`
- `likely_automated` classification
- Request count
- Configured maximum
- Window length
- Retry duration
- Server-observed network address

The public error remains generic and does not reveal whether the account
exists.

### Remaining credential risks

- The default in-memory store protects one process only.
- Distributed attacks can rotate IP addresses.
- Incorrect trusted-proxy configuration can collapse or spoof network keys.
- IPv6 attackers can rotate addresses within a prefix.
- A successful login resets the target-account limiter.
- Recovery, passkey, and registration abuse need coordinated risk policy.
- The current audit table is not optimized for high-volume security events.

Production should use Redis with atomic multi-key limits, controlled proxy
configuration, account and network prefix keys, ASN and hosting-provider
reputation, breached-password screening, passkey preference, notification
deduplication, and a security-case workflow.

## Current database inventory

The local SQLite schema currently contains:

| Table | Purpose | Important sensitivity |
| --- | --- | --- |
| `users` | Account identity and scrypt password hash | Credential verifier |
| `sessions` | Hashed session and CSRF credentials, grants | Active authorization |
| `behavior_profiles` | Encrypted behavioral template and metadata | Behavioral biometric |
| `audit_events` | Security outcomes and bounded aggregate metadata | Account and network history |
| `devices` | Hashed device token and account-scoped fingerprints | Device continuity |
| `webauthn_credentials` | Passkey public credentials and counters | Strong authenticator metadata |
| `webauthn_challenges` | Hashed single-use WebAuthn ceremonies | Replay defense |
| `recovery_codes` | Hashed recovery codes | Recovery authorization |
| `recovery_requests` | Hashed recovery tokens and state | Recovery workflow |
| `security_notifications` | In-app security notices | Incident communication |
| `profile_transfers` | Cross-device template transfer state | Behavioral profile movement |
| `device_profile_links` | Device to profile relationships | Ownership join |
| `app_metadata` | Runtime metadata | Operational configuration |
| `schema_migrations` | Applied schema versions | Migration integrity |

No live local database existed at the start of this review. The findings are
based on the migration definitions, repository tests, and a new test database.

## Database additions recommended

### Immutable baseline versions

Add `behavior_profile_versions` with:

- Account ID
- Stable profile ID
- Version number
- Encrypted template
- Template key version
- Created time
- Source enrollment ceremony
- Status such as active, retired, quarantined, or rolled back
- Previous version
- Promotion reason
- Rollback reason

The local demo currently amends its active template in place after guarded
Human A evidence. Production should not do that. Preserve Report 1 as a
known-good immutable version and promote each accepted amendment as a new
version that can be audited and rolled back.

### Verification reports

Add an immutable `verification_reports` table with:

- Account and profile version
- Pseudonymous session reference
- Claimed demo cohort label
- Deterministic decision
- Normalized distance
- Threshold version
- Coarse feature differences
- Automation assessment reference
- Device context reference
- Human-assurance state
- Challenge instance
- Created time

Keep raw text, raw events, credentials, and full pointer paths out.

### Automation assessments

Add `automation_assessments` with:

- Verification report ID
- Detector version
- Risk level
- Reason codes
- Coarse evidence
- Policy effect
- Review outcome
- False-positive feedback

This makes it possible to change detectors without rewriting historical
results.

### Authentication security events

Add a high-volume, retention-limited `authentication_attempts` or external
security-event stream with:

- Pseudonymized target key
- Pseudonymized network prefix
- Device or client key when available
- Route
- Outcome category
- Rate-limit dimensions
- Detection reason codes
- Server timing
- Expiry or retention partition

Do not store submitted passwords. Avoid storing raw unknown usernames when a
keyed digest is sufficient.

### Challenge instances

Add `behavior_challenges` with:

- Random challenge ID
- Account and session binding
- Prompt and route version
- Issued, started, expires, and consumed times
- Single-use state
- Server nonce digest
- Completion and rejection codes

This is the most important missing control for direct API and replay attacks.

### Candidate and quarantine records

Add:

- `behavior_profile_candidates`
- `behavior_sample_quarantine`
- `profile_promotions`
- `profile_rollbacks`

Automated, denied, uncertain, replayed, or distant samples must never train the
active baseline.

### Security cases and review

Add `security_cases` and `security_case_events` for:

- Credential attacks
- Account recovery anomalies
- Device changes
- Baseline poisoning attempts
- Repeated automation flags
- Analyst decisions
- User notifications
- Resolution and retention

## RLS review

RLS remains mandatory. It was not disabled or weakened.

The PostgreSQL artifact enables and forces RLS on its listed account tables and
forbids an application role that bypasses RLS. That direction is correct.

### Deployment blocker: join-table ownership mismatch

`device_profile_links` is included in the PostgreSQL account-table list, and
the generic policy references `device_profile_links.user_id`. The current
SQLite table definition does not contain a `user_id` column. Its ownership is
available only through joins to devices and behavior profiles.

The generic PostgreSQL policy will therefore not work as written unless the
PostgreSQL schema adds and verifies `user_id`, or the table receives a
join-based ownership policy. A direct `user_id` column with foreign keys and
consistency constraints is easier to audit.

### `users` access requires an explicit design

`users` is not in the listed account-scoped RLS tables. This may be intentional
because login performs a username lookup before an account context exists. It
still needs a least-privilege production design, such as:

- A narrow credential lookup function that returns only what password
  verification needs
- An application role without arbitrary user-table reads
- Separate authenticated self-service policies
- Audited administrator functions

### Nullable account references

Audit and WebAuthn challenge records can have nullable user IDs. Ordinary
account policies will intentionally hide null-owned rows. Global abuse
aggregation needs a narrow security-definer function or separate security
event service. Do not give the application role `BYPASSRLS`.

### Production administrator reports

The local `/admin` route is deliberately unavailable in production. A
production per-account report should require:

- An immutable administrator account ID
- User-verified WebAuthn
- A case or purpose identifier
- Short-lived authorization
- Just-in-time privilege
- Complete audit
- User notification where appropriate
- Field-level redaction
- An RLS-safe security-definer function or separate privileged service

Never implement it by disabling RLS.

## Hugging Face component

The Hugging Face code is an adapter for an optional anomaly model. It does not
train a model and currently does not run during enrollment or verification.

### Plain-language answer

Right now, the Hugging Face component does no detection for a person using the
demo. It does not watch typing, compare Human A with Human B, identify an
agent, change a login result, strengthen a fingerprint, or send any data
because no application route calls it.

What exists is a guarded connector that could send a small, already-aggregated
local report to a separately configured HTTPS inference endpoint. If that
future endpoint returns a valid anomaly label, Odysseus marks the result as
shadow-only advice. The local deterministic decision has already been made,
and the Hugging Face result is not allowed to authorize or deny anything.

It is not a bundled model. It has no training dataset, model weights, fine
tuning, background learning, or browser-side Hugging Face code. Setting a
token alone does not make it work. An endpoint with the exact expected input
and output contract must also be deployed and then explicitly connected to an
application call site.

### Intended input

The adapter accepts only:

- Report version
- Aggregate distance
- Local deterministic decision
- One to 32 named normalized feature differences

It rejects extra fields, identifiers, free text, raw events, and out-of-range
numbers before transport.

### Network boundary

The endpoint must:

- Use HTTPS
- Use an approved Hugging Face host or dedicated endpoint host
- Contain no embedded username, password, query, or fragment
- Return within three seconds
- Return no more than 128 KB

An optional token is sent in the Authorization header. The request disables
cache use and does not wait for a cold model.

### Required response

The endpoint must return one exact object:

```json
{
  "anomalyScore": 0.82,
  "label": "anomalous",
  "modelVersion": "shadow-1"
}
```

Allowed labels are `normal`, `anomalous`, and `uncertain`. Extra authorization
fields cause rejection.

### Policy boundary

Every result is labeled:

- `shadowOnly: true`
- `grantEffect: none`
- `advisoryOnly: true`
- `authorizationDecision: null`

Provider success, failure, timeout, or malformed output cannot change a grant,
threshold, session, profile, device, or password decision.

### Actual current state

No Hugging Face endpoint or token is configured in the current environment.
The server exposes readiness only. No application path calls `analyze()`.

To evaluate it safely:

1. Deploy a custom endpoint that returns the exact required object.
2. Keep it in shadow mode.
3. Invoke it after the local decision is finalized.
4. Store only a bounded pseudonymous evaluation record.
5. Compare disagreement, false positives, false negatives, drift, cost, and
   latency.
6. Do not show it to users or affect policy until independently validated.
7. Add a kill switch, concurrency limit, daily budget, and retention policy.

I am unsure whether an off-the-shelf Hugging Face pipeline will return the
adapter's exact object. A custom inference handler is likely required.

## Gemini component

Gemini is an explicit, advisory explanation renderer. The server builds a
strict coarse report from an owned finalized verification event. It does not
accept client-provided scores, thresholds, reason codes, identifiers, free
text, device data, or network data.

The adapter:

- Uses the Interactions API
- Keeps the key in a request header
- Sets storage and background execution to false
- Requests strict JSON
- Validates the output schema
- Rejects authorization language
- Returns `authorizationDecision: null`

A fresh synthetic check on July 25, 2026 returned HTTP 401. The key and model
are present in the process environment, but the provider did not authorize the
request. I am unsure whether the key is invalid, restricted to another API or
project, or lacks access to the selected model. No key or response body was
written to the repository.

Gemini should remain treated as unavailable until a privacy-safe synthetic
request succeeds.

## Evaluation design

Collect consented sessions in separate cohorts:

- Human A enrollment
- Human A genuine repeats
- Human B and other human impostors
- Basic scripts
- Browser automation
- Adaptive AI agents
- Accessibility tools
- Mobile and touch users
- Device changes
- Fatigue, injury, stress, and long-term drift

For identity similarity, report:

- False acceptance rate
- False rejection rate
- Equal error rate
- Abstention rate
- Threshold confidence interval
- Performance by device and accessibility cohort

For automation risk, report:

- Precision and recall
- False-positive rate on humans
- Detection rate by automation family
- Evasion success
- Calibration by risk band
- Added latency
- Provider disagreement when shadow models are used

Do not train and test on repeated samples from the same session. Split by
person, session, day, device, and automation family to prevent leakage.

## Prioritized next work

### Priority 0: required before production

1. Fix and test the PostgreSQL RLS ownership mismatch.
2. Add server-issued single-use behavior challenge ceremonies.
3. Add immutable baseline versioning, quarantine, promotion, and rollback.
4. Require passkey or server-validated human assurance for enrollment.
5. Move rate limits to Redis and security data to PostgreSQL with forced RLS.
6. Add high-volume abuse event storage and alert deduplication.
7. Complete representative calibration and accessibility evaluation.
8. Complete independent privacy, security, and penetration reviews.

### Priority 1: best next demo improvements

1. Show top normalized feature contributions in the ordinary account report.
2. Add challenge replay and duplicate-vector detection.
3. Add baseline Report 1 immutability in the local schema.
4. Add export of de-identified experiment results.
5. Add a controlled Hugging Face shadow evaluation route.
6. Fix Gemini provider authorization or keep the panel disabled.

### Priority 2: research

1. Sequence models over bounded text-free timing summaries
2. Pointer submovement and correction models
3. Cross-session drift and change-point detection
4. Agent-family and tool-family evaluation
5. Privacy-preserving aggregation and shorter retention
6. Per-cohort threshold fairness and accessibility studies

## Final assessment

The demo can now demonstrate the intended distinction:

- Human A versus Human A measures repeat similarity.
- Human B versus Human A measures cross-person separation.
- Human or agent likelihood is assessed independently as automation risk.
- Fast password tooling is blocked and explicitly flagged.
- The local admin viewer exposes the actual baseline values and comparisons
  needed to explain the result.
- The stronger local test can make a bounded score-qualified amendment without
  issuing authorization, while all suspicious or automated samples remain
  report-only.
- Human B and automated login attempts receive no session and cannot poison
  the template.
- Any network-restriction warning is explicitly simulated and never enforced.

The largest remaining security gaps are server-issued replay-resistant
ceremonies, immutable baseline history, production shared infrastructure,
representative calibration, and the PostgreSQL RLS join-table mismatch.
