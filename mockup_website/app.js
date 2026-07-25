document.addEventListener('DOMContentLoaded', () => {
    // Auth Check
    if (localStorage.getItem('isLoggedIn') !== 'true') {
        window.location.href = 'login.html';
        return;
    }

    // Set User Name
    const username = localStorage.getItem('username') || 'Trader';
    const displayEl = document.getElementById('user-display-name');
    if (displayEl) {
        displayEl.textContent = username.charAt(0).toUpperCase() + username.slice(1);
    }
    
    const avatarEl = document.querySelector('.avatar');
    if (avatarEl) {
        avatarEl.textContent = username.charAt(0).toUpperCase();
    }

    // Logout
    document.getElementById('logout-btn').addEventListener('click', () => {
        localStorage.removeItem('isLoggedIn');
        localStorage.removeItem('username');
        window.location.href = 'login.html';
    });

    // Theme Toggle Logic
    const themeToggle = document.getElementById('theme-toggle');
    const htmlElement = document.documentElement;
    const sunIcon = document.querySelector('.sun-icon');
    const moonIcon = document.querySelector('.moon-icon');

    // Check for saved theme
    if (localStorage.getItem('theme') === 'light') {
        htmlElement.setAttribute('data-theme', 'light');
        if (sunIcon) sunIcon.style.display = 'block';
        if (moonIcon) moonIcon.style.display = 'none';
    }

    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const currentTheme = htmlElement.getAttribute('data-theme');
            if (currentTheme === 'light') {
                htmlElement.removeAttribute('data-theme');
                localStorage.setItem('theme', 'dark');
                if (sunIcon) sunIcon.style.display = 'none';
                if (moonIcon) moonIcon.style.display = 'block';
            } else {
                htmlElement.setAttribute('data-theme', 'light');
                localStorage.setItem('theme', 'light');
                if (sunIcon) sunIcon.style.display = 'block';
                if (moonIcon) moonIcon.style.display = 'none';
            }
        });
    }

    // Initialize Chart
    initChart();

    // Populate Table
    populateTable();

    // Start recording this session's interaction timing
    initBehaviorRecorder(username);
});

function initBehaviorRecorder(username) {
    const panel = document.getElementById('behavior-panel');
    if (!panel || !window.BehaviorCollector) {
        return;
    }

    // Resume the recording started on the security questions, if there is one.
    const carried = window.BehaviorCollector.take();
    const collector = window.BehaviorCollector.create(carried);
    collector.start(document);

    const status = document.getElementById('behavior-status');
    if (carried) {
        const origin = document.getElementById('behavior-origin');
        if (origin) {
            origin.hidden = false;
        }
    }
    const baselineBtn = document.getElementById('extract-baseline');
    const sampleBtn = document.getElementById('extract-sample');

    function text(id, value) {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value === null || value === undefined ? '—' : value;
        }
    }

    function refresh() {
        const metrics = collector.metrics();
        const elapsed = Math.floor(metrics.sessionDurationMs / 1000);
        const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const seconds = String(elapsed % 60).padStart(2, '0');

        text('behavior-clock', `${minutes}:${seconds}`);
        text('stat-keystrokes', metrics.keyboard.keystrokes);
        text('stat-keys-per-second', metrics.keyboard.keysPerSecond);
        text('stat-hold', metrics.keyboard.holdMs.mean);
        text('stat-flight', metrics.keyboard.flightMs.mean);
        text('stat-distance', Math.round(metrics.mouse.totalDistancePx));
        text('stat-speed', metrics.mouse.speedPxPerSecond.mean);
        text('stat-peak-speed', metrics.mouse.speedPxPerSecond.max);
        text('stat-direction', metrics.mouse.directionChanges);
        text('stat-moves', metrics.mouse.moveSamples);
        text('stat-clicks', metrics.mouse.clicks);
    }

    refresh();
    setInterval(refresh, 500);

    function setStatus(message, tone) {
        status.textContent = message;
        status.className = `behavior-status${tone ? ` behavior-status-${tone}` : ''}`;
    }

    async function extract(role, button, label) {
        const metrics = collector.metrics();
        if (metrics.keyboard.keystrokes === 0 && metrics.mouse.moveSamples === 0) {
            setStatus('Type and move the pointer first, then extract.', 'warn');
            return;
        }

        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Saving...';

        try {
            const response = await fetch('/api/behavior/' + role, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, metrics })
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(body.error || 'The extract could not be saved.');
            }
            setStatus(
                `${label} saved for ${username}. Open the admin dashboard to cross-reference.`,
                'ok'
            );
        } catch (error) {
            setStatus(error.message, 'error');
        } finally {
            button.disabled = false;
            button.textContent = originalText;
        }
    }

    baselineBtn.addEventListener('click', () => {
        extract('baseline', baselineBtn, 'Real-user baseline');
    });

    sampleBtn.addEventListener('click', () => {
        extract('sample', sampleBtn, 'Cross-reference sample');
    });
}

function initChart() {
    const ctx = document.getElementById('mainChart');
    if (!ctx) return;

    // Generate some mock data for the chart
    const labels = Array.from({length: 30}, (_, i) => `Day ${i + 1}`);
    const dataPoints = [];
    let price = 175;
    for (let i = 0; i < 30; i++) {
        price = price + (Math.random() - 0.45) * 5; // Slight upward bias
        dataPoints.push(Number(price.toFixed(2)));
    }

    new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'AAPL Underlying Price',
                data: dataPoints,
                borderColor: '#6366f1',
                backgroundColor: 'rgba(99, 102, 241, 0.1)',
                borderWidth: 3,
                pointRadius: 0,
                pointHoverRadius: 6,
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    backgroundColor: 'rgba(20, 24, 33, 0.9)',
                    titleColor: '#8a919e',
                    bodyColor: '#fff',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    padding: 10
                }
            },
            scales: {
                x: {
                    grid: {
                        display: false,
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#8a919e',
                        maxTicksLimit: 6
                    }
                },
                y: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#8a919e',
                        callback: function(value) {
                            return '$' + value;
                        }
                    }
                }
            },
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            }
        }
    });
}

function populateTable() {
    const tbody = document.getElementById('options-table-body');
    if (!tbody) return;

    const mockData = [
        { symbol: 'TSLA', type: 'Call', strike: '$200.00', exp: '2024-06-21', vol: '124,532', iv: '54.2%', price: '$12.45' },
        { symbol: 'NVDA', type: 'Call', strike: '$900.00', exp: '2024-05-17', vol: '98,210', iv: '62.1%', price: '$34.20' },
        { symbol: 'AAPL', type: 'Put', strike: '$170.00', exp: '2024-05-17', vol: '85,411', iv: '28.4%', price: '$2.15' },
        { symbol: 'AMD', type: 'Call', strike: '$150.00', exp: '2024-06-21', vol: '65,290', iv: '48.7%', price: '$8.90' },
        { symbol: 'META', type: 'Put', strike: '$450.00', exp: '2024-05-24', vol: '42,105', iv: '35.6%', price: '$5.40' },
    ];

    mockData.forEach(row => {
        const tr = document.createElement('tr');
        
        const typeClass = row.type === 'Call' ? 'badge-call' : 'badge-put';
        
        tr.innerHTML = `
            <td style="font-weight: 600;">${row.symbol}</td>
            <td><span class="badge ${typeClass}">${row.type}</span></td>
            <td>${row.strike}</td>
            <td style="color: var(--text-secondary);">${row.exp}</td>
            <td>${row.vol}</td>
            <td style="color: var(--text-secondary);">${row.iv}</td>
            <td style="font-weight: 500;">${row.price}</td>
        `;
        
        tbody.appendChild(tr);
    });
}
