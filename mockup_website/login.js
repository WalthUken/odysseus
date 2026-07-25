document.addEventListener('DOMContentLoaded', () => {
    // Check if already logged in
    if (localStorage.getItem('isLoggedIn') === 'true') {
        window.location.href = 'index.html';
        return;
    }

    const loginForm = document.getElementById('login-form');
    const securityForm = document.getElementById('security-form');
    const loginError = document.getElementById('login-error');
    
    const step1 = document.getElementById('step-1');
    const step2 = document.getElementById('step-2');

    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const submitBtn = loginForm.querySelector('button[type="submit"]');

        // Add loading state
        const originalText = submitBtn.innerText;
        submitBtn.innerHTML = '<span style="opacity: 0.8">Authenticating...</span>';
        submitBtn.style.pointerEvents = 'none';

        // Simulate network request
        setTimeout(() => {
            if (username === 'username' && password === 'password') {
                // Hide Step 1 and Show Step 2
                step1.style.display = 'none';
                step2.style.display = 'block';
                step2.style.animation = 'slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards';
                
                // Save temp state so we know they passed step 1
                localStorage.setItem('temp_username', username);
            } else {
                // Reset button
                submitBtn.innerHTML = originalText;
                submitBtn.style.pointerEvents = 'auto';
                
                // Show error with shake animation
                loginError.style.display = 'block';
                
                // Remove and re-add element to trigger animation again if needed
                loginError.style.animation = 'none';
                loginError.offsetHeight; // trigger reflow
                loginError.style.animation = 'shake 0.5s ease-in-out';
            }
        }, 800);
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
                window.location.href = 'index.html';
            }, 600);
        }, 800);
    });
});
