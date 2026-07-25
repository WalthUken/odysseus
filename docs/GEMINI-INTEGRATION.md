# Odysseus Gemini Integration Audit and Rollout Plan

Date: 2026-07-25

## Executive finding

The optional advisory path is connected but remains outside authorization.

- The server builds the provider from server-side environment configuration.
- Gemini is not a required readiness provider.
- The account-management endpoint accepts only an optional owned `profileId`.
- The server resolves the latest finalized behavior audit for that account.
- A fixed allowlist converts that record into a bounded aggregate report.
- Client scores, thresholds, decisions, signals, and narratives are rejected.
- The adapter uses the Interactions API with `store: false` and
  `background: false`.
- The key is sent only in the `x-goog-api-key` header.
- Provider output remains advisory with `authorizationDecision: null`.

The endpoint is correct.
`https://generativelanguage.googleapis.com/v1beta/interactions` is the current
Gemini Interactions API; `generateContent` is the legacy path. Nothing in this
document should be read as saying the URL is wrong or broken.

Without a key, the endpoint reports a disabled provider and the rest of the
application remains operational. The user-level key tested on July 25, 2026
returned HTTP 401 and remains outside the repository. **HTTP 401 is an
authorization result, not a routing result: a wrong path returns 404.** The
problem is on the credential or project-access side, and the request URL needs
no change. Gemini must be considered unavailable until the provider-side
authorization setup succeeds.

One further correction to earlier drafts of this document: the browser no
longer calls the provider after an explicit user action, because there is no
longer an action to take. The "Explain this result" control sits inside the
session-consistency card, which is now permanently hidden along with every
other behavioral verdict surface. `public/account.js` still binds the control,
but a user cannot reach it, so the explanation route is unreachable from the
console UI. Any rollout gate below that assumes a visible advisory panel is
blocked on that product decision, not on the provider.

## Current implementation inventory

| Area | Current state | Production target |
|---|---|---|
| Runtime provider call | Optional and explicit | Keep disabled by default |
| Adapter | Interactions API | Pin and revalidate API revision |
| Active API route | Server-owned account audit input | Add full coarse privacy projection |
| Environment configuration | Server-only key and model | Add mode, cost, and concurrency controls |
| Readiness | Optional provider state | Preserve optional status |
| Browser UI | Control bound but permanently hidden; route unreachable from the UI | Keep hidden unless the disclosure decision is revisited |
| Unit tests | Transport, validation, and route tests | Expand policy-invariance coverage |
| Authorization effect | Always null | Preserve as an architectural invariant |

## Existing strengths worth preserving

The branch scaffold already includes several good controls:

- The API key is sent in the `x-goog-api-key` header instead of the URL.
- Inputs and outputs use exact-key validation.
- Structured JSON output is requested.
- Response sizes and field lengths are bounded.
- Provider timeouts are enforced.
- The output is explicitly labeled as AI-generated and advisory.
- Authorization language is rejected.
- Disabled provider state does not prevent the application from becoming ready.
- Monitoring records provider outcomes without needing prompt content.
- Tests prove that unknown input keys are rejected before network transport.
- Tests prove that an attempted access decision is rejected.

These controls are necessary, but they are not sufficient for production enablement.

## Remaining work before production enablement

### 1. Provider mode and cost controls are incomplete

Add explicit `off`, `shadow`, and `visible` modes, a global kill switch,
concurrency limits, daily cost controls, and internal-account rollout gates.

### 2. Policy invariance needs broader tests

The current code keeps provider output separate from authorization. Add a
dedicated suite proving byte-for-byte equality of policy, grant, session,
device, profile, and audit state across provider success, timeout, malformed
output, and attempted policy language.

### 3. The privacy projection should become fully coarse

The browser now sends only an optional owned profile identifier. The server
creates the analytical input from a finalized account audit. The next version
should convert every provider value to fixed enums and remove numerical scores,
distances, and thresholds before transport.

### 4. The provider payload exposes more precision than Gemini needs

The current adapter accepts a decision, trust percentage, normalized distance, acceptance threshold, and numerical deviation ratios. Gemini does not need any of these values to produce a plain-language description of broad behavior changes.

Removing them creates a stronger safety boundary. The model cannot change or restate a threshold or score it never receives.

### 5. Provider authorization is not operational

The locally configured authorization key returned HTTP 401 from the Interactions
API. This is a credentials and project-access failure, not a wrong endpoint: the
URL is the current Interactions API, and a wrong path would have returned 404.
Resolve the provider-side project and model access before any visible rollout.
Do not change the endpoint, and do not work around the failure by putting a key
in browser code.

### 6. The output validator is necessary but too narrow

Blocking a small set of authorization phrases will not catch every equivalent phrase. The target validator must also reject:

- Identity claims
- Human or bot claims
- Fraud or intent claims
- Policy recommendations
- New numerical claims
- URLs
- Signals not present in the request
- Limitations not present in the request

## Non-negotiable architecture boundary

Gemini is an explanation renderer. It is not an authentication component.

The deterministic policy pipeline must complete before Gemini is called. Its result must be immutable for the duration of the request. Gemini output must never:

- Change a score
- Change a threshold
- Add or remove a grant
- Extend a session
- mark a device as trusted
- Change a device association
- Change a profile
- Trigger a transfer
- Satisfy step-up authentication
- Replace an audit outcome
- Decide whether a person is human
- Decide whether a person is the account owner
- Feed a later model or policy calculation

The only allowed data flow is:

```text
Finalized server analysis
        |
        v
Privacy projection and strict validation
        |
        v
Gemini structured explanation
        |
        v
Output validation and grounding check
        |
        v
Advisory browser text
```

There must be no arrow from Gemini back into policy, storage templates, session grants, device state, or thresholds.

## Data that must never be sent to Gemini

The privacy projection must exclude these values at every nesting level:

- Guided or free-typing text
- Passwords
- Recovery codes
- CSRF tokens
- Session tokens
- Raw key events
- Individual key identities
- Key sequences
- Raw key-down or key-up timestamps
- Raw pointer events
- Raw pointer coordinates
- Usernames
- Email addresses
- Account IDs
- User IDs
- Session IDs
- Profile IDs
- Device IDs
- Transfer IDs
- Passkey credential IDs
- IP addresses
- Network headers
- User-agent strings
- Raw device descriptors
- Device fingerprints
- Fingerprint visitor IDs
- Fingerprint hashes
- API keys
- Provider tokens
- Audit metadata
- Free-form user context

The server may use an owned profile ID to locate a record locally. That ID must be removed before transport.

## Safe provider input contract

Add `src/explanation-context.js`. It should be the only code allowed to construct Gemini input.

Recommended version 1 payload:

```json
{
  "schemaVersion": 1,
  "analysis": {
    "overallPattern": "mixed",
    "confidenceBand": "medium",
    "baselineMaturity": "developing",
    "signals": [
      {
        "name": "key_hold_duration",
        "direction": "higher",
        "deviationBand": "moderate"
      }
    ],
    "limitations": [
      "limited_baseline",
      "client_timing_approximation"
    ]
  }
}
```

Allowed `overallPattern` values:

- `within_expected_range`
- `mixed`
- `outside_expected_range`
- `insufficient_data`

Allowed `confidenceBand` values:

- `low`
- `medium`
- `high`

Allowed `baselineMaturity` values:

- `limited`
- `developing`
- `established`

Allowed signal names:

- `key_hold_duration`
- `cadence`
- `pause_pattern`
- `burst_pattern`
- `pointer_motion`
- `guided_word_timing`
- `free_typing_timing`

Allowed directions:

- `higher`
- `lower`
- `stable`
- `mixed`

Allowed deviation bands:

- `minimal`
- `mild`
- `moderate`
- `large`

Allowed limitation codes:

- `limited_baseline`
- `insufficient_samples`
- `client_timing_approximation`
- `accessibility_variation_possible`
- `cross_device_context_excluded`
- `network_context_excluded`

The builder must:

1. Read only a finalized server record owned by the authenticated account.
2. Convert numerical values into the enums above.
3. Exclude the deterministic policy decision.
4. Exclude trust scores, distances, thresholds, and grants.
5. Exclude all network and device information.
6. Require exact keys recursively.
7. Reject more than 12 signals.
8. Reject a serialized payload larger than 4 KiB.
9. Deep-freeze the validated result before transport.
10. Run a forbidden-key scanner before every provider call.

Do not accept free-form `context` from the browser.

## Safe provider output contract

Gemini should return:

```json
{
  "schemaVersion": 1,
  "headline": "Timing patterns changed",
  "summary": "Some broad timing patterns differed from the established baseline.",
  "observations": [
    {
      "signal": "key_hold_duration",
      "deviationBand": "moderate",
      "explanation": "Key holds were generally longer than the established pattern."
    }
  ],
  "limitationCodes": [
    "limited_baseline"
  ]
}
```

The output validator must enforce all of the following:

- Exact keys at every level
- A maximum 100-character headline
- A maximum 500-character summary
- One through five observations
- A maximum 200-character explanation per observation
- A maximum total serialized size of 2 KiB
- Every output signal exists in the provider input
- Every output deviation band exactly matches its input signal
- Every output limitation code exists in the provider input
- No digits in generated prose
- No URLs
- No authorization, identity, intent, fraud, human, bot, device, network, score, or threshold claims
- `authorizationDecision` is never accepted as an output field

Do not ask Gemini to generate a next step. The browser can append a fixed application-owned sentence directing the user to the deterministic verification instructions already on screen.

## Recommended API request

Use the current Interactions API:

```text
POST https://generativelanguage.googleapis.com/v1beta/interactions
```

Required headers:

```text
Content-Type: application/json
x-goog-api-key: <server-side secret>
Api-Revision: <pinned supported revision>
```

Recommended request properties:

```json
{
  "model": "gemini-3.6-flash",
  "store": false,
  "background": false,
  "system_instruction": "Explain only the supplied coarse behavior signal bands. Do not infer identity, intent, authorization, fraud, human status, bot status, scores, thresholds, devices, or networks. Return only the required JSON object.",
  "input": {
    "parts": [
      {
        "text": "<validated JSON payload>"
      }
    ]
  },
  "response_format": {
    "type": "text",
    "mime_type": "application/json",
    "schema": "<strict output schema>"
  },
  "generation_config": {
    "max_output_tokens": 500,
    "thinking_level": "minimal",
    "thinking_summaries": "none"
  }
}
```

Do not configure:

- Tools
- Function calling
- Grounding
- Search
- URL context
- Code execution
- Files
- Background execution
- Conversation storage
- A previous interaction ID
- Streaming
- Live sessions

`gemini-3.6-flash` is the configured structured-explanation model as of
2026-07-25. Model availability changes. Recheck the official model and
deprecation pages before each production rollout.

The official documentation says the Interactions API stores requests by default, so `store: false` is mandatory. A paid project does not use prompts and responses to improve products, but limited abuse-monitoring retention can still apply unless zero-data-retention approval is in place. Zero-data-retention approval is a production rollout gate, not an optional improvement.

Relevant official documentation:

- [Interactions API overview](https://ai.google.dev/gemini-api/docs/interactions-overview)
- [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Current Gemini models](https://ai.google.dev/gemini-api/docs/models)
- [Model deprecations](https://ai.google.dev/gemini-api/docs/deprecations)
- [API key security](https://ai.google.dev/gemini-api/docs/api-key)
- [Zero data retention](https://ai.google.dev/gemini-api/docs/zdr)
- [Safety and factuality guidance](https://ai.google.dev/gemini-api/docs/safety-guidance)

## Authentication key requirements

Keep the permanent key server-side in a production secret manager. Never include it in:

- Browser JavaScript
- HTML
- Source control
- Client-visible environment variables
- Query strings
- Error messages
- Audit metadata
- Request or response logs

Use a dedicated Gemini project and an authorization key restricted to the Gemini API. Current official guidance says standard keys will stop being accepted in September 2026, so Odysseus should use an authorization key from the start.

Configure billing alerts and a hard operational kill switch.

## Exact target file plan

### `src/explanation-context.js`

New file.

Responsibilities:

- Build the privacy-projected input from server-owned analysis.
- Convert numbers to coarse enums.
- Maintain allowed signal and limitation enums.
- Reject forbidden keys recursively.
- Enforce payload size.
- Export `buildExplanationContext` and `validateExplanationContext`.

### `src/gemini-explanation.js`

Refactor the scaffold.

Responsibilities:

- Default to disabled without a key.
- Call the Interactions API with `store: false`.
- Send the key only in `x-goog-api-key`.
- Use a fixed system instruction.
- Use strict structured output.
- Parse the current `steps` response shape.
- Validate semantic grounding after JSON parsing.
- Return advisory output with `authorizationDecision: null`.
- Return generic provider failures without raw response bodies.
- Never log the request or response.

Remove:

- Decision, score, distance, and threshold input fields.
- The generated `nextStep`.
- Deprecated sampling parameters.
- Any target product name embedded in model-generated prose.

### `src/provider-runtime.js`

Wire the adapter from validated configuration.

Gemini must remain an optional provider. A disabled or degraded Gemini provider must not make the main application unready.

Return a frozen provider object and never expose credentials through readiness.

### `src/account-management-routes.js`

Make this the only owner of `POST /api/explanations`.

Middleware order:

1. Same-origin check
2. Explanation-specific rate limiter
3. CSRF validation
4. Authentication
5. Recent strong authorization
6. Exact request-body validation

The request body may contain only an owned local `profileId`. Resolve the latest finalized report on the server, then pass only the privacy projection to the adapter.

Success response:

```json
{
  "explanation": {},
  "provider": "gemini",
  "advisoryOnly": true,
  "authoritative": false,
  "authorizationDecision": null
}
```

Failure behavior:

- Disabled: `501 GEMINI_DISABLED`
- Rate limited: `429 EXPLANATION_RATE_LIMITED`
- Timeout or upstream failure: `503 EXPLANATION_UNAVAILABLE`
- Invalid provider output: `503 EXPLANATION_INVALID`

Never return the raw provider error or response.

### `src/account-security-routes.js`

Delete the unregistered explanation route and its unused helpers. Duplicate security-sensitive route implementations are a maintenance risk.

Keep capability and security-summary reporting, but return only coarse provider state.

### `server.js`

Parse and validate the target configuration. Pass the provider to the single mounted route.

Capture the deterministic policy result before calling Gemini and assert that it is unchanged afterward. This assertion should be tested even though the architecture already separates the paths.

Do not add Gemini to required startup providers.

### `src/readiness.js`

Represent provider state as:

- `disabled`
- `unchecked`
- `ready`
- `degraded`

Readiness must not make a paid inference request. State should update from real requests and local configuration.

### `src/monitoring.js`

Add content-free metrics:

- `odysseus_gemini_requests_total{outcome}`
- `odysseus_gemini_duration_seconds`
- `odysseus_gemini_input_rejections_total{reason}`
- `odysseus_gemini_output_rejections_total{reason}`
- `odysseus_gemini_rate_limit_total`

Allowed labels must be fixed enums. Do not use account, session, profile, device, IP, model output, prompt, or exception text as labels.

### `public/index.html`

Keep the explanation panel hidden while mode is `off` or `shadow`.

When visible, label it:

```text
AI-generated explanation
Advisory only. The server result above remains authoritative.
```

### `public/account.js`

Make explanation generation an explicit click. Never call Gemini automatically during enrollment, login, verification, report loading, or page loading.

Render all returned text with `textContent`. Do not use `innerHTML`.

Keep the deterministic result visually above and separate from generated prose. Provider failures must not obscure or replace that result.

### `public/styles.css`

Use a visually distinct advisory panel. Do not use success, verified, danger, or access-decision colors for AI prose.

### `.env.example`

Add placeholders only:

```text
ODYSSEUS_GEMINI_MODE=off
ODYSSEUS_GEMINI_API_KEY=
ODYSSEUS_GEMINI_MODEL=gemini-3.6-flash
ODYSSEUS_GEMINI_TIMEOUT_MS=5000
ODYSSEUS_GEMINI_MAX_CONCURRENCY=2
```

Allowed modes:

- `off`: no provider calls, UI hidden
- `shadow`: internal evaluation only, output never shown
- `visible`: explicit user request may show validated output

The key line must explain that production secrets belong in a secret manager and must never be committed.

### `README.md`

Document:

- Disabled-by-default behavior
- Advisory-only boundary
- Data exclusion list
- Setup without including a key value
- Operational kill switch
- Model version review requirement

### `SECURITY.md`

Document:

- Provider trust boundary
- Data retention assumptions
- No policy feedback path
- Incident response and key rotation
- How to report unsafe AI output

## Exact test plan

### `test/gemini-explanation.test.js`

Add unit tests for:

- Disabled adapter makes no network request.
- Key is in the header, never URL or body.
- `store` is exactly `false`.
- `background` is exactly `false`.
- Tools and prior interaction IDs are absent.
- Structured output schema has `additionalProperties: false`.
- Timeout returns a generic failure.
- Oversized responses are rejected.
- Malformed JSON is rejected.
- Unknown response keys are rejected.
- Authorization language is rejected.
- Identity, human, bot, fraud, score, threshold, network, and device language is rejected.
- Digits and URLs in generated prose are rejected.
- Output signals must be present in input.
- Output bands must exactly match input.
- Output limitations must be a subset of input.
- Provider error bodies are never returned.

### `test/explanation-context.test.js`

Add table-driven tests proving rejection before transport for every forbidden field, including nested fields:

- Raw text
- Raw key events
- Passwords
- Tokens
- User, session, profile, and device identifiers
- IP values
- User-agent values
- Device descriptors
- Fingerprint values
- Provider credentials
- Unknown signal names
- Numerical scores
- Numerical thresholds
- Numerical distances
- Policy decisions

Add a test that serializes the final provider payload and checks that no fixture secret or identifier appears anywhere.

### `test/account-management-routes.test.js`

Add tests for:

- Authentication required.
- CSRF required.
- Recent strong authorization required.
- Disabled mode returns 501.
- Client-provided score, threshold, decision, or context is rejected.
- An owned local profile can be selected.
- A profile from another account is rejected.
- Only the projected payload reaches the adapter.
- Rate limits apply.
- Provider failure returns a generic 503.
- Audit events contain outcome codes, not provider content.

### `test/provider-runtime.test.js`

Add tests for:

- Default mode is off.
- Missing key in visible or shadow mode fails configuration validation.
- Invalid model names fail startup.
- Gemini remains optional for application readiness.
- Readiness responses never contain a key.
- Runtime mode changes require restart.

### `test/policy-invariance.test.js`

This is the most important test suite.

Run the same finalized verification through:

1. Gemini disabled
2. Gemini success
3. Gemini timeout
4. Gemini malformed output
5. Gemini output that attempts to grant access
6. Gemini output that attempts to change a score
7. Gemini output that attempts to change a threshold

Assert byte-for-byte equality for:

- Policy decision
- Trust score
- Threshold
- Grant state
- Session state
- Device state
- Profile state
- Audit decision

### `e2e/odysseus.spec.js`

The suite currently asserts the opposite of a visible rollout: the "handles
unavailable or gated providers without breaking local auth" test checks that
`#explanation-request`, `#explanation-text`, and `#explanation-status` are all
present in the DOM and all hidden, and that no "Explain this result" control is
offered anywhere. That assertion encodes the standing product decision and must
not be relaxed to enable a rollout gate.

If a visible mode is ever approved, add browser journeys for:

- Panel hidden in off mode.
- Panel hidden in shadow mode.
- Visible mode requires an explicit click.
- Successful prose is labeled advisory.
- Generated text cannot create HTML or script nodes.
- Provider failure leaves the deterministic report unchanged.
- Repeated clicking is rate limited and does not duplicate in-flight calls.

## Rollout gates

### Gate 0: scaffold only

- Mode defaults to `off`.
- No key is required.
- Unit, route, policy-invariance, and browser tests pass.
- Leak scan reports no secrets.
- No provider call can occur in default development or test environments.

### Gate 1: synthetic evaluation

- Use generated, non-user fixtures only.
- Review at least 100 varied safe and adversarial outputs.
- Confirm all forbidden input fixtures are blocked before transport.
- Confirm all policy-invariance cases pass.
- Confirm no output is persisted.

### Gate 2: internal shadow

- Obtain privacy and security approval.
- Use a paid project.
- Obtain zero-data-retention approval for the project.
- Use an authorization key restricted to the Gemini API.
- Set `store: false`.
- Keep UI hidden.
- Require explicit internal test actions instead of automatic production calls.
- Track only content-free metrics.
- Verify the kill switch.

### Gate 3: internal visible

- Enable only for approved internal accounts.
- Require explicit user action.
- Display the advisory label and deterministic result together.
- Manually review invalid-output and timeout behavior.
- Complete prompt-injection and response-injection testing.

### Gate 4: limited opt-in production

- Obtain explicit user consent for sanitized provider processing.
- Confirm data-retention disclosures.
- Apply per-account and global rate limits.
- Apply concurrency and daily cost limits.
- Create key-rotation and provider-outage runbooks.
- Monitor rejection rate, latency, and user reports.

### Gate 5: broader availability

- No policy-invariance failures.
- No privacy projection leaks.
- No unresolved high-severity security findings.
- No provider output shown without passing local validation.
- External security review completed.
- Legal and privacy review completed.
- Model and API revision pinned and revalidated.
- Rollback to `off` tested in production.

## Operational kill switch

Setting:

```text
ODYSSEUS_GEMINI_MODE=off
```

and restarting the service must:

- Prevent all new provider requests.
- Hide the browser panel.
- Make `POST /api/explanations` return 501.
- Leave login, verification, reports, account management, and readiness operational.
- Preserve deterministic reports without generated prose.

## Definition of done

The Gemini integration is ready for a limited rollout only when:

- The single active route uses server-owned analysis.
- The privacy projection sends only coarse enums.
- Forbidden data is rejected recursively before network transport.
- The provider request is stateless with `store: false`.
- The permanent key exists only on the server.
- The output is schema-validated and semantically grounded.
- The browser labels output as advisory and renders it as text.
- Policy-invariance tests prove zero authorization effect.
- Provider failures do not affect core readiness.
- Default configuration makes no provider calls.
- Zero-data-retention approval, privacy review, security review, and the operational kill switch are complete.

Until every condition above is satisfied, Odysseus should keep Gemini disabled.
