# Odysseus — hackathon presentation script

A say-it-out-loud script for pitching the whole project. Stage directions are in
[square brackets]. Everything stated as fact here is checkable in the repository,
and where a number came from outside the repository it is labelled as such.

Companion doc: **`docs/HACKATHON-SCRIPT-AI-PROVIDERS.md`** covers Gemini and
Hugging Face in depth. This script has a short AI-providers section that points
there rather than repeating it.

Deeper reference: `docs/DETECTION-AND-SECURITY-REPORT.md` and `README.md`.

---

## Before you walk on stage — the checklist

[Do all of this before the room fills. None of it is fast enough to do live.]

1. `npm start` — Odysseus engine and console on `http://127.0.0.1:3000`.
2. `npm run mockup` — OptionsFlow trading site on `http://127.0.0.1:4000`.
   Both must be running. The mockup holds no accounts; with Odysseus down it
   answers "The account service is not running."
3. Confirm `ODYSSEUS_DEMO_ADMIN_BYPASS` is set in `.env` to something 10 to 512
   characters long. Without it, `/admin` returns a plain 404 and your reveal is
   gone.
4. Open two browser windows: OptionsFlow on 4000, and `/admin` on 3000. Put them
   on separate tabs you can switch to instantly.
5. **Check you have internet.** `mockup_website/index.html` loads Chart.js from
   `cdn.jsdelivr.net`. No internet means no price charts on the demo site. The
   biometrics still work; the charts are just cosmetics. Know this so it does not
   surprise you.
6. Have a terminal ready for `npm run bot`, sized so the audience can see the
   Chromium window it opens.
7. Optional but nice: have `npm test` output on screen already. 211 tests, all
   passing.

---

## THE HOOK — about 30 seconds

[Stand still. Do not touch the laptop yet.]

> Here is the problem with passwords. It is not that they are weak. It is that a
> correct password from a thief and a correct password from you are *the exact
> same event* on the server. There is nothing left to check. The server has no
> way to tell the difference.
>
> So we added something a thief cannot steal along with the password: the way you
> type, and the way you move a mouse.
>
> Not what you type. *How* you type. The rhythm. How long you hold a key down.
> Whether you type in fast bursts and then stop to think, or grind along at a
> steady pace. Which awkward letter combinations your fingers stumble over.
>
> That is Odysseus. It is a second signal that sits alongside the password, and
> it is collected completely silently while you use the site normally. No puzzle,
> no challenge screen, no "prove you are human" box.

[Now open the laptop.]

> Let me show you, and then I will show you the maths, and then I will tell you
> what it does not do — because there is a real limitation and it is more
> interesting than the wins.

---

## THE LIVE DEMO — about 2 minutes 30

### Setup line

> Two things are running. Port 3000 is Odysseus itself, the engine. Port 4000 is
> a fake stock trading site called OptionsFlow. That is deliberate. OptionsFlow
> holds no accounts of its own. Every login and every telemetry upload is
> forwarded server-to-server to Odysseus, so the browser only ever talks to port
> 4000 and never sees an Odysseus cookie.
>
> The point of the fake trading site is that it is what a real customer would
> see. It never mentions that anything behavioral is happening. That is the whole
> product.

[Switch to the OptionsFlow tab, port 4000.]

### Step 1 — sign up

> I am going to make an account. Normal signup form. There is an optional
> collapsed section for password recovery questions. I am going to skip it,
> because it is optional, and because I want you to see what happens next.

[Fill the signup form. Type at a normal speed. Submit.]

> Watch. I land straight on the trading dashboard.

[Point at the screen.]

> There was no challenge screen. No "type this sentence so we can learn your
> rhythm." No enrollment round. Nothing gated that. This is important: if you
> make the user do a typing exercise, you have built a CAPTCHA, and you have
> already lost the thing that makes this good.

### Step 2 — use the site like a person

> Now I just use the site.

[Click a ticker card. SPY, QQQ or NVDA.]

> That opens a detail view with a price history chart. And here is the order
> ticket. Quantity, and limit price.

[Type into the quantity field, then the limit price field. Type naturally, do not
narrate over your own typing — let them see you type.]

> Those two fields are the only place on this page where keystrokes are
> collected. That is a filter in the code, not a coincidence. Typing in the
> search bar is explicitly excluded. Mouse movement is collected across the whole
> page.

[Submit the order. Close the modal. Open a second ticker. Place another order.]

> I will do that a couple more times, because the collector will not emit a
> sample until it has enough observations to be worth anything: at least ten key
> holds, eight flight times, eight key intervals, and eight pointer movements.

### Step 3 — what the judges are not seeing

[Stop clicking. Turn to the audience. This is the beat that lands.]

> Now. What have you seen on that screen that had anything to do with
> biometrics?
>
> Nothing. And that is enforced, not accidental.
>
> Every 1.5 seconds the browser tries to build a feature vector. If it has enough
> data, it uploads it. The first five complete samples enroll my baseline. Every
> sample after that gets scored against it. The upload response is the same bare
> acknowledgement whether Odysseus accepted it, rejected it, or was not running
> at all.
>
> There is no trust score on screen. No progress bar. No "we are learning your
> typing" notice. If the behavioral check *rejects* a login, the user sees the
> same generic failure message they would see for a typo.
>
> That last part is tested to the byte. `e2e/odysseus.spec.js` renders the page
> after a behavioral denial and the page after a wrong password, and compares
> them. Apart from one status line, they are identical.

> Why does that matter? Because the moment you tell an attacker *which* signal
> failed, you have handed them a training oracle. They can iterate. Silence is a
> security property.

### Step 4 — the reveal

[Switch to the `/admin` tab on port 3000.]

> The only place any of this is visible is a local report viewer. And it is
> gated three ways: an environment variable has to be set, the server must not be
> in production mode, and the request has to come from loopback. Fail any of
> those and you get a plain 404. Not a 403 — a 404, so it does not even admit the
> route exists.
>
> To read a report you enter the account's own username and password. The same
> credentials as the sign-in page.

[Enter the demo account's username and password. Prepare the report.]

> And there it is. That is my behavioral fingerprint.
>
> Twenty features. For each one: the baseline centre, the normal variation, the
> normalisation scale, the current value, the difference, and how much that
> feature contributed to the score. Then the normalised distance, the acceptance
> threshold, the step-up threshold, and the reason codes.
>
> What is *not* in there, deliberately: no passwords, no password hashes, no
> session or CSRF credentials, no device fingerprint digests, no passkey keys, no
> ciphertext, no encryption keys, no typed content, no raw events.

### Step 5 — the bot [the dramatic beat]

[Go to the terminal. Run `npm run bot`. A headed Chromium window opens.]

> This is our own Playwright bot. It drives the real site in a real browser
> window, and it draws its own cursor into the page so you can watch it work.

[Let it run. It types the credentials, then opens SPY, QQQ and NVDA in turn,
fills each order ticket and submits.]

> Look at how it moves. It eases into every glide. Slow at the start, fast in the
> middle, slow at the end. That is `easeInOutQuad`, twenty-four steps per move.
> It types character by character with a randomised sixty to a hundred and fifty
> millisecond gap.
>
> And here is the story I actually want to tell you. **When we first wrote this
> bot, it passed as human.**
>
> Because the naive checks are all about *speed*. Is the pointer moving
> impossibly fast? Is the speed suspiciously constant? Is there no acceleration
> at all? This bot passes every one of those, because the easing gives it a
> genuinely human-looking speed profile. Our own bot defeated our own detector.
>
> What gave it away was not its speed. It was its *path*.
>
> A hand never draws a straight line. It curves continuously. So for a human,
> the average direction change per sample and the spread of that direction change
> stay in roughly the same ballpark. For interpolated travel, almost every single
> sample turns by nothing at all — it is a straight line — and then at each
> waypoint it turns abruptly. So the *mean* direction change is near zero while
> the *spread* is several times larger than the mean.
>
> That signature has a name in the code: `POINTER_WAYPOINT_TRAVEL`. Mean angular
> change under 0.1, with spread more than twice the mean. Straight lines with
> sharp corners.

[Be precise here — do not overclaim.]

> To be exact about what that one signal does on its own: it is worth 40 points,
> which lands the session in `elevated_review`, not the top band. And in this
> demo `elevated_review` is fail-closed for session creation — no session is
> issued. It reaches `automation_likely` when it stacks with other signals. There
> is a unit test that pins exactly that behaviour, including a control case: a
> gentle hand with an equally small average curve, which is *not* flagged,
> because its spread stays close to its mean.

---

## HOW IT WORKS — about 3 minutes

### The 20-feature vector

[Have `public/telemetry.js` on screen if you can.]

> The browser computes twenty numbers. Here they are, honestly, all of them.
>
> **Six timing families, each as a mean and a mean absolute deviation. Twelve
> numbers.**
>
> - Dwell — how long you hold a key down.
> - Flight — from releasing one key to pressing the next.
> - Down-down — from one keypress to the next keypress.
> - Pointer velocity.
> - Pointer acceleration.
> - Pointer direction change, which the code calls jitter.
>
> Those twelve were the original version. Then we added eight more, and the eight
> are the interesting part.
>
> **Two burst-structure features.**
>
> - `downDownPauseRatio` — what share of your inter-key gaps are thinking pauses
>   rather than actual typing. A gap of 500 milliseconds or more counts as a
>   pause. A gap of 60 seconds or more means you walked away, and counts as
>   neither.
> - `downDownInBurstMean` — how fast you go when you are actually going.
>
> Why does that matter? Because a single average erases it. Two people can both
> average 190 milliseconds between keys. One gets there with long fast runs and
> rare long pauses. The other with short runs and frequent short pauses. Same
> average, completely different person. The pause ratio and the in-burst mean
> separate them.
>
> **Six key-class transition features.** These are the digraph features.
>
> - `downDownSameHandBias`
> - `downDownAlternateHandBias`
> - `downDownVowelConsonantBias`
> - `downDownConsonantRunBias`
> - `downDownWordBoundaryBias`
> - `downDownSymbolBias`
>
> Each one says: how much slower or faster does this *class* of transition run,
> compared to your own in-burst average? Positive means slower, negative means
> faster, zero means no bias.
>
> Per-digraph latency — how long you take on specific letter pairs — is the most
> discriminative keystroke signal that is known. These six are its coarse,
> privacy-safe form. This is where the identity signal actually lives.

[If asked why they overlap: they overlap on purpose. A left-hand "th" is both a
same-hand pair and a consonant run. Each aggregate answers a different question.]

> Two details that keep these honest. First, a class-pair estimate is shrunk
> toward "no bias" by four pseudo-observations, so a class you barely used cannot
> emit pure noise as though it were a stable personal trait. Second, they are
> measured from in-burst gaps only, never from thinking pauses — because we want
> to measure which key combinations your *hands* stumble over, not where you
> stopped to think about what to write.

### The privacy boundary — the part I would lead with

[Slow down. This is the strongest single claim in the project.]

> Those six digraph features should worry you. If you are measuring which letter
> pairs someone types slowly, are you not recording what they typed?
>
> No. And I want to show you exactly why, because the answer is a single function
> and you can read it in ten seconds.

[Show `classifyKey()` in `public/telemetry.js`.]

> `classifyKey` receives the keyboard event. It reads `event.key`. And it returns
> one of eight numbers.
>
> - 0 other — modifiers, arrows, function keys
> - 1 whitespace — space, Enter, Tab
> - 2 digit
> - 3 symbol
> - 4 left-hand consonant
> - 5 left-hand vowel
> - 6 right-hand consonant
> - 7 right-hand vowel
>
> That is it. The key is read and discarded in the same statement that produces
> the class. It is never stored. It never leaves that function. The comment in the
> code says exactly that, and the code does exactly that.
>
> Twenty-six letters share four buckets. So one class carries about two bits. A
> *pair* of classes carries about four bits.
>
> And even that is never emitted. What gets emitted is an *average over an entire
> window* — one number per class pair, per window, blending dozens of keystrokes
> together. Not a sequence. An aggregate.
>
> So ask what you would need to reconstruct text from that. You would need the
> order, the specific keys, and per-keystroke values. You have none of those. You
> have six averages. There is no inverse. It is not encryption that could be
> broken; the information was thrown away before it left the function.

> The full list of what the browser does not send: typed text in any field in any
> form, passwords, recovery codes, session credentials, CSRF credentials, key
> identities, keycodes, raw key events, raw cursor coordinates, full pointer
> paths, cookies, a persistent visitor identifier, and the user-agent string.

### The scoring engine — Scaled Manhattan Distance

[`src/behavior.js`. No machine learning here, and say so.]

> There is no neural network in the identity decision. It is Scaled Manhattan
> Distance, which is a well established keystroke-dynamics method, and it is
> about forty lines of code.
>
> **Enrollment.** Take the samples. Between three and fifty; the demo site
> enrolls on the first five. For each of the twenty features, compute two things:
> the mean, and the mean absolute deviation — how much that feature normally
> wanders for this person.
>
> Then a scale per feature: the deviation, floored so it cannot collapse to zero.
> Specifically, the larger of the deviation, one percent of the absolute mean, and
> one in a million.
>
> **Verification.** For each feature, take the absolute difference between the new
> value and the baseline mean, and divide by that feature's *own* scale. Add them
> up. Divide by the number of features compared.
>
> That division is the whole idea. It is why this beats plain distance. A feature
> that naturally bounces around a lot for you needs to move a long way before it
> counts as suspicious. A feature that is rock steady for you gets flagged by a
> small move. The threshold is not global. It is per-feature, and it is per-person.
>
> **The threshold is also learned from you.** At enrollment the engine scores your
> own enrollment samples against your own template, takes the 90th percentile of
> those distances, multiplies by 1.5, and clamps that between 1.5 and 4. So a
> consistent typist gets a tight threshold and an erratic one gets a loose one.
>
> **Three outcomes.**
>
> - At or under the threshold: **allow**. Reason code `BEHAVIOR_MATCH`.
> - Up to 2.5 times the threshold: **step_up**. `BEHAVIOR_DRIFT`. Sensitive
>   actions blocked, ask for something else.
> - Beyond that: **deny**. `BEHAVIOR_MISMATCH`.
>
> And the report names the culprits. Any feature contributing more than 2 gets its
> own reason code, top three by size. So the admin report does not just say "far
> away", it says *which features* were far away.

[The trust percentage, if asked: it is `0.7` raised to the power of
distance-over-threshold. Monotonic presentation of the distance. It is
deliberately **not** a probability that this is the right person, and the docs say
so.]

### Inert features — the bit I am proudest of

> Here is a problem you hit immediately in the real world.
>
> Suppose someone enrolls while only using the mouse. Never types. Their six
> digraph features and their pause ratio all come out as exactly zero — mean zero,
> deviation zero. Now they type for the first time. Divide a real measurement by
> that near-zero scale floor and you get an astronomical distance. The genuine
> user gets locked out the moment they start typing. That is a catastrophic
> failure mode, and it is the *obvious* implementation.
>
> So: a feature whose mean and deviation are both exactly zero at enrollment is
> marked **inert**. The template records an `activeFeatureKeys` list, and scoring
> only ever walks that list. The zero-signal features are skipped. Not zeroed —
> skipped. The normalised distance divides by the count of features actually
> compared, so a mouse-only profile is scored on the mouse features and judged
> fairly.
>
> And then `adoptFeatures()` closes the loop. When strongly verified samples
> arrive that *do* carry real typing, those inert features get promoted: a mean, a
> deviation and a scale are computed and they join the active set. A profile built
> from one interaction surface gets amplified by another over time, instead of
> exploding.
>
> There is a dedicated test file for this, `test/behavior-inert-features.test.js`,
> because it is the kind of thing that silently regresses.

### Two independent axes

[Draw two axes in the air, or on a slide. This framing sells the whole design.]

> This is the architectural decision I would defend hardest.
>
> There are two completely different questions and we score them separately.
>
> **Axis one: is this the right person?** Scaled Manhattan Distance against the
> enrolled template. `src/behavior.js`.
>
> **Axis two: is this a human at all?** A separate weighted signal assessment.
> `src/automation-risk.js`.
>
> They do not talk to each other, and that is the point. Because a bot can be
> *close* to your template — it can copy your average timings — and still be
> obviously a bot in its pointer path. And a real human can be genuinely
> different from another real human without either of them being automated.
> Collapsing those into one score throws away information.
>
> The result is four classifications: `human_like_interaction`,
> `elevated_review`, `automation_likely`, and `insufficient_evidence`.
>
> Score bands: under 40 is low, 40 to 69 is elevated review, 70 and up is
> `automation_likely`. And an `automation_likely` login is denied *even if its
> feature vector is a close match to the enrolled user*. It gets no session, and
> critically it cannot become training data for the template.

### The bot-detection signals that carry the weight

> The signals that do the real work are the pointer-native ones, because those
> are computed server-side from the geometry of the movement, not asked of the
> client.
>
> - `POINTER_PATH_WITHOUT_CURVATURE` — mean direction change under 0.01. A drawn
>   line. Worth 44.
> - `POINTER_WAYPOINT_TRAVEL` — the one that caught our bot. Mean under 0.1 with
>   spread more than twice the mean. Straight runs, abrupt corners. Worth 40.
> - `POINTER_VELOCITY_WITHOUT_VARIATION` — speed variation under 5 percent of the
>   mean. Worth 30.
> - `POINTER_WITHOUT_ACCELERATION_PROFILE` — mean acceleration under 20. Travel
>   with no speeding up or slowing down. Worth 28.
> - `IMPLAUSIBLE_POINTER_VELOCITY` — average speed over 8,000 pixels per second.
>   Faster than a hand sustains. Worth 40.
> - `ROBOTIC_POINTER_REGULARITY` — steady speed *and* barely varying direction
>   change together. Worth 28.
>
> The comment above those constants is worth reading out: "A hand never draws a
> perfectly straight line, never holds one speed, and never travels without
> accelerating." Every floor sits deliberately far below what a trackpad, a
> stylus, or an assistive pointer produces. These are not tuned to catch marginal
> humans. They are tuned to catch things that are degenerate.

### Why we do not lean on what the browser tells us

[This is a subtle point and judges like it.]

> There is a signal in the code called `TRUSTED_EVENTS_NOT_REQUIRED`, weighted 40,
> and another called `SYNTHETIC_EVENTS_OBSERVED`, weighted 55. They fire when the
> browser reports that it was not checking `isTrusted`, or that it rejected
> script-dispatched events.
>
> Those catch the naive attack: someone calling `dispatchEvent` in the console.
> The browser marks those `isTrusted: false` and the collector throws them away.
>
> But here is the thing. **Real automation driving a real browser reports those
> fields completely honestly, and pays nothing.** Playwright's synthetic input goes
> through the browser's own input pipeline. The events genuinely *are* trusted.
> So `trustedEventsRequired` comes back `true` and `rejectedSyntheticEvents` comes
> back zero, which is the truth, and neither signal fires.
>
> So we designed as if those signals were not there. The server-side pointer
> heuristics carry the weight on their own. That is why our bot is caught by the
> shape of its path and not by anything it told us about itself. Anything the
> client attests to is reporting context, not a trusted authorization input. The
> code's own limitations list says it: "browser-reported evidence can be forged by
> a direct API client or advanced automation."

### One more honest detail about the scoring

> The automation score is normalised two ways and the sharper of the two wins.
> Once against the total weight this particular sample could possibly have tripped
> — because a mouse-only window should not be measured against keyboard-only
> checks it had no way to trigger. And once against a fixed scale of 100. There is
> also a minimum attainable weight of 40, so that a nearly-empty window with two
> bookkeeping signals cannot read as a confident automation finding.

---

## THE AI PROVIDERS — about 45 seconds

[Keep this short. It is a section, not the pitch. Depth lives in
`docs/HACKATHON-SCRIPT-AI-PROVIDERS.md`.]

> There are two AI provider integrations. I want to be very clear about what they
> do, because the honest answer is the impressive one.
>
> **The decision is maths, not an LLM.** Gemini's only job is to turn a decision
> that has already been made into plain English prose for the admin report. It is
> a narrator, not a judge. Delete it entirely and authentication behaves
> identically — you lose a paragraph of description in a report.
>
> And it is not "advisory only" as a promise in a README. It is enforced three
> ways in code. The outbound payload is an allowlist of exactly three fields with
> no identifiers, no raw events, no typed text, and the real trust score replaced
> with a coarse band. `authorizationDecision: null` is hardcoded on every return
> path, so there is no code path that can emit one. And authoritative-sounding
> prose coming *back* — "access granted", "should be trusted" — is rejected
> outright.
>
> **Current status, stated plainly: Gemini returns HTTP 401.** The integration is
> complete and tested against the real API shape. It needs a key with project
> access to that model. We are confident the endpoint is right because a wrong URL
> returns 404, not 401.
>
> **Hugging Face** is an anomaly-detection adapter that is written, validated and
> unit-tested, and has **zero production call sites.** It never runs. I am not
> going to call it shadow mode, because there is no shadow path — nothing is
> recorded and nothing is compared.
>
> The details of all three Gemini locks, and what it would take to finish the
> Hugging Face path in one call site, are in
> `docs/HACKATHON-SCRIPT-AI-PROVIDERS.md`. Ask me and I will go deeper.

---

## WHAT WE MEASURED — about 1 minute

[Read these carefully and label them correctly. They are simulation results.]

> We did not just add eight features and assume they helped. We measured.
>
> The test was a simulation with two synthetic typists. They differ in two ways:
> their burst rhythm, and which classes of digraph they fumble. Then we asked how
> often the impostor gets caught, before and after the eight new features.
>
> - Differs in **both** rhythm and digraphs: **48 percent caught, up to 94
>   percent.**
> - Differs in **burst rhythm only**, with overall typing speed matched: **42
>   percent, up to 87 percent.**
> - Differs in **digraph struggles only**: **18 percent, up to 83 percent.**
>
> That middle case is the one worth dwelling on. Overall speed *matched*. The old
> twelve features looked at the average and saw nothing. The pause ratio and the
> in-burst mean saw a different person.
>
> And the third case is the strongest argument for the digraph features on their
> own: 18 to 83. Fumbling different letter combinations was almost invisible
> before.
>
> Meanwhile legitimate-user acceptance is essentially unchanged, about 82 percent,
> and about 94 percent with eight enrollment samples instead of five. So this is
> not the cheap trick of tightening the threshold and calling it detection. The
> genuine user is not paying for it.

[Be precise about provenance if asked, and volunteer it if the room is technical:]

> Provenance, because you should ask: those are **simulation** numbers against
> synthetic typists, not field results from real users, and there is no
> representative population behind them. I should also say that I could not find a
> checked-in simulation harness in the repository that reproduces those exact
> figures — the feature semantics they test are all in
> `test/keystroke-features.test.js`, but the before-and-after catch-rate
> measurement is not a committed script. Take the numbers as our measurement, not
> as something you can re-run from this repo today.

### The four features we deliberately threw away

[This is the credibility beat. Do not skip it.]

> Here is the part I think actually shows engineering discipline.
>
> We built **four more** burst-structure features and then deleted them. Mean
> burst length. Burst-length spread. Mean pause duration. The pause-to-burst
> timing ratio.
>
> Mean burst length went because it is redundant: bursts are pauses plus one, so
> it is the reciprocal of the pause frequency we already have, just in a noisier
> unbounded form.
>
> The other three went because we measured them and they **made the system
> worse.** Each one is estimated from the handful of pauses that occur in a single
> window, so its own estimation noise exceeded its signal. And because the score
> is a *mean over features*, a noisy feature does not just fail to help — it
> dilutes every other feature's contribution. All three moved the impostor less
> than they moved the genuine user. Shipping them would have lowered the catch
> rate.
>
> That reasoning is written into the source, in the comment block above
> `FEATURE_NAMES`. It is not a story I made up for this pitch.
>
> More features is not more security. It is very easy to build a system that
> looks sophisticated and performs worse, and the only way to know which one you
> have is to measure.

---

## LIMITATIONS, STATED PLAINLY — about 1 minute

[Do not soften these. Volunteering them is worth more than being caught on them.]

### 1. Mouse-only biometrics do not tell humans apart

> This is the honest headline limitation, and it is the most interesting thing we
> learned.
>
> Those six pointer features are excellent at telling a **bot** from a human, and
> weak at telling **one human from another**. And there is a clean reason why.
>
> A bot differs from a human in *kind*. Zero jitter. Constant speed. No
> acceleration profile. Straight lines. Those are not "unusual for a person",
> they are things a hand physically cannot do. The gap is categorical, so a fixed
> floor catches it.
>
> Two humans differ only in *degree*. You move the mouse a bit faster than me.
> Your acceleration is slightly different. But six summary statistics — three
> means and three deviations — overlap heavily across people. And they shift with
> the mouse, the surface, the operating system's pointer acceleration setting, and
> the task, often by more than they differ between two people.
>
> **Typing is what carries identity.** Mouse movement carries bot-versus-human.
>
> And we found this the hard way. The owner and a friend both tested it, and it
> did **not** tell them apart. That negative result is what caused the eight
> keystroke features to exist. It is why the demo bot is written to type into the
> order ticket instead of only navigating — a mouse-only run exercises almost none
> of the discriminative path.

[If you want the strongest version of this line:]

> I would rather show you a measured negative result that changed the design than
> a demo that only works when I drive it.

### 2. The threshold is not calibrated

> The acceptance threshold is derived from a five-sample enrollment set. It has
> not been calibrated against a representative population. It is a demo heuristic,
> not a biometric accuracy claim. We have not measured a false acceptance rate, a
> false rejection rate, or an equal error rate on real cohorts, and the repo says
> so in three separate places.

### 3. No replay protection yet

> The biggest real security gap: there is no server-issued single-use behavior
> challenge. A direct API client that skips the browser entirely could forge or
> replay a browser summary. What is needed is a nonce, account and profile
> binding, short expiry, single-use consumption, and duplicate-evidence
> detection. That is written up as the priority-zero item.

### 4. Gemini and Hugging Face

> Gemini: 401, so no explanations are produced today. Hugging Face: written, not
> wired, never runs. Local behavioral scoring, which is the actual product, runs
> fully.

### 5. Demo-only mechanisms

> A few things in here are demo scaffolding and not production designs, and the
> repo labels them: the admin report accepting an account password grants a full
> record dump to anyone with that password on this machine; the template is
> amended in place rather than versioned immutably; and the cohort selector
> labels are experiment metadata that never touch a score.

---

## ANTICIPATED JUDGE QUESTIONS

[Rehearse these. The Q&A is usually where the score is decided.]

### "Isn't this just an LLM wrapper?"

> No, and it is a good question to ask about anything at a hackathon in 2026.
>
> The identity decision is Scaled Manhattan Distance over a 20-feature vector,
> computed locally in about forty lines of code. There is no model inference in
> the authentication path at all. The bot detection is a weighted rule set with
> hand-derived physical thresholds.
>
> Rip Gemini out completely and authentication behaves identically. You lose one
> paragraph of prose in an admin report. Right now Gemini is returning 401 and the
> product works, which is the demonstration.

### "What about prompt injection?"

> Three defences, and they compose.
>
> One: the prompt contains no user-controlled free text. The payload is an
> allowlisted set of numbers and enum values — three fields, capped at 24 signal
> entries. There is nowhere to inject.
>
> Two: the adapter has no code path that can emit an authorization decision.
> `authorizationDecision: null` is hardcoded on every return, not defaulted.
>
> Three: authoritative-sounding output is rejected on the way back in. If the
> prose says "access granted" or "should be trusted", the whole response is
> discarded.
>
> So an attacker who fully controlled the Gemini response still could not move the
> decision by one point. Worth adding: that output filter was genuinely broken —
> the original regex was word-order-sensitive and caught "granted access" but not
> "access granted" — and it is now order-independent. We found that by testing it.

### "Can I be spoofed by a recording? If someone records my typing, can they replay it?"

> Today, partly yes, and that is the honest answer.
>
> Two separate cases. Replaying a *feature vector* through the API: yes, that is
> the replay gap I mentioned. There is no server-issued single-use challenge, no
> nonce, no duplicate-vector detection. It is written up as priority zero.
>
> Replaying *keystrokes in a browser*: harder than it sounds, because you have to
> reproduce the timing accurately enough at the millisecond level and reproduce a
> plausible pointer path at the same time. Naive `dispatchEvent` replay is caught
> immediately because the browser marks those events untrusted and the collector
> discards them. A serious attacker driving a real browser could do it.
>
> But note what this costs the attacker. They now need your password *and* a
> recording of you typing. That is a much more expensive attack than a credential
> from a breach dump. Raising cost is what a second factor does. This is not a
> claim to be unspoofable.

### "What if I break my wrist? Or I switch from a mouse to a trackpad?"

> This is the question that matters most for whether the thing is shippable, and
> the design already assumes it.
>
> Three things.
>
> First, the middle outcome exists precisely for this. A mismatch does not have to
> be a lockout. Between the acceptance threshold and 2.5 times it, the result is
> `step_up`: sensitive actions are blocked and you are asked for something else —
> a passkey, a password re-entry. You are not locked out, you are asked once more.
> The system is designed for the answer "we are not sure", which is the answer
> most of the time.
>
> Second, this is never the only factor. It sits alongside a password, and
> passkeys are implemented. The repo is explicit: passwords, passkeys, recovery
> controls, and server policy remain the real authorization factors. The
> behavioral result is a secondary signal.
>
> Third, the template can move with you. There is bounded template evolution with
> deliberately tiny limits — a learning rate of 0.01 on the login path, per-login
> movement capped at 2 percent of the original feature scale, cumulative movement
> capped at 25 percent, and it will never loosen the acceptance threshold. So
> gradual drift is absorbed. A sudden change is not, and gets a step-up.
>
> And the honest part: a broken wrist is a sudden change. You will get stepped up
> for a while. The limitations list in the code says exactly this — "accessibility
> tools, injuries, unusual hardware, and practiced users can change the same
> signals." A production deployment of this needs accessibility cohort testing that
> we have not done.

### "What happens on a phone?"

> Honestly: it degrades, and I do not want to oversell it.
>
> There is no mouse on a phone, so all six pointer features come out at or near
> zero. That is exactly the case the inert-feature mechanism handles — those
> features get marked inert and skipped rather than exploding the score, so a
> mobile profile is scored on its keyboard features and judged fairly against
> them.
>
> Keystroke timing does still exist on a soft keyboard, and dwell, flight and
> down-down are all measurable. But two caveats. A soft keyboard has no real
> concept of hand split, so the same-hand and alternate-hand digraph features
> become much weaker — the QWERTY hand split we use is a thumb-typing artifact at
> best. And autocorrect and predictive text inject keystrokes that are not yours.
>
> So: it works, it is measurably weaker, and mobile is listed as a cohort we have
> not evaluated. What I would not do is claim the desktop numbers transfer.

### "Is this GDPR-safe?"

> I will answer this in two halves, because the honest answer is not "yes".
>
> The half I am confident about: behavioral data here is *minimised by
> construction*, not by policy. The browser sends twenty numbers. No typed text.
> No key identities. No keycodes. No raw events. No cursor coordinates. No
> user-agent. No persistent visitor ID. The templates are encrypted at rest with
> AES-256-GCM, with the account and profile identifiers bound in as authenticated
> encryption context so a template cannot be silently moved to another account.
> The admin report has field-level redaction. That is real data-protection-by-design
> and it is the strongest position you can be in.
>
> The half that is not done: behavioral biometrics used for identification is
> **special category data** under Article 9. That needs a lawful basis, which in
> practice means explicit consent, which means a consent flow — and this demo does
> not have one. It also needs a DPIA, a retention policy, a documented erasure
> path, and transparency about the processing. None of those are built.
>
> So: the technical foundation is the right shape, and the compliance work is
> outstanding. The repo is explicit that independent privacy, security and
> penetration reviews are required before production. I would rather tell you that
> than claim a compliance status I have not earned.

### "How is this different from a CAPTCHA?"

> Almost the opposite thing.
>
> A CAPTCHA interrupts you. It answers one question — human or bot — once, at one
> moment, and then it is over. It gets solved for pennies by services that exist
> for exactly that. And it is a tax on every legitimate user, worst for the users
> who have the most trouble with it.
>
> This never interrupts. You saw the demo. There is no puzzle, no checkbox, no
> friction, and no user-visible feedback of any kind. It runs continuously
> throughout the session rather than once at the door, so a session that gets
> hijacked *after* the CAPTCHA is still in scope.
>
> And it answers a question a CAPTCHA cannot answer at all: not "is this a human",
> but "is this *the same* human as last time". A CAPTCHA has no opinion about
> whether the person typing your password is you. That is our whole axis one.
>
> We do also answer the CAPTCHA question, in axis two. We just answer it without
> asking you anything.

### "What is the false-positive cost to a real user?"

> The right question, and let me separate what I know from what I do not.
>
> What I do not know: the real-world false rejection rate. There is no
> representative calibration. Anyone who quotes you a false-positive rate off a
> hackathon demo is guessing.
>
> What I do know is how the *cost* is bounded, which is arguably more important
> than the rate.
>
> A false positive is not a lockout. It is a `step_up`. The user is asked for a
> second factor once and continues. In the simulation, legitimate acceptance was
> around 82 percent at five enrollment samples and around 94 percent at eight —
> so at eight samples roughly one session in sixteen sees one extra prompt.
>
> The failure is also silent and generic. A rejected user does not get an
> accusatory "we do not think this is you" message. They get the same message as
> a typo, and they retry. There is no shame path and no support ticket that starts
> with "your system says I am not me".
>
> And the threshold is per-person, derived from that person's own enrollment
> variance, so an erratic typist automatically gets a looser threshold instead of
> being punished for being erratic.
>
> The design principle: make the false-positive *cost* one extra tap, and you can
> tolerate a much higher false-positive *rate* than a system that locks people
> out.

### "Why do you not use machine learning for this?"

> Three reasons, and the third is the real one.
>
> Explainability. The admin report can tell you which of twenty named features
> deviated and by how much. A model gives you a number. For an authorization
> decision that a user might dispute, that difference matters a lot.
>
> Data. A neural net needs many samples per person. Scaled Manhattan Distance
> works from three, and the demo site enrolls on five. There is no cold start.
>
> And it works. Scaled Manhattan Distance is a well established keystroke
> dynamics baseline that is competitive with much heavier methods on this exact
> problem. Reaching for a model first would have been decoration. The measured
> improvement in this project came from picking better *features*, not from a
> fancier classifier — that is the 18-to-83 number.

### "Could an attacker who knows your feature list just fake the twenty numbers?"

> If they can hit the API directly and forge a submission, yes — and I have
> already told you that is the priority-zero gap, because there is no single-use
> server challenge yet.
>
> But notice what forging requires. They need to know *your* twenty values, not
> just the twenty feature names. The names are in an open-source file; your values
> are in an encrypted per-account template that is never sent to the browser, and
> the admin report that displays them requires your password on a loopback
> connection outside production.
>
> There is also a poisoning defence that is already built. The template will never
> learn from an identity mismatch, from elevated or missing automation evidence,
> from a failed password, or from a replayed sample. So an attacker cannot slowly
> walk your template toward their own typing — the classic attack on adaptive
> biometrics — because failing samples are never training data.

### "What is the actual stack?"

> Deliberately boring, and that is a choice.
>
> Node 24 — 24.18 on this machine. Express 5. CommonJS. SQLite through Node's
> built-in `node:sqlite`, no native module to compile. Tests with `node:test`: 211
> of them, all passing, and I ran that this morning. Playwright for end-to-end,
> 15 specs in `e2e/odysseus.spec.js`, which spins up its own isolated instance on
> port 3217 with a temporary database so it never touches a running demo.
>
> The browser side is vanilla JavaScript. No build step. No framework. No bundler.
> `public/telemetry.js` is a plain script you can read top to bottom, which for a
> file that makes a privacy promise is a feature, not laziness. If it needed a
> build step you would have to trust the build.
>
> Security: scrypt password hashing with independent random salts, opaque
> server-side sessions, CSRF double-submit — a cookie plus an `x-csrf-token`
> header that must match — same-origin checks on state-changing requests, a
> `default-src 'self'` content security policy, HttpOnly SameSite=Strict cookies,
> AES-256-GCM for behavioral templates, and three layers of rate limiting: ten
> attempts per two seconds per network, ten per fifteen minutes per target
> account, twenty per fifteen minutes per network sustained. Blocked bursts get
> audited with an automation flag.
>
> One duplication I will flag before you find it: the mockup is served from a
> different origin, so `mockup_website/telemetry.js` is a byte-identical copy of
> `public/telemetry.js` rather than an import. Two files, one contract, and they
> have to be changed together. The README says so and the tests load both into
> separate VM contexts and replay the same synthetic keystroke stream through each
> to check they agree.

### "What would you build next?"

> In order, and this is the repo's own priority list, not something I made up on
> the way here.
>
> One: server-issued single-use behavior challenges. Nonce, account and profile
> binding, short expiry, single-use consumption, duplicate detection. That closes
> the direct-API replay gap and it is worth more than any new signal.
>
> Two: immutable template versioning with quarantine, promotion and rollback.
> Right now the demo amends the active template in place. Production must preserve
> the original enrollment as a known-good version you can roll back to.
>
> Three: real calibration. Many genuine repeats, many impostors, split by person,
> session, day, device and automation family, reporting false acceptance, false
> rejection, and equal error rate per cohort — including accessibility and mobile
> cohorts. Everything I have told you about accuracy is a simulation until that
> exists.
>
> Four: wire up the Hugging Face shadow path, which is one call site, and only as
> a shadow — recorded once, never read back into a decision — so you can evaluate
> whether a model *would* have helped before you ever give it authority.

---

## TIMING GUIDE

### The 2-minute version

[Cut the theory almost entirely. Demo plus one number plus the limitation.]

| Time | What |
| --- | --- |
| 0:00–0:20 | **Hook.** A correct password from a thief and from you are the same event. We add something a thief cannot steal: how you type. |
| 0:20–1:00 | **Demo.** Sign up on OptionsFlow. Land straight on the dashboard, no challenge. Open a ticker, type a quantity and a limit price. Say the line: "nothing on that screen told you anything was happening." |
| 1:00–1:20 | **The reveal.** `/admin`. Twenty features, per-feature baselines and deviations. Scaled Manhattan Distance. No LLM in the decision. |
| 1:20–1:40 | **The bot.** Start `npm run bot` if it is already warm, or just tell the story: our own bot passed the naive check because it eases every glide, so it looks human by speed. It was caught by the *shape* of its path — straight lines with sharp corners at waypoints. |
| 1:40–1:55 | **One number.** Impostor with a different burst rhythm and matched overall speed: 42 percent caught, up to 87 with the eight new features. Legitimate acceptance unchanged. Simulation, not field data. |
| 1:55–2:00 | **The limitation.** Mouse tells bots from humans. Typing tells humans apart. We found that out because it failed to tell me and my friend apart, and that is why the eight features exist. |

**If you only get to say four things:** the password problem; nothing is shown to
the user; the decision is maths not an LLM; typing carries identity and mouse
does not.

### The 5-minute version

| Time | Section | Notes |
| --- | --- | --- |
| 0:00–0:30 | **Hook** | Stolen password is indistinguishable from the real user. |
| 0:30–3:00 | **Live demo** | Sign up. Straight to dashboard — say "no challenge screen" out loud. Ticker card. Chart. Order ticket: quantity and limit price are the only keyboard source. Two or three orders. Then the "what you are not seeing" beat. Then `/admin`. Then `npm run bot`. |
| 3:00–4:00 | **How it works** | Twenty features: 12 original, 2 burst, 6 digraph. `classifyKey` and the privacy boundary — read out the eight classes and "the key is discarded in the same statement." Scaled Manhattan Distance in one sentence: per-feature distance divided by that feature's own normal spread. Three outcomes. Two independent axes. |
| 4:00–4:35 | **What we measured** | 48→94, 42→87, 18→83. Acceptance unchanged at ~82, ~94 at eight samples. Simulation, not field. Then the four dropped features and why: their own noise exceeded their signal, and a mean over features means a noisy feature dilutes the good ones. |
| 4:35–5:00 | **Limitations** | Mouse-only does not separate humans; typing carries identity; found by failing on two real people. Threshold not calibrated. No replay protection yet. Gemini 401, Hugging Face unwired. |

**Where to spend cuts if you overrun:** the automation-risk constants, the trust
percentage formula, and the stack rundown. Keep the privacy boundary, the bot
story, the 18-to-83 number, and the mouse-versus-typing limitation. Those four
are the pitch.

---

## THINGS TO SAY, AND THINGS NOT TO SAY

**Say:**
- "The decision is maths, not an LLM."
- "The key is read and discarded in the same statement."
- "Our own bot beat our own detector, and here is what caught it."
- "We built four more features, measured them, and deleted them."
- "Typing carries identity. Mouse carries bot-versus-human."
- "These are simulation numbers, not field results."
- "A false positive is one extra prompt, not a lockout."

**Do not say:**
- "Unspoofable", "unhackable", or any accuracy percentage as though it were
  field-measured.
- "Shadow mode" about Hugging Face. It does not run.
- That Gemini is working. It returns 401.
- That the threshold is calibrated. It is derived from five samples.
- "AI-powered authentication." The authentication is deterministic. Saying
  otherwise gives away the best point you have.

---

## APPENDIX — quick reference for Q&A

**File map**

| What | Where |
| --- | --- |
| The 20 features, key classes, `classifyKey()` | `public/telemetry.js` (byte-identical copy at `mockup_website/telemetry.js`) |
| Scaled Manhattan Distance, templates, inert features, `adoptFeatures` | `src/behavior.js` |
| Bot detection | `src/automation-risk.js` |
| Gemini adapter | `src/gemini-explanation.js` |
| Hugging Face adapter (never called) | `src/hugging-face-anomaly.js` |
| Password hashing | `src/auth.js` |
| CSP, same-origin guard | `src/http-security.js` |
| Rate limiting | `src/rate-limit.js` |
| Admin report routes | `src/demo-admin-routes.js` |
| Bounded template evolution | `src/template-evolution.js` |
| The demo bot | `scripts/mockup-demo-bot.js` |
| Trading site front end | `mockup_website/app.js` |
| Feature-parity tests for both collectors | `test/keystroke-features.test.js` |
| Inert-feature tests | `test/behavior-inert-features.test.js` |
| Waypoint-detection test | `test/automation-risk.test.js` |
| Disclosure-boundary byte comparison | `e2e/odysseus.spec.js` |

**Constants you might be asked for**

- Pause threshold: 500 ms. Idle break: 60 s. Class-pair prior: 4
  pseudo-observations.
- Collector minimums before a sample is emitted: 10 dwell, 8 flight, 8
  down-down, 8 pointer. Pointer sampling throttled to 80 ms. Maximum 240 samples
  retained per family.
- Sample attempt interval on the trading site: 1,500 ms. First 5 complete samples
  enroll.
- Enrollment range in the engine: 3 to 50 samples. Maximum 32 features.
- Feature scale floor: max(deviation, 1% of |mean|, 1e-6).
- Acceptance threshold: 90th percentile of enrollment distances × 1.5, clamped to
  [1.5, 4]. Step-up threshold: acceptance × 2.5.
- Trust score: 0.7 ^ (normalised distance / acceptance threshold). Presentation
  only, not a probability.
- Per-feature reason code emitted when a contribution exceeds 2, top 3 reported.
- Automation bands: <40 low, 40–69 elevated review, 70+ `automation_likely`.
  Minimum attainable weight 40.
- Pointer floors: jitter mean 0.01; waypoint mean 0.1 with variation ratio 2;
  velocity variation 0.05; acceleration mean 20; velocity ceiling 8,000 px/s.
- Rate limits: 10 per 2 s per network, 10 per 15 min per account, 20 per 15 min
  per network.

**Verified during preparation of this script**

- `npm test` — 211 tests, 211 pass, 0 fail.
- Node 24.18.0. Express 5. CommonJS. `node:sqlite`. Playwright 1.62.
- 15 `test(...)` specs in `e2e/odysseus.spec.js` (spec count read from the file;
  the Playwright run itself was not executed while writing this).
- `public/telemetry.js` and `mockup_website/telemetry.js` are byte-identical.
- Exactly 20 entries in `FEATURE_NAMES`, matching the names listed above.
- `/admin` takes an account username and password; `ODYSSEUS_DEMO_ADMIN_BYPASS`
  is only the on/off switch that decides whether the viewer is served at all.

**Not verifiable from this repository — label these as such if you use them**

- The 48→94, 42→87, 18→83 catch rates and the ~82% / ~94% acceptance figures.
  The feature semantics they rest on are tested, but no committed script
  reproduces those catch-rate measurements. Present as our simulation results.
- The anecdote that the owner and a friend were not told apart. Real, but it is
  an unrecorded manual test, not a stored result.
- The claim that the demo bot originally passed the detector. The mechanism is
  documented in the source comments and pinned by a unit test that shows
  `POINTER_WAYPOINT_TRAVEL` firing on an eased-glide profile with human-looking
  speed and acceleration. The historical "it passed" run itself is not recorded
  anywhere in the repo.
