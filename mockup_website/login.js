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

   The measurement comes from telemetry.js, the same collector
   app.js runs on the dashboard, so a sample taken here is
   comparable with the profile enrolled there and a feature added
   to that file reaches the backend without this one being
   touched. app.js itself cannot be loaded on this page: its
   DOMContentLoaded handler bounces unauthenticated visitors
   straight back to login.html.

   Keyboard source: the sign-in username and password fields.
   Pointer source: the whole document.
   Nothing about any of this is ever shown to the visitor.
   ============================================================ */

// Readiness thresholds for a sign-in window, matching the auth-time collector
// in public/app.js. A sign-in card is typed on, not navigated: pointer movement
// is welcome but never required, and the backend decides per family whether a
// sample carries enough of it to score, dropping the families that fall short.
const AUTH_READINESS = {
    minimumDwellSamples: 10,
    minimumFlightSamples: 8,
    minimumDownDownSamples: 8,
    minimumPointerSamples: 0
};

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
        // The shared collector from telemetry.js, loaded by login.html, so this
        // page and the dashboard emit the same feature names and semantics.
        collector = window.OdysseusTelemetry.createCollector({
            ...AUTH_READINESS,
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
