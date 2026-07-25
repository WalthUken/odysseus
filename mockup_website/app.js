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

    // Ticker detail view + order ticket
    setupTickerInteractions();
    renderRecentOrders();

    // Silent behavioral telemetry collection
    initTelemetry();
});

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

        tr.className = 'ticker-row';
        tr.dataset.symbol = row.symbol;
        tr.setAttribute('role', 'button');
        tr.setAttribute('tabindex', '0');
        tr.setAttribute('aria-label', `Open ${row.symbol} details and order ticket`);

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

/* ============================================================
   Ticker detail view + order ticket
   ============================================================ */

// Base facts per symbol. Everything else (ranges, volume, market cap,
// price history) is derived deterministically from the symbol so the
// detail view is stable across opens.
const TICKER_INFO = {
    SPY:  { name: 'SPDR S&P 500 ETF',      price: 512.45, changePct: 1.24,  changeAbs: 6.28,  shares: 920 },
    QQQ:  { name: 'Invesco QQQ Trust',     price: 438.12, changePct: -0.45, changeAbs: -1.98, shares: 445 },
    NVDA: { name: 'NVIDIA Corporation',    price: 875.28, changePct: 3.82,  changeAbs: 32.18, shares: 2470 },
    TSLA: { name: 'Tesla, Inc.',           price: 201.34, changePct: 0.86,  changeAbs: 1.72,  shares: 3180 },
    AAPL: { name: 'Apple Inc.',            price: 172.51, changePct: -0.34, changeAbs: -0.59, shares: 15400 },
    AMD:  { name: 'Advanced Micro Devices', price: 151.20, changePct: 1.15, changeAbs: 1.72,  shares: 1620 },
    META: { name: 'Meta Platforms, Inc.',  price: 452.10, changePct: -0.72, changeAbs: -3.28, shares: 2550 }
};

// Deterministic PRNG so a symbol always renders the same fake data.
function hashString(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function formatCurrency(value) {
    return '$' + Number(value).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatCompact(value) {
    const abs = Math.abs(value);
    if (abs >= 1e12) return '$' + (value / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
    return '$' + value.toFixed(2);
}

function formatInteger(value) {
    return Math.round(value).toLocaleString('en-US');
}

// Build a full, deterministic detail record for a symbol.
function buildTickerDetail(symbol) {
    const info = TICKER_INFO[symbol] || {
        name: symbol,
        price: 100,
        changePct: 0,
        changeAbs: 0,
        shares: 1000
    };
    const rand = mulberry32(hashString(symbol));
    const price = info.price;

    const dayLow = price * (1 - (0.004 + rand() * 0.012));
    const dayHigh = price * (1 + (0.004 + rand() * 0.012));
    const week52Low = price * (1 - (0.18 + rand() * 0.22));
    const week52High = price * (1 + (0.14 + rand() * 0.28));
    const prevClose = price - info.changeAbs;
    const open = prevClose * (1 + (rand() - 0.5) * 0.01);
    const volume = Math.round((8 + rand() * 42) * 1e6);
    const avgVolume = Math.round(volume * (0.75 + rand() * 0.5));
    const marketCap = price * info.shares * 1e6;
    const peRatio = (12 + rand() * 34).toFixed(1);
    const beta = (0.6 + rand() * 1.4).toFixed(2);
    const dividendYield = (rand() * 2.4).toFixed(2);

    // 90-session deterministic price history that lands near current price.
    const points = 90;
    const history = [];
    let cursor = price * (0.82 + rand() * 0.12);
    for (let i = 0; i < points; i++) {
        const drift = (price - cursor) * 0.04;
        const noise = (rand() - 0.5) * price * 0.03;
        cursor = Math.max(week52Low * 0.95, cursor + drift + noise);
        history.push(Number(cursor.toFixed(2)));
    }
    history[points - 1] = Number(price.toFixed(2));

    return {
        symbol: symbol,
        name: info.name,
        price: price,
        changePct: info.changePct,
        changeAbs: info.changeAbs,
        dayLow: dayLow,
        dayHigh: dayHigh,
        week52Low: week52Low,
        week52High: week52High,
        prevClose: prevClose,
        open: open,
        volume: volume,
        avgVolume: avgVolume,
        marketCap: marketCap,
        peRatio: peRatio,
        beta: beta,
        dividendYield: dividendYield,
        history: history
    };
}

// Module-level state for the modal / order ticket.
const modalState = {
    detail: null,
    side: 'buy',
    chart: null,
    lastFocused: null
};

function setupTickerInteractions() {
    // Make the market cards clickable + keyboard accessible.
    document.querySelectorAll('.stock-card').forEach(card => {
        const symbolEl = card.querySelector('.stock-symbol');
        if (!symbolEl) return;
        const symbol = symbolEl.textContent.trim();
        card.dataset.symbol = symbol;
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `Open ${symbol} details and order ticket`);
    });

    // Delegate clicks / keyboard for cards and table rows.
    document.addEventListener('click', event => {
        const trigger = event.target.closest('.stock-card[data-symbol], tr.ticker-row[data-symbol]');
        if (trigger) {
            openTickerModal(trigger.dataset.symbol);
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') {
            return;
        }
        const trigger = event.target.closest('.stock-card[data-symbol], tr.ticker-row[data-symbol]');
        if (trigger) {
            event.preventDefault();
            openTickerModal(trigger.dataset.symbol);
        }
    });

    // Modal controls.
    const modal = document.getElementById('ticker-modal');
    const closeBtn = document.getElementById('ticker-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', closeTickerModal);
    if (modal) {
        modal.addEventListener('click', event => {
            if (event.target === modal) closeTickerModal();
        });
    }
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && modal && !modal.hidden) {
            closeTickerModal();
        }
    });

    setupOrderTicket();
}

function openTickerModal(symbol) {
    const modal = document.getElementById('ticker-modal');
    if (!modal) return;

    const detail = buildTickerDetail(symbol);
    modalState.detail = detail;
    modalState.lastFocused = document.activeElement;

    const positive = detail.changePct >= 0;
    const sign = positive ? '+' : '-';

    document.getElementById('ticker-modal-title').textContent = detail.symbol;
    document.getElementById('ticker-modal-subtitle').textContent = detail.name;
    document.getElementById('ticker-modal-price').textContent = formatCurrency(detail.price);

    const changeEl = document.getElementById('ticker-modal-change');
    changeEl.className = 'stock-change ' + (positive ? 'change-positive' : 'change-negative');
    changeEl.textContent = `${sign}${Math.abs(detail.changePct).toFixed(2)}% (${sign}${formatCurrency(Math.abs(detail.changeAbs))})`;

    // Stats grid.
    const stats = [
        { label: 'Day range', value: `${formatCurrency(detail.dayLow)} - ${formatCurrency(detail.dayHigh)}` },
        { label: '52-week range', value: `${formatCurrency(detail.week52Low)} - ${formatCurrency(detail.week52High)}` },
        { label: 'Open', value: formatCurrency(detail.open) },
        { label: 'Prev close', value: formatCurrency(detail.prevClose) },
        { label: 'Volume', value: formatInteger(detail.volume) },
        { label: 'Avg volume', value: formatInteger(detail.avgVolume) },
        { label: 'Market cap', value: formatCompact(detail.marketCap) },
        { label: 'P/E ratio', value: detail.peRatio },
        { label: 'Beta', value: detail.beta },
        { label: 'Div yield', value: detail.dividendYield + '%' }
    ];
    const statsEl = document.getElementById('ticker-modal-stats');
    statsEl.innerHTML = stats.map(stat => `
        <div class="modal-stat">
            <div class="modal-stat-label">${stat.label}</div>
            <div class="modal-stat-value">${stat.value}</div>
        </div>
    `).join('');

    renderDetailChart(detail);
    resetOrderTicket(detail);

    modal.hidden = false;
    document.body.style.overflow = 'hidden';

    const closeBtn = document.getElementById('ticker-modal-close');
    if (closeBtn) closeBtn.focus();
}

function closeTickerModal() {
    const modal = document.getElementById('ticker-modal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.style.overflow = '';
    if (modalState.chart) {
        modalState.chart.destroy();
        modalState.chart = null;
    }
    if (modalState.lastFocused && typeof modalState.lastFocused.focus === 'function') {
        modalState.lastFocused.focus();
    }
}

function renderDetailChart(detail) {
    const ctx = document.getElementById('detailChart');
    if (!ctx || typeof Chart === 'undefined') return;

    if (modalState.chart) {
        modalState.chart.destroy();
        modalState.chart = null;
    }

    const positive = detail.changePct >= 0;
    const lineColor = positive ? '#10b981' : '#ef4444';
    const fillColor = positive ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)';
    const labels = detail.history.map((_, i) => `S${i + 1}`);

    modalState.chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: `${detail.symbol} price`,
                data: detail.history,
                borderColor: lineColor,
                backgroundColor: fillColor,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 5,
                fill: true,
                tension: 0.35
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    backgroundColor: 'rgba(20, 24, 33, 0.9)',
                    titleColor: '#8a919e',
                    bodyColor: '#fff',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    padding: 10,
                    callbacks: {
                        label: context => '$' + context.parsed.y
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: '#8a919e', maxTicksLimit: 6 }
                },
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: {
                        color: '#8a919e',
                        callback: value => '$' + value
                    }
                }
            },
            interaction: { mode: 'nearest', axis: 'x', intersect: false }
        }
    });
}

function setupOrderTicket() {
    const form = document.getElementById('order-ticket');
    if (!form) return;

    const buyBtn = document.getElementById('order-side-buy');
    const sellBtn = document.getElementById('order-side-sell');
    const qtyInput = document.getElementById('order-quantity');
    const limitInput = document.getElementById('order-limit');

    function selectSide(side) {
        modalState.side = side;
        const isBuy = side === 'buy';
        buyBtn.classList.toggle('is-active', isBuy);
        sellBtn.classList.toggle('is-active', !isBuy);
        buyBtn.setAttribute('aria-pressed', String(isBuy));
        sellBtn.setAttribute('aria-pressed', String(!isBuy));
        const submit = document.getElementById('order-submit');
        if (submit) submit.textContent = isBuy ? 'Place buy order' : 'Place sell order';
    }

    buyBtn.addEventListener('click', () => selectSide('buy'));
    sellBtn.addEventListener('click', () => selectSide('sell'));

    qtyInput.addEventListener('input', updateEstimate);
    limitInput.addEventListener('input', updateEstimate);

    form.addEventListener('submit', event => {
        event.preventDefault();
        submitOrder();
    });
}

function resetOrderTicket(detail) {
    const qtyInput = document.getElementById('order-quantity');
    const limitInput = document.getElementById('order-limit');
    const confirmation = document.getElementById('order-confirmation');
    const submit = document.getElementById('order-submit');

    if (qtyInput) qtyInput.value = '';
    if (limitInput) limitInput.value = detail ? detail.price.toFixed(2) : '';
    if (confirmation) {
        confirmation.hidden = true;
        confirmation.textContent = '';
    }

    modalState.side = 'buy';
    const buyBtn = document.getElementById('order-side-buy');
    const sellBtn = document.getElementById('order-side-sell');
    if (buyBtn && sellBtn) {
        buyBtn.classList.add('is-active');
        sellBtn.classList.remove('is-active');
        buyBtn.setAttribute('aria-pressed', 'true');
        sellBtn.setAttribute('aria-pressed', 'false');
    }
    if (submit) submit.textContent = 'Place buy order';

    updateEstimate();
}

function currentEstimate() {
    const detail = modalState.detail;
    const qty = parseFloat(document.getElementById('order-quantity').value) || 0;
    const limitRaw = parseFloat(document.getElementById('order-limit').value);
    const unit = Number.isFinite(limitRaw) && limitRaw > 0
        ? limitRaw
        : (detail ? detail.price : 0);
    return { qty: qty, unit: unit, total: qty * unit };
}

function updateEstimate() {
    const totalEl = document.getElementById('order-estimate-total');
    if (!totalEl) return;
    const { total } = currentEstimate();
    totalEl.textContent = formatCurrency(total);
}

function submitOrder() {
    const detail = modalState.detail;
    if (!detail) return;

    const { qty, unit, total } = currentEstimate();
    const confirmation = document.getElementById('order-confirmation');

    if (!qty || qty <= 0) {
        if (confirmation) {
            confirmation.hidden = false;
            confirmation.style.background = 'rgba(239, 68, 68, 0.1)';
            confirmation.style.borderColor = 'rgba(239, 68, 68, 0.25)';
            confirmation.style.color = 'var(--danger-color)';
            confirmation.textContent = 'Enter a quantity of at least 1 to place an order.';
        }
        const qtyInput = document.getElementById('order-quantity');
        if (qtyInput) qtyInput.focus();
        return;
    }

    const order = {
        id: 'ord_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        symbol: detail.symbol,
        side: modalState.side,
        qty: qty,
        limit: unit,
        total: total,
        time: Date.now()
    };

    saveOrder(order);
    renderRecentOrders();

    if (confirmation) {
        confirmation.hidden = false;
        confirmation.style.background = 'rgba(16, 185, 129, 0.1)';
        confirmation.style.borderColor = 'rgba(16, 185, 129, 0.25)';
        confirmation.style.color = 'var(--success-color)';
        const verb = order.side === 'buy' ? 'Bought' : 'Sold';
        confirmation.textContent =
            `${verb} ${order.qty} ${order.symbol} @ ${formatCurrency(order.limit)} limit · total ${formatCurrency(order.total)}.`;
    }

    // Ready the ticket for another order without closing the view.
    const qtyInput = document.getElementById('order-quantity');
    if (qtyInput) {
        qtyInput.value = '';
        qtyInput.focus();
    }
    updateEstimate();
}

/* ============================================================
   Recent orders (persisted in localStorage)
   ============================================================ */

const ORDERS_STORAGE_KEY = 'optionsflow_orders';

function loadOrders() {
    try {
        const raw = localStorage.getItem(ORDERS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function saveOrder(order) {
    const orders = loadOrders();
    orders.unshift(order);
    // Keep the visible history bounded.
    const trimmed = orders.slice(0, 20);
    try {
        localStorage.setItem(ORDERS_STORAGE_KEY, JSON.stringify(trimmed));
    } catch (error) {
        // Storage unavailable; the in-session render below still works.
    }
}

function formatOrderTime(timestamp) {
    try {
        return new Date(timestamp).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (error) {
        return '';
    }
}

function renderRecentOrders() {
    const list = document.getElementById('recent-orders-list');
    const empty = document.getElementById('orders-empty');
    const count = document.getElementById('orders-count');
    if (!list) return;

    const orders = loadOrders();

    if (count) {
        count.textContent = orders.length
            ? `${orders.length} order${orders.length === 1 ? '' : 's'}`
            : '';
    }

    if (!orders.length) {
        list.innerHTML = '';
        if (empty) empty.style.display = 'block';
        return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = orders.map(order => {
        const sideClass = order.side === 'buy' ? 'side-buy' : 'side-sell';
        const sideLabel = order.side === 'buy' ? 'Buy' : 'Sell';
        return `
            <li class="order-row">
                <div class="order-row-left">
                    <span class="order-side-tag ${sideClass}">${sideLabel}</span>
                    <div>
                        <div class="order-row-symbol">${order.symbol}</div>
                        <div class="order-row-meta">${order.qty} @ ${formatCurrency(order.limit)} limit</div>
                    </div>
                </div>
                <div class="order-row-right">
                    <div class="order-row-total">${formatCurrency(order.total)}</div>
                    <div class="order-row-time">${formatOrderTime(order.time)}</div>
                </div>
            </li>
        `;
    }).join('');
}

/* ============================================================
   Silent behavioral telemetry
   ------------------------------------------------------------
   Adapted from public/telemetry.js. Same feature names and
   semantics. The mockup is served from a different origin, so
   the collector is reimplemented here rather than imported.
   Keyboard source: the order-ticket quantity / limit inputs.
   Pointer source: the whole document.
   Nothing about this is ever shown to the user.
   ============================================================ */

const TELEMETRY_FEATURE_NAMES = [
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
    'pointerJitterDeviation',
    // Burst / pause structure, from inter-keydown gaps alone. Two people can
    // share a key interval while one reaches it with long fast runs and rare
    // long pauses and the other with short runs and frequent short ones, and
    // the global average cannot tell those apart. Mean burst length is not
    // emitted because it is the reciprocal of the pause ratio; burst-length
    // spread, mean pause duration, and the pause-to-burst ratio are not
    // emitted because they were measured to dilute the score rather than
    // sharpen it. Identical set and semantics to public/telemetry.js.
    'downDownPauseRatio',
    'downDownInBurstMean',
    // Key-class transition timing: how much slower (positive) or faster
    // (negative) one coarse class of transition runs than this person's own
    // in-burst average. See KEY CLASS SCHEME below.
    'downDownSameHandBias',
    'downDownAlternateHandBias',
    'downDownVowelConsonantBias',
    'downDownConsonantRunBias',
    'downDownWordBoundaryBias',
    'downDownSymbolBias'
];

// Gaps at or above this are a thinking pause rather than part of a burst. The
// value matches PAUSE_THRESHOLD_MS in public/diagnostics.js, so identity
// features and reported typing diagnostics describe the same structure.
const TELEMETRY_PAUSE_THRESHOLD_MS = 500;
// Longer than this is the user walking away, not a pause inside a session.
const TELEMETRY_IDLE_BREAK_MS = 60000;
// Pseudo-observations pulling a barely-seen class pair back toward "no bias".
const TELEMETRY_CLASS_PRIOR_SAMPLES = 4;

/* ================= KEY CLASS SCHEME (privacy boundary) =================
   The browser never sends key identities, keycodes, or raw key events, and
   that promise holds here. Each keydown is reduced *at collection time* to one
   of eight coarse classes; the key itself is discarded in the same statement
   that produced the class, is never stored, and never leaves classifyTelemetryKey().
   What the vector carries is six averages of inter-key gaps grouped by the
   class of the pair - an aggregate over a whole window, not a sequence, so it
   cannot be inverted into a key, a keycode, or typed text.

     0 OTHER            modifiers, navigation, function keys, IME output
     1 WHITESPACE       space, Enter, Tab (word and line boundaries)
     2 DIGIT            0-9
     3 SYMBOL           punctuation and other single-character keys
     4 LEFT_CONSONANT   q w r t s d f g z x c v b
     5 LEFT_VOWEL       a e
     6 RIGHT_CONSONANT  y p h j k l n m
     7 RIGHT_VOWEL      u i o

   Hands follow the QWERTY split; on another layout the split is still
   deterministic for that user, so it stays a stable personal trait. Twenty-six
   letters share four buckets, so a class carries about two bits and a pair
   about four - and even that is only ever released as a mean over many
   keystrokes. This scheme must stay identical to the one in
   public/telemetry.js: a profile enrolled on one surface is verified on the
   other, so the two collectors have to agree on every class boundary.
   ====================================================================== */
const TELEMETRY_KEY_CLASS = {
    OTHER: 0,
    WHITESPACE: 1,
    DIGIT: 2,
    SYMBOL: 3,
    LEFT_CONSONANT: 4,
    LEFT_VOWEL: 5,
    RIGHT_CONSONANT: 6,
    RIGHT_VOWEL: 7
};

const TELEMETRY_LEFT_HAND_LETTERS = 'qwertasdfgzxcvb';
const TELEMETRY_VOWEL_LETTERS = 'aeiou';
const TELEMETRY_CLASS_PAIR_NAMES = [
    'sameHand',
    'alternateHand',
    'vowelConsonant',
    'consonantRun',
    'wordBoundary',
    'symbol'
];

function classifyTelemetryKey(event) {
    const key = event && typeof event.key === 'string' ? event.key : '';
    if (key === ' ' || key === 'Spacebar' || key === 'Enter' || key === 'Tab') {
        return TELEMETRY_KEY_CLASS.WHITESPACE;
    }
    if (key.length !== 1) {
        // Named keys (Shift, Backspace, ArrowLeft, F5, Process, ...).
        return TELEMETRY_KEY_CLASS.OTHER;
    }
    if (key >= '0' && key <= '9') {
        return TELEMETRY_KEY_CLASS.DIGIT;
    }
    const lower = key.toLowerCase();
    if (lower < 'a' || lower > 'z' || lower.length !== 1) {
        // A letter outside the Latin alphabet says nothing about hands here, so
        // it is grouped with the unclassified keys rather than with punctuation.
        return /\p{L}/u.test(key)
            ? TELEMETRY_KEY_CLASS.OTHER
            : TELEMETRY_KEY_CLASS.SYMBOL;
    }
    const leftHand = TELEMETRY_LEFT_HAND_LETTERS.indexOf(lower) >= 0;
    const vowel = TELEMETRY_VOWEL_LETTERS.indexOf(lower) >= 0;
    if (leftHand) {
        return vowel
            ? TELEMETRY_KEY_CLASS.LEFT_VOWEL
            : TELEMETRY_KEY_CLASS.LEFT_CONSONANT;
    }
    return vowel
        ? TELEMETRY_KEY_CLASS.RIGHT_VOWEL
        : TELEMETRY_KEY_CLASS.RIGHT_CONSONANT;
}

// Categories overlap on purpose: a left-hand "th" is both a same-hand pair and
// a consonant run, and each aggregate answers a different question.
function telemetryClassPairCategories(previous, current) {
    const isLetter = value => value >= TELEMETRY_KEY_CLASS.LEFT_CONSONANT;
    const isLeft = value => (
        value === TELEMETRY_KEY_CLASS.LEFT_CONSONANT ||
        value === TELEMETRY_KEY_CLASS.LEFT_VOWEL
    );
    const isVowel = value => (
        value === TELEMETRY_KEY_CLASS.LEFT_VOWEL ||
        value === TELEMETRY_KEY_CLASS.RIGHT_VOWEL
    );
    const isConsonant = value => (
        value === TELEMETRY_KEY_CLASS.LEFT_CONSONANT ||
        value === TELEMETRY_KEY_CLASS.RIGHT_CONSONANT
    );
    const isSymbol = value => (
        value === TELEMETRY_KEY_CLASS.DIGIT ||
        value === TELEMETRY_KEY_CLASS.SYMBOL
    );

    const categories = [];
    if (isLetter(previous) && isLetter(current)) {
        categories.push(
            isLeft(previous) === isLeft(current) ? 'sameHand' : 'alternateHand'
        );
    }
    if (isVowel(previous) && isConsonant(current)) {
        categories.push('vowelConsonant');
    }
    if (isConsonant(previous) && isConsonant(current)) {
        categories.push('consonantRun');
    }
    if (
        previous === TELEMETRY_KEY_CLASS.WHITESPACE ||
        current === TELEMETRY_KEY_CLASS.WHITESPACE
    ) {
        categories.push('wordBoundary');
    }
    if (isSymbol(previous) || isSymbol(current)) {
        categories.push('symbol');
    }
    return categories;
}

const TELEMETRY_DEFAULTS = {
    pointerThrottleMs: 80,
    minimumDwellSamples: 10,
    minimumFlightSamples: 8,
    minimumDownDownSamples: 8,
    minimumPointerSamples: 8,
    maximumMetricSamples: 240,
    requireTrustedEvents: true
};

function createBehaviorCollector(options) {
    const supplied = options || {};
    const config = Object.assign({}, TELEMETRY_DEFAULTS, supplied);
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

    function createRhythmState() {
        const classPairs = {};
        TELEMETRY_CLASS_PAIR_NAMES.forEach(name => {
            classPairs[name] = { count: 0, total: 0 };
        });
        return {
            pauseCount: 0,
            inBurstCount: 0,
            inBurstTotal: 0,
            classPairs: classPairs,
            lastKeyClass: null
        };
    }

    // Folds one keydown into the burst/pause structure and, when the gap falls
    // inside a burst, into the class-pair aggregates. `gap` is null when no
    // previous keydown is comparable (window start, or a visibility break).
    function recordRhythm(rhythm, gap, keyClass) {
        const continues = (
            typeof gap === 'number' &&
            Number.isFinite(gap) &&
            gap >= 0 &&
            gap <= TELEMETRY_IDLE_BREAK_MS
        );

        if (!continues) {
            rhythm.lastKeyClass = keyClass;
            return;
        }

        if (gap >= TELEMETRY_PAUSE_THRESHOLD_MS) {
            rhythm.pauseCount += 1;
            rhythm.lastKeyClass = keyClass;
            return;
        }

        rhythm.inBurstCount += 1;
        rhythm.inBurstTotal += gap;

        // Class-pair timing is a motor measurement, so it uses in-burst gaps
        // only. Including thinking pauses would measure where someone stopped
        // to think, not which key combinations their hands stumble over.
        if (rhythm.lastKeyClass !== null) {
            const categories = telemetryClassPairCategories(
                rhythm.lastKeyClass,
                keyClass
            );
            for (let index = 0; index < categories.length; index += 1) {
                const aggregate = rhythm.classPairs[categories[index]];
                aggregate.count += 1;
                aggregate.total += gap;
            }
        }
        rhythm.lastKeyClass = keyClass;
    }

    // A bias around zero rather than a ratio around one, so a window with no
    // keystrokes reports exactly zero and the server reads it as "no signal"
    // instead of as a confident measurement.
    function classPairBias(aggregate, referenceMean) {
        if (
            !aggregate ||
            aggregate.count === 0 ||
            !Number.isFinite(referenceMean) ||
            referenceMean <= 0
        ) {
            return 0;
        }
        const observed = aggregate.total / aggregate.count / referenceMean;
        const shrunk = (
            ((observed * aggregate.count) + TELEMETRY_CLASS_PRIOR_SAMPLES) /
            (aggregate.count + TELEMETRY_CLASS_PRIOR_SAMPLES)
        );
        return shrunk - 1;
    }

    function summarizeRhythm(rhythm) {
        const intervalCount = rhythm.pauseCount + rhythm.inBurstCount;
        const inBurstMean = rhythm.inBurstCount > 0
            ? rhythm.inBurstTotal / rhythm.inBurstCount
            : 0;
        return {
            pauseRatio: intervalCount > 0
                ? rhythm.pauseCount / intervalCount
                : 0,
            inBurstMean: inBurstMean,
            classPairBias: TELEMETRY_CLASS_PAIR_NAMES.map(
                name => classPairBias(rhythm.classPairs[name], inBurstMean)
            )
        };
    }

    const state = {
        started: false,
        metrics: null,
        activePresses: [],
        keystrokeRhythm: createRhythmState(),
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
        // Burst structure and class-pair timing. Holds counters and one coarse
        // class code for the previous key, never a key, keycode, or character.
        state.keystrokeRhythm = createRhythmState();
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
        // The key is read here and discarded here: only the coarse class code
        // survives this statement, and only aggregates of it are ever emitted.
        const keyClass = classifyTelemetryKey(event);

        recordRhythm(
            state.keystrokeRhythm,
            state.lastKeyDownAt === null
                ? null
                : timestamp - state.lastKeyDownAt,
            keyClass
        );

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
            state.keystrokeRhythm.lastKeyClass = null;
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

    function finalize() {
        if (!isReady()) {
            return { ok: false };
        }
        const dwell = summarize(state.metrics.dwell);
        const flight = summarize(state.metrics.flight);
        const downDown = summarize(state.metrics.downDown);
        const pointerVelocity = summarize(state.metrics.pointerVelocity);
        const pointerAcceleration = summarize(state.metrics.pointerAcceleration);
        const pointerJitter = summarize(state.metrics.pointerJitter);
        const rhythm = summarizeRhythm(state.keystrokeRhythm);

        const featureValues = [
            dwell[0], dwell[1],
            flight[0], flight[1],
            downDown[0], downDown[1],
            pointerVelocity[0], pointerVelocity[1],
            pointerAcceleration[0], pointerAcceleration[1],
            pointerJitter[0], pointerJitter[1],
            rhythm.pauseRatio,
            rhythm.inBurstMean
        ].concat(rhythm.classPairBias)
            .map(value => Number(value.toFixed(6)));

        const vector = {};
        TELEMETRY_FEATURE_NAMES.forEach((name, index) => {
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
        isReady: isReady,
        finalize: finalize
    };
}

function initTelemetry() {
    // Guard: telemetry must never interrupt the page. Any failure here is
    // swallowed so the user experience is unaffected.
    try {
        runTelemetry();
    } catch (error) {
        // Silent by design.
    }
}

function runTelemetry() {
    const qtyInput = document.getElementById('order-quantity');
    const limitInput = document.getElementById('order-limit');

    // The order-entry inputs are the keyboard source (backend bot detection
    // is keyboard-weighted). Listen at the document level and filter to the
    // two inputs so search-bar typing is never captured.
    const collector = createBehaviorCollector({
        keyboardTarget: document,
        pointerTarget: document,
        shouldCaptureKeyboard: event => {
            const target = event.target;
            return target === qtyInput || target === limitInput;
        }
    });
    collector.start();

    // Sending state machine. Ready samples are buffered and only removed
    // once their POST succeeds, so a failed request never loses data.
    const buffer = [];
    const MAX_BUFFER = 40;
    let enrolled = false;
    let inFlight = false;

    function endpoint(pathname) {
        // Same-origin as the mockup (port 4000).
        return pathname;
    }

    function post(pathname, body) {
        return fetch(endpoint(pathname), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            keepalive: true
        }).then(response => {
            if (!response || !response.ok) {
                throw new Error('bad status');
            }
            return response;
        });
    }

    function flush() {
        if (inFlight) return;

        if (!enrolled) {
            // Accumulate until we have 5 ready samples, then enroll once.
            if (buffer.length < 5) return;
            inFlight = true;
            const batch = buffer.slice(0, 5);
            post('/api/telemetry/enroll', {
                samples: batch.map(entry => entry.vector)
            }).then(() => {
                buffer.splice(0, 5);
                enrolled = true;
            }).catch(() => {
                // Keep the buffer; retry on the next cycle.
            }).finally(() => {
                inFlight = false;
            });
            return;
        }

        // Enrolled: verify each subsequent ready sample, oldest first.
        if (!buffer.length) return;
        inFlight = true;
        const entry = buffer[0];
        post('/api/telemetry/verify', {
            vector: entry.vector,
            interactionEvidence: entry.interactionEvidence
        }).then(() => {
            buffer.shift();
        }).catch(() => {
            // Keep the buffer; retry on the next cycle.
        }).finally(() => {
            inFlight = false;
            if (buffer.length) {
                // Drain remaining samples promptly.
                setTimeout(flush, 400);
            }
        });
    }

    // Collection cycle: harvest a ready sample, buffer it, attempt a send.
    setInterval(() => {
        try {
            if (collector.isReady()) {
                const sample = collector.finalize();
                if (sample.ok) {
                    buffer.push({
                        vector: sample.vector,
                        interactionEvidence: {
                            trustedEventsRequired: sample.integrity.trustedEventsRequired,
                            rejectedSyntheticEvents: sample.integrity.rejectedSyntheticEvents,
                            durationMs: sample.durationMs,
                            sampleCounts: {
                                dwell: sample.counts.dwell,
                                flight: sample.counts.flight,
                                downDown: sample.counts.downDown,
                                pointer: sample.counts.pointer
                            }
                        }
                    });
                    if (buffer.length > MAX_BUFFER) {
                        buffer.splice(0, buffer.length - MAX_BUFFER);
                    }
                }
            }
            flush();
        } catch (error) {
            // Silent by design; retry next cycle.
        }
    }, 1500);
}
