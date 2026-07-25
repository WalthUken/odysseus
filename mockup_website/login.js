document.addEventListener('DOMContentLoaded', () => {
    // Always start a fresh session here: credentials go straight to the
    // terminal, and the security questions only appear inside recovery.
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('username');
    localStorage.removeItem('temp_username');

    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');
    const recoverForm = document.getElementById('recover-form');
    const securityForm = document.getElementById('security-form');
    const resetForm = document.getElementById('reset-form');

    const loginError = document.getElementById('login-error');
    const loginNotice = document.getElementById('login-notice');
    const signupError = document.getElementById('signup-error');
    const recoverError = document.getElementById('recover-error');
    const securityError = document.getElementById('security-error');
    const resetError = document.getElementById('reset-error');

    const step1 = document.getElementById('step-1');
    const stepSignup = document.getElementById('step-signup');
    const stepRecover = document.getElementById('step-recover');
    const step2 = document.getElementById('step-2');
    const stepReset = document.getElementById('step-reset');

    const recoverySetupFields = document.getElementById('signup-recovery-fields');
    const recoverySetupToggle = document.getElementById('toggle-recovery-setup');

    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');

    // Odysseus compares a returning visitor's typing and pointer movement
    // against the profile built while they were signed in. That comparison can
    // only happen if the sign-in request carries the evidence, so collection
    // starts as soon as the card is on screen and runs for the whole visit.
    const authEvidence = startAuthEvidence(usernameInput, passwordInput);

    // The mockup no longer ships its own report viewer; the real one lives on
    // the Odysseus origin. Ask the server where that is.
    pointAdminLinkAtOdysseus();

    // Carried between the recovery steps: the account being recovered and the
    // short-lived ticket the server hands back once the answers check out.
    let recoveryUsername = '';
    let recoveryTicket = '';

    function showStep(step) {
        [step1, stepSignup, stepRecover, step2, stepReset].forEach((section) => {
            section.style.display = section === step ? 'block' : 'none';
        });
        step.style.animation = 'slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards';
    }

    function showError(element, message) {
        if (message) {
            element.textContent = message;
        }
        element.style.display = 'block';

        // Remove and re-add the animation so it replays on a repeat failure
        element.style.animation = 'none';
        element.offsetHeight; // trigger reflow
        element.style.animation = 'shake 0.5s ease-in-out';
    }

    function clearErrors() {
        [loginError, signupError, recoverError, securityError, resetError]
            .forEach((element) => {
                element.style.display = 'none';
            });
    }

    function backToSignIn() {
        recoveryUsername = '';
        recoveryTicket = '';
        recoverForm.reset();
        securityForm.reset();
        resetForm.reset();
        clearErrors();
        showStep(step1);
    }

    function busy(form, label) {
        const button = form.querySelector('button[type="submit"]');
        const original = button.innerText;
        button.innerHTML = `<span style="opacity: 0.8">${label}</span>`;
        button.style.pointerEvents = 'none';
        return () => {
            button.innerHTML = original;
            button.style.pointerEvents = 'auto';
        };
    }

    function selectedValue(name) {
        const choice = document.querySelector(`input[name="${name}"]:checked`);
        return choice ? choice.value : '';
    }

    document.getElementById('show-signup').addEventListener('click', (e) => {
        e.preventDefault();
        clearErrors();
        loginNotice.style.display = 'none';
        showStep(stepSignup);
    });

    document.getElementById('show-signin').addEventListener('click', (e) => {
        e.preventDefault();
        clearErrors();
        showStep(step1);
    });

    document.getElementById('show-recovery').addEventListener('click', (e) => {
        e.preventDefault();
        clearErrors();
        loginNotice.style.display = 'none';
        showStep(stepRecover);
    });

    ['recover-cancel', 'security-cancel', 'reset-cancel'].forEach((id) => {
        document.getElementById(id).addEventListener('click', (e) => {
            e.preventDefault();
            backToSignIn();
        });
    });

    // The recovery questions are secondary on the signup card: hidden until
    // asked for, never required to finish creating the account.
    recoverySetupToggle.addEventListener('click', (e) => {
        e.preventDefault();
        const hidden = recoverySetupFields.style.display === 'none';
        recoverySetupFields.style.display = hidden ? 'block' : 'none';
        recoverySetupToggle.textContent = hidden
            ? 'Skip the recovery questions'
            : 'Add password recovery questions (optional)';
    });

    // Returning here through the back button restores a cached page that can
    // still be sitting on a later step, so rebuild the page from scratch.
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            window.location.reload();
        }
    });

    // Accounts live behind the demo server, so these calls need the page
    // served over http rather than opened as a file.
    async function postJson(url, payload) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        let body = {};
        try {
            body = await response.json();
        } catch (_error) {
            body = {};
        }

        if (!response.ok) {
            throw new Error(body.error || 'Something went wrong. Try again.');
        }
        return body;
    }

    // Every rejected sign-in is treated the same way here: show whatever the
    // server said, empty the password box, and put the caret back in it. The
    // page never inspects the status code, so nothing on screen or in the DOM
    // can hint at which of the possible reasons applied. Clearing the field
    // also makes the retry a real one - the visitor types the password again,
    // which is what produces a fresh sample for the next attempt.
    function loginFailed(message) {
        showError(loginError, message);
        passwordInput.value = '';
        passwordInput.focus();
    }

    function enterTerminal(username) {
        localStorage.setItem('isLoggedIn', 'true');
        localStorage.setItem('username', username);
        localStorage.removeItem('temp_username');
        window.location.href = 'index.html';
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = usernameInput.value;
        const credentialValue = passwordInput.value;
        const done = busy(loginForm, 'Authenticating...');
        loginError.style.display = 'none';
        loginNotice.style.display = 'none';

        // Harvested immediately, before the await, so the sample covers the
        // credentials that were just typed and nothing after them.
        const behaviorEvidence = authEvidence.collect(username);

        try {
            const account = await postJson('/api/login', {
                username,
                password: credentialValue,
                behaviorEvidence
            });

            enterTerminal(account.username);
        } catch (error) {
            loginFailed(error.message);
            done();
        }
    });

    signupForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = document.getElementById('new-username').value;
        const credentialValue = document.getElementById('new-password').value;
        const confirmValue = document.getElementById('confirm-password').value;

        if (credentialValue !== confirmValue) {
            showError(signupError, 'Passwords do not match');
            return;
        }

        const answers = {
            maidenName: document.getElementById('signup-maiden-name').value.trim(),
            highschool: document.getElementById('signup-highschool').value.trim(),
            pet: document.getElementById('signup-pet').value.trim(),
            sex: selectedValue('signup-sex')
        };
        const provided = Object.values(answers).filter((value) => value !== '');
        if (provided.length > 0 && provided.length < 4) {
            showError(
                signupError,
                'Answer all four recovery questions, or leave them all blank.'
            );
            return;
        }

        const done = busy(signupForm, 'Creating account...');
        signupError.style.display = 'none';

        try {
            const payload = { username, password: credentialValue };
            if (provided.length === 4) {
                payload.answers = answers;
            }
            const account = await postJson('/api/signup', payload);

            enterTerminal(account.username);
        } catch (error) {
            showError(signupError, error.message);
            done();
        }
    });

    recoverForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const username = document.getElementById('recover-username').value.trim();
        if (username === '') {
            showError(recoverError, 'Enter the username on the account.');
            return;
        }

        // Nothing is checked yet; the server answers the same way for unknown
        // accounts, so the questions are shown either way.
        recoveryUsername = username;
        recoverError.style.display = 'none';
        securityError.style.display = 'none';
        showStep(step2);
    });

    securityForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const answers = {
            maidenName: document.getElementById('maiden-name').value,
            highschool: document.getElementById('highschool').value,
            pet: document.getElementById('pet').value,
            sex: selectedValue('sex')
        };

        const done = busy(securityForm, 'Verifying...');
        securityError.style.display = 'none';

        try {
            const result = await postJson('/api/recovery/verify', {
                username: recoveryUsername,
                answers
            });

            recoveryTicket = result.ticket;
            securityForm.reset();
            resetError.style.display = 'none';
            showStep(stepReset);
        } catch (error) {
            showError(securityError, error.message);
        } finally {
            done();
        }
    });

    resetForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const password = document.getElementById('reset-password').value;
        const confirmValue = document.getElementById('reset-confirm').value;

        if (password !== confirmValue) {
            showError(resetError, 'Passwords do not match');
            return;
        }

        const done = busy(resetForm, 'Updating...');
        resetError.style.display = 'none';

        try {
            await postJson('/api/recovery/reset', {
                ticket: recoveryTicket,
                password
            });

            const recovered = recoveryUsername;
            backToSignIn();
            loginNotice.style.display = 'block';
            usernameInput.value = recovered;
        } catch (error) {
            showError(resetError, error.message);
        } finally {
            done();
        }
    });
});

/* ============================================================
   Sign-in behavioural evidence
   ------------------------------------------------------------
   Odysseus refuses to open a session for an account that already
   has a behavioural profile unless the login request carries
   evidence to compare against it. Without this the storefront
   could only sign such a visitor in with no upstream session,
   which meant every telemetry batch they produced afterwards was
   thrown away - exactly the comparison the system exists to make.

   The collector below is the same one app.js runs on the
   dashboard (itself adapted from public/telemetry.js): identical
   feature names, identical thresholds and identical arithmetic,
   so a sample taken here is comparable with the profile enrolled
   there. The mockup is served from a different origin than
   Odysseus, so it is reimplemented rather than imported, and
   app.js cannot be loaded on this page - its DOMContentLoaded
   handler bounces unauthenticated visitors straight back to
   login.html.

   Keyboard source: the sign-in username and password fields.
   Pointer source: the whole document.
   Nothing about any of this is ever shown to the visitor.
   ============================================================ */

const AUTH_FEATURE_NAMES = [
    'dwellMean',
    'dwellDeviation',
    'flightMean',
    'flightDeviation',
    'downDownMean',
    'downDownDeviation',
    'pointerVelocityMean',
    'pointerVelocityDeviation',
    'pointerAccelerationMean',
    'pointerAccelerationDeviation',
    'pointerJitterMean',
    'pointerJitterDeviation'
];

const AUTH_TELEMETRY_DEFAULTS = {
    pointerThrottleMs: 80,
    minimumDwellSamples: 10,
    minimumFlightSamples: 8,
    minimumDownDownSamples: 8,
    // A sign-in card is typed on, not navigated. Pointer movement is welcome
    // but never required, matching the auth-time collector in public/app.js:
    // the backend decides per family whether a sample carries enough of it to
    // score, and drops the families that fall short.
    minimumPointerSamples: 0,
    maximumMetricSamples: 240,
    requireTrustedEvents: true
};

function createAuthBehaviorCollector(options) {
    const supplied = options || {};
    const config = Object.assign({}, AUTH_TELEMETRY_DEFAULTS, supplied);
    const keyboardTarget = supplied.keyboardTarget || null;
    const pointerTarget = supplied.pointerTarget || document;
    const shouldCaptureKeyboard =
        typeof supplied.shouldCaptureKeyboard === 'function'
            ? supplied.shouldCaptureKeyboard
            : null;

    function perfNow() {
        return (window.performance && typeof window.performance.now === 'function')
            ? window.performance.now()
            : Date.now();
    }

    function mean(values) {
        if (!values.length) return 0;
        return values.reduce((total, value) => total + value, 0) / values.length;
    }

    function meanAbsoluteDeviation(values, average) {
        if (!values.length) return 0;
        return values.reduce((total, value) => total + Math.abs(value - average), 0) / values.length;
    }

    function summarize(values) {
        const average = mean(values);
        return [average, meanAbsoluteDeviation(values, average)];
    }

    function addBounded(values, value, limit) {
        if (!Number.isFinite(value)) return;
        values.push(value);
        if (values.length > limit) {
            values.splice(0, values.length - limit);
        }
    }

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function isTrusted(event) {
        return Boolean(event && event.isTrusted === true);
    }

    const state = {
        started: false,
        metrics: null,
        activePresses: [],
        lastKeyDownAt: null,
        lastKeyUpAt: null,
        lastPointer: null,
        lastPointerVelocity: null,
        lastPointerAngle: null,
        rejectedSyntheticEvents: 0,
        windowStartedAt: 0
    };

    function reset() {
        state.metrics = {
            dwell: [],
            flight: [],
            downDown: [],
            pointerVelocity: [],
            pointerAcceleration: [],
            pointerJitter: []
        };
        state.activePresses = [];
        state.lastKeyDownAt = null;
        state.lastKeyUpAt = null;
        state.lastPointer = null;
        state.lastPointerVelocity = null;
        state.lastPointerAngle = null;
        state.rejectedSyntheticEvents = 0;
        state.windowStartedAt = perfNow();
    }

    function accepts(event) {
        if (config.requireTrustedEvents === false || isTrusted(event)) {
            return true;
        }
        // Reject any synthetic / automated event.
        state.rejectedSyntheticEvents += 1;
        return false;
    }

    function captureKeyboard(event) {
        return shouldCaptureKeyboard ? Boolean(shouldCaptureKeyboard(event)) : true;
    }

    function handleKeyDown(event) {
        if (!accepts(event) || event.repeat || !captureKeyboard(event)) {
            return;
        }
        const timestamp = perfNow();
        const limit = config.maximumMetricSamples;

        if (state.lastKeyDownAt !== null) {
            const downDown = timestamp - state.lastKeyDownAt;
            if (downDown >= 5 && downDown <= 5000) {
                addBounded(state.metrics.downDown, downDown, limit);
            }
        }
        if (state.lastKeyUpAt !== null) {
            const flight = timestamp - state.lastKeyUpAt;
            if (flight >= -1000 && flight <= 5000) {
                addBounded(state.metrics.flight, flight, limit);
            }
        }
        state.activePresses.push({ downAt: timestamp });
        if (state.activePresses.length > 12) {
            state.activePresses.shift();
        }
        state.lastKeyDownAt = timestamp;
    }

    function handleKeyUp(event) {
        if (!accepts(event) || !captureKeyboard(event)) {
            return;
        }
        const timestamp = perfNow();
        const press = state.activePresses.shift();
        if (press) {
            const dwell = timestamp - press.downAt;
            if (dwell >= 5 && dwell <= 5000) {
                addBounded(state.metrics.dwell, dwell, config.maximumMetricSamples);
            }
        }
        state.lastKeyUpAt = timestamp;
    }

    function handlePointerMove(event) {
        if (!accepts(event)) {
            return;
        }
        const timestamp = perfNow();
        if (state.lastPointer && timestamp - state.lastPointer.timestamp < config.pointerThrottleMs) {
            return;
        }

        const current = {
            x: Number(event.clientX),
            y: Number(event.clientY),
            timestamp: timestamp
        };

        if (!Number.isFinite(current.x) || !Number.isFinite(current.y) || !state.lastPointer) {
            state.lastPointer = current;
            return;
        }

        const elapsedMs = timestamp - state.lastPointer.timestamp;
        if (elapsedMs <= 0 || elapsedMs > 3000) {
            state.lastPointer = current;
            state.lastPointerVelocity = null;
            state.lastPointerAngle = null;
            return;
        }

        const dx = current.x - state.lastPointer.x;
        const dy = current.y - state.lastPointer.y;
        const distance = Math.hypot(dx, dy);
        const elapsedSeconds = elapsedMs / 1000;
        const velocity = distance / elapsedSeconds;
        const angle = distance > 0 ? Math.atan2(dy, dx) : state.lastPointerAngle;
        const limit = config.maximumMetricSamples;

        if (velocity <= 100000) {
            addBounded(state.metrics.pointerVelocity, velocity, limit);
        }

        if (state.lastPointerVelocity !== null) {
            const acceleration = Math.abs(velocity - state.lastPointerVelocity) / elapsedSeconds;
            if (acceleration <= 1000000) {
                addBounded(state.metrics.pointerAcceleration, acceleration, limit);
            }
        }

        if (angle !== null && state.lastPointerAngle !== null && distance > 0) {
            let angleChange = Math.abs(angle - state.lastPointerAngle);
            if (angleChange > Math.PI) {
                angleChange = 2 * Math.PI - angleChange;
            }
            addBounded(state.metrics.pointerJitter, clamp(angleChange / Math.PI, 0, 1), limit);
        }

        state.lastPointer = current;
        state.lastPointerVelocity = velocity;
        if (angle !== null) {
            state.lastPointerAngle = angle;
        }
    }

    function handleVisibilityChange() {
        if (document.hidden) {
            state.activePresses.length = 0;
            state.lastKeyDownAt = null;
            state.lastKeyUpAt = null;
            state.lastPointer = null;
            state.lastPointerVelocity = null;
            state.lastPointerAngle = null;
        }
    }

    function sampleCounts() {
        return {
            dwell: state.metrics.dwell.length,
            flight: state.metrics.flight.length,
            downDown: state.metrics.downDown.length,
            pointer: state.metrics.pointerVelocity.length
        };
    }

    function isReady() {
        const counts = sampleCounts();
        return (
            counts.dwell >= config.minimumDwellSamples &&
            counts.flight >= config.minimumFlightSamples &&
            counts.downDown >= config.minimumDownDownSamples &&
            counts.pointer >= config.minimumPointerSamples
        );
    }

    function readiness() {
        return { ready: isReady(), counts: sampleCounts() };
    }

    function finalize() {
        // A window that has not filled up is left intact, so the keystrokes a
        // visitor already produced still count towards their next attempt.
        if (!isReady()) {
            return { ok: false, counts: sampleCounts() };
        }
        const dwell = summarize(state.metrics.dwell);
        const flight = summarize(state.metrics.flight);
        const downDown = summarize(state.metrics.downDown);
        const pointerVelocity = summarize(state.metrics.pointerVelocity);
        const pointerAcceleration = summarize(state.metrics.pointerAcceleration);
        const pointerJitter = summarize(state.metrics.pointerJitter);

        const featureValues = [
            dwell[0], dwell[1],
            flight[0], flight[1],
            downDown[0], downDown[1],
            pointerVelocity[0], pointerVelocity[1],
            pointerAcceleration[0], pointerAcceleration[1],
            pointerJitter[0], pointerJitter[1]
        ].map(value => Number(value.toFixed(6)));

        const vector = {};
        AUTH_FEATURE_NAMES.forEach((name, index) => {
            vector[name] = featureValues[index];
        });

        const result = {
            ok: true,
            vector: vector,
            counts: sampleCounts(),
            integrity: {
                trustedEventsRequired: config.requireTrustedEvents !== false,
                rejectedSyntheticEvents: state.rejectedSyntheticEvents
            },
            durationMs: Math.round(perfNow() - state.windowStartedAt)
        };
        reset();
        return result;
    }

    function start() {
        if (state.started) return;
        if (keyboardTarget) {
            keyboardTarget.addEventListener('keydown', handleKeyDown, { passive: true });
            keyboardTarget.addEventListener('keyup', handleKeyUp, { passive: true });
        }
        if (pointerTarget) {
            pointerTarget.addEventListener('pointermove', handlePointerMove, { passive: true });
            pointerTarget.addEventListener('mousemove', handlePointerMove, { passive: true });
        }
        document.addEventListener('visibilitychange', handleVisibilityChange, { passive: true });
        state.started = true;
    }

    reset();

    return {
        start: start,
        readiness: readiness,
        finalize: finalize
    };
}

function boundedEvidenceInteger(value, maximum) {
    return Math.max(0, Math.min(maximum, Math.round(Number(value) || 0)));
}

function boundedEvidenceCounts(counts) {
    return {
        dwell: boundedEvidenceInteger(counts && counts.dwell, 1000),
        flight: boundedEvidenceInteger(counts && counts.flight, 1000),
        downDown: boundedEvidenceInteger(counts && counts.downDown, 1000),
        pointer: boundedEvidenceInteger(counts && counts.pointer, 1000)
    };
}

// Watches the two sign-in fields and turns what it saw into the
// `behaviorEvidence` object POST /api/auth/login accepts:
// { profileId, status, sampleCounts, vector, diagnostics, interactionEvidence }.
// `status` is either "ready" or "insufficient_evidence", and an insufficient
// sample must arrive with the counts alone - attaching telemetry to it is
// rejected outright.
function startAuthEvidence(usernameInput, passwordInput) {
    let collector = null;
    try {
        // Use the shared collector from telemetry.js (loaded in login.html).
        // This ensures both the login page and dashboard emit identical feature names and semantics.
        collector = window.OdysseusTelemetry.createCollector({
            keyboardTarget: document,
            pointerTarget: document,
            // Listen at the document level and narrow to the sign-in fields, so
            // the recovery answers and the signup card never leak into a
            // sign-in sample.
            shouldCaptureKeyboard: event => {
                const target = event.target;
                return target === usernameInput || target === passwordInput;
            }
        });
        collector.start();
    } catch (error) {
        collector = null;
    }

    return {
        collect(username) {
            // Signing in must never fail because of the measurement, so any
            // problem here degrades to sending nothing at all.
            if (!collector) {
                return undefined;
            }
            try {
                const readiness = collector.readiness();
                const sampleCounts = boundedEvidenceCounts(readiness.counts);
                const sample = collector.finalize();
                const profileId = String(username || '').trim().toLowerCase();

                if (!sample.ok) {
                    return {
                        profileId: profileId,
                        status: 'insufficient_evidence',
                        sampleCounts: sampleCounts
                    };
                }

                return {
                    profileId: profileId,
                    status: 'ready',
                    sampleCounts: sampleCounts,
                    // Passed through exactly as the collector produced it, so a
                    // feature added to the shared collector reaches the backend
                    // without this file having to learn its name.
                    vector: sample.vector,
                    interactionEvidence: {
                        version: 1,
                        trustedEventsRequired:
                            sample.integrity.trustedEventsRequired === true,
                        rejectedSyntheticEvents: boundedEvidenceInteger(
                            sample.integrity.rejectedSyntheticEvents,
                            1000
                        ),
                        // Must equal behaviorEvidence.sampleCounts exactly; the
                        // backend rejects evidence whose two counts disagree.
                        sampleCounts: boundedEvidenceCounts(sample.counts),
                        durationMs: boundedEvidenceInteger(
                            sample.durationMs,
                            10 * 60 * 1000
                        )
                    }
                };
            } catch (error) {
                return undefined;
            }
        }
    };
}

// The mockup used to ship a cut-down report page of its own. The reports now
// come from Odysseus itself, which runs on its own origin, so the button is
// pointed at whatever origin this server is proxying accounts to. The href in
// the markup is the default and stays in place if the lookup fails.
function pointAdminLinkAtOdysseus() {
    const link = document.getElementById('admin-link');
    if (!link) {
        return;
    }
    fetch('/api/config', { headers: { Accept: 'application/json' } })
        .then(response => (response.ok ? response.json() : null))
        .then(config => {
            if (config && typeof config.adminUrl === 'string' && config.adminUrl) {
                link.href = config.adminUrl;
            }
        })
        .catch(() => {
            // Keep the default href.
        });
}
