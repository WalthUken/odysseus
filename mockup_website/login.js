document.addEventListener('DOMContentLoaded', () => {
    // Always start a fresh session here so the full flow is shown:
    // credentials, then security questions, then the dashboard.
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('username');
    localStorage.removeItem('temp_username');

    // Any recording handed over by an earlier visit is stale here.
    if (window.BehaviorCollector) {
        window.BehaviorCollector.clear();
    }

    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');
    const securityForm = document.getElementById('security-form');
    const loginError = document.getElementById('login-error');
    const signupError = document.getElementById('signup-error');

    const step1 = document.getElementById('step-1');
    const stepSignup = document.getElementById('step-signup');
    const step2 = document.getElementById('step-2');
    const securitySubtitle = document.getElementById('security-subtitle');

    // Recording starts at the security questions and carries on to the
    // dashboard as one continuous session.
    let collector = null;

    function showStep(step) {
        [step1, stepSignup, step2].forEach((section) => {
            section.style.display = section === step ? 'block' : 'none';
        });
        step.style.animation = 'slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards';

        if (step === step2 && !collector && window.BehaviorCollector) {
            collector = window.BehaviorCollector.create();
            collector.start(document);
        }
    }

    function showError(element) {
        element.style.display = 'block';

        // Remove and re-add the animation so it replays on a repeat failure
        element.style.animation = 'none';
        element.offsetHeight; // trigger reflow
        element.style.animation = 'shake 0.5s ease-in-out';
    }

    document.getElementById('show-signup').addEventListener('click', (e) => {
        e.preventDefault();
        loginError.style.display = 'none';
        showStep(stepSignup);
    });

    document.getElementById('show-signin').addEventListener('click', (e) => {
        e.preventDefault();
        signupError.style.display = 'none';
        showStep(step1);
    });

    // Returning here through the back button restores a cached page that can
    // still be sitting on the security step, so rebuild the page from scratch.
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            window.location.reload();
        }
    });

    // Accounts live in a JSON file next to the demo server, so these calls
    // need the page served over http rather than opened as a file.
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

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = document.getElementById('username').value;
        const credentialValue = document.getElementById('password').value;
        const submitBtn = loginForm.querySelector('button[type="submit"]');

        // Add loading state
        const originalText = submitBtn.innerText;
        submitBtn.innerHTML = '<span style="opacity: 0.8">Authenticating...</span>';
        submitBtn.style.pointerEvents = 'none';
        loginError.style.display = 'none';

        try {
            const account = await postJson('/api/login', {
                username,
                password: credentialValue
            });

            securitySubtitle.textContent = 'Please verify your identity to proceed';
            showStep(step2);

            // Save temp state so we know they passed step 1
            localStorage.setItem('temp_username', account.username);
        } catch (error) {
            loginError.textContent = error.message;
            showError(loginError);
        } finally {
            submitBtn.innerHTML = originalText;
            submitBtn.style.pointerEvents = 'auto';
        }
    });

    signupForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = document.getElementById('new-username').value;
        const credentialValue = document.getElementById('new-password').value;
        const confirmValue = document.getElementById('confirm-password').value;
        const submitBtn = signupForm.querySelector('button[type="submit"]');

        if (credentialValue !== confirmValue) {
            signupError.textContent = 'Passwords do not match';
            showError(signupError);
            return;
        }

        const originalText = submitBtn.innerText;
        submitBtn.innerHTML = '<span style="opacity: 0.8">Creating account...</span>';
        submitBtn.style.pointerEvents = 'none';
        signupError.style.display = 'none';

        try {
            const account = await postJson('/api/signup', {
                username,
                password: credentialValue
            });

            // New accounts set their answers, then land on the same dashboard
            securitySubtitle.textContent = 'Set the answers used to verify you later';
            showStep(step2);

            localStorage.setItem('temp_username', account.username);
        } catch (error) {
            signupError.textContent = error.message;
            showError(signupError);
        } finally {
            submitBtn.innerHTML = originalText;
            submitBtn.style.pointerEvents = 'auto';
        }
    });

    securityForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const submitBtn = securityForm.querySelector('button[type="submit"]');
        
        submitBtn.innerHTML = '<span style="opacity: 0.8">Verifying...</span>';
        submitBtn.style.pointerEvents = 'none';
        
        setTimeout(() => {
            // "Any answers can work" - we accept any non-empty input as valid
            const username = localStorage.getItem('temp_username') || 'Trader';
            localStorage.setItem('isLoggedIn', 'true');
            localStorage.setItem('username', username);
            localStorage.removeItem('temp_username');
            
            // Success animation before redirect
            submitBtn.innerHTML = 'Identity Confirmed ✓';
            submitBtn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
            
            setTimeout(() => {
                // Hand the running recording to the dashboard as late as
                // possible so the final clicks here are included.
                if (collector && window.BehaviorCollector) {
                    window.BehaviorCollector.save(collector);
                }
                window.location.href = 'index.html';
            }, 600);
        }, 800);
    });
});
