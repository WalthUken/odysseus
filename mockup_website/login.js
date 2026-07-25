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

    function enterTerminal(username) {
        localStorage.setItem('isLoggedIn', 'true');
        localStorage.setItem('username', username);
        localStorage.removeItem('temp_username');
        window.location.href = 'index.html';
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = document.getElementById('username').value;
        const credentialValue = document.getElementById('password').value;
        const done = busy(loginForm, 'Authenticating...');
        loginError.style.display = 'none';
        loginNotice.style.display = 'none';

        try {
            const account = await postJson('/api/login', {
                username,
                password: credentialValue
            });

            enterTerminal(account.username);
        } catch (error) {
            showError(loginError, error.message);
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
            document.getElementById('username').value = recovered;
        } catch (error) {
            showError(resetError, error.message);
        } finally {
            done();
        }
    });
});
