document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('report-form');
    const usernameField = document.getElementById('report-username');
    const status = document.getElementById('report-status');
    const verdictBox = document.getElementById('verdict-box');
    const verdictTitle = document.getElementById('verdict-title');
    const verdictDetail = document.getElementById('verdict-detail');
    const results = document.getElementById('results');
    const body = document.getElementById('comparison-body');
    const raw = document.getElementById('raw');
    const rawJson = document.getElementById('raw-json');

    // Convenience for the demo: prefill whoever is signed in on this browser.
    const signedIn = localStorage.getItem('username');
    if (signedIn) {
        usernameField.value = signedIn;
    }

    function setStatus(message, tone) {
        status.textContent = message || '';
        status.className = `behavior-status${tone ? ` behavior-status-${tone}` : ''}`;
    }

    function formatNumber(value) {
        return value === null || value === undefined ? 'no data' : String(value);
    }

    function formatTime(value) {
        if (!value) {
            return '—';
        }
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function renderVerdict(comparison, hasBaseline) {
        verdictBox.hidden = false;

        if (!hasBaseline) {
            verdictBox.className = 'glass-panel admin-section verdict-neutral';
            verdictTitle.textContent = 'No real-user extract yet';
            verdictDetail.textContent =
                'Press button 1 on the dashboard to save the reference session '
                + 'before a later session can be checked against it.';
            return;
        }

        if (!comparison) {
            verdictBox.className = 'glass-panel admin-section verdict-neutral';
            verdictTitle.textContent = 'Waiting for the second extract';
            verdictDetail.textContent =
                'A real-user extract is saved. Sign in again, use the site, then '
                + 'press button 2 on the dashboard to record a session to compare.';
            return;
        }

        if (comparison.verdict === 'insufficient_data') {
            verdictBox.className = 'glass-panel admin-section verdict-neutral';
            verdictTitle.textContent = 'Not enough recorded activity';
            verdictDetail.textContent =
                `Each session needs at least ${comparison.thresholds.minimumSamples} `
                + 'samples of typing and pointer movement before the speeds can be compared.';
            return;
        }

        const fraud = comparison.verdict === 'different_user';
        verdictBox.className = `glass-panel admin-section ${fraud ? 'verdict-alert' : 'verdict-ok'}`;
        verdictTitle.textContent = fraud
            ? 'You are not the real user'
            : 'Consistent with the real user';

        const largest = comparison.largestDifference;
        verdictDetail.textContent = [
            `Average difference across ${comparison.comparedMetrics} statistics: `
            + `${comparison.averageDifference}%.`,
            largest
                ? `Largest gap: ${largest.label} at ${largest.differencePercent}%.`
                : '',
            `Flagged when the average passes ${comparison.thresholds.averagePercent}% `
            + `or any single statistic passes ${comparison.thresholds.singleMetricPercent}%.`
        ].filter(Boolean).join(' ');
    }

    function renderRows(comparison) {
        body.replaceChildren();
        if (!comparison) {
            results.hidden = true;
            return;
        }

        results.hidden = false;
        for (const row of comparison.rows) {
            const tr = document.createElement('tr');

            const label = document.createElement('td');
            label.textContent = `${row.label}`;

            const baseline = document.createElement('td');
            baseline.textContent = formatNumber(row.baseline);

            const sample = document.createElement('td');
            sample.textContent = formatNumber(row.sample);

            const difference = document.createElement('td');
            if (!row.comparable || row.differencePercent === null) {
                difference.textContent = 'not compared';
                difference.className = 'diff-muted';
            } else {
                difference.textContent = `${row.differencePercent}%`;
                const high = (
                    row.differencePercent > comparison.thresholds.singleMetricPercent
                );
                const medium = (
                    row.differencePercent > comparison.thresholds.averagePercent
                );
                difference.className = high
                    ? 'diff-high'
                    : medium
                        ? 'diff-medium'
                        : 'diff-low';
            }

            tr.append(label, baseline, sample, difference);
            body.append(tr);
        }
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const username = usernameField.value.trim();
        setStatus('Loading the saved extracts...', 'working');

        try {
            const response = await fetch(
                `/api/behavior/report?username=${encodeURIComponent(username)}`
            );
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(payload.error || 'The report could not be loaded.');
            }

            setStatus('', null);
            document.getElementById('baseline-time').textContent =
                formatTime(payload.baseline?.capturedAt);
            document.getElementById('sample-time').textContent =
                formatTime(payload.sample?.capturedAt);

            renderVerdict(payload.comparison, Boolean(payload.baseline));
            renderRows(payload.comparison);

            raw.hidden = false;
            rawJson.textContent = JSON.stringify(
                {
                    baseline: payload.baseline,
                    sample: payload.sample,
                    enhanced: payload.enhanced
                },
                null,
                2
            );
        } catch (error) {
            setStatus(error.message, 'error');
            verdictBox.hidden = true;
            results.hidden = true;
            raw.hidden = true;
        }
    });

    if (usernameField.value) {
        form.requestSubmit();
    }

    initEnhanceTest(usernameField, setStatus);
});

/* ---------- Enhance print: a ten round typing test ---------- */

const ENHANCE_SENTENCES = [
    'Markets open quietly today',
    'Read the chain before trading',
    'Volume shows real conviction',
    'A calm hand beats a fast one',
    'Volatility rises with fear',
    'Discipline survives the tape',
    'Liquidity leaves when needed',
    'Quiet sessions teach the most',
    'Position size decides the year',
    'Patience is a trading edge'
];

const ENHANCE_ROUNDS = ENHANCE_SENTENCES.length;

function statistics(values) {
    if (values.length === 0) {
        return { count: 0, mean: null, median: null, stdDev: null, min: null, max: null };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const total = values.reduce((sum, value) => sum + value, 0);
    const mean = total / values.length;
    const variance = values.length > 1
        ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
        : 0;
    const middle = Math.floor(sorted.length / 2);
    const round2 = (value) => Math.round(value * 100) / 100;

    return {
        count: values.length,
        mean: round2(mean),
        median: round2(
            sorted.length % 2 === 0
                ? (sorted[middle - 1] + sorted[middle]) / 2
                : sorted[middle]
        ),
        stdDev: values.length > 1 ? round2(Math.sqrt(variance)) : null,
        min: round2(sorted[0]),
        max: round2(sorted[sorted.length - 1])
    };
}

function initEnhanceTest(usernameField) {
    const panel = document.getElementById('enhance-panel');
    if (!panel) {
        return;
    }

    const input = document.getElementById('enhance-input');
    const prompt = document.getElementById('enhance-prompt');
    const progress = document.getElementById('enhance-progress');
    const barFill = document.getElementById('enhance-bar-fill');
    const startBtn = document.getElementById('enhance-start');
    const nextBtn = document.getElementById('enhance-next');
    const resetBtn = document.getElementById('enhance-reset');

    // Next needs enough of a sample to be worth banking.
    const MIN_KEYS_FOR_NEXT = 5;
    const status = document.getElementById('enhance-status');
    const results = document.getElementById('enhance-results');
    const roundsBody = document.getElementById('enhance-rounds');

    // The whole test is a few hundred keystrokes, so every interval is kept
    // and the statistics are exact rather than sampled.
    const test = {
        running: false,
        roundIndex: 0,
        rounds: [],
        hold: [],
        flight: [],
        betweenKeys: [],
        corrections: 0,
        keystrokes: 0
    };
    let round = null;

    function setStatus(message, tone) {
        status.textContent = message || '';
        status.className = `behavior-status${tone ? ` behavior-status-${tone}` : ''}`;
    }

    function text(id, value) {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value === null || value === undefined ? '—' : value;
        }
    }

    function newRound() {
        round = {
            pending: new Map(),
            hold: [],
            flight: [],
            betweenKeys: [],
            corrections: 0,
            keystrokes: 0,
            firstKeyAt: null,
            lastKeyAt: null,
            lastKeyUpAt: null
        };
    }

    function refreshLive() {
        const hold = statistics(test.hold.concat(round ? round.hold : []));
        const flight = statistics(test.flight.concat(round ? round.flight : []));
        text('enhance-keys', test.keystrokes + (round ? round.keystrokes : 0));
        text('enhance-hold', hold.mean);
        text('enhance-flight', flight.mean);
        text('enhance-corrections', test.corrections + (round ? round.corrections : 0));

        nextBtn.disabled = !round || round.keystrokes < MIN_KEYS_FOR_NEXT;

        const done = test.rounds.length;
        const wpm = done > 0
            ? Math.round(
                (test.rounds.reduce((sum, entry) => sum + entry.wpm, 0) / done) * 10
            ) / 10
            : null;
        text('enhance-wpm', wpm);
    }

    function showRound() {
        progress.textContent = `Round ${test.roundIndex + 1} of ${ENHANCE_ROUNDS}`;
        barFill.style.width = `${(test.rounds.length / ENHANCE_ROUNDS) * 100}%`;
        prompt.textContent = ENHANCE_SENTENCES[test.roundIndex];
        prompt.classList.remove('enhance-prompt-done');
        input.value = '';
        input.disabled = false;
        input.focus();
        newRound();
        nextBtn.hidden = false;
        nextBtn.disabled = true;
    }

    function completeRound() {
        const target = ENHANCE_SENTENCES[test.roundIndex];
        const typed = input.value;
        const durationMs = round.firstKeyAt !== null && round.lastKeyAt !== null
            ? round.lastKeyAt - round.firstKeyAt
            : 0;
        const minutes = durationMs / 60000;
        // Next can end a round early, so score what was actually typed.
        const words = typed.length / 5;

        test.rounds.push({
            round: test.rounds.length + 1,
            matchedSentence: typed === target,
            characters: typed.length,
            durationMs: Math.round(durationMs),
            keystrokes: round.keystrokes,
            corrections: round.corrections,
            wpm: minutes > 0 ? Math.round((words / minutes) * 10) / 10 : 0,
            holdMs: statistics(round.hold),
            flightMs: statistics(round.flight),
            betweenKeysMs: statistics(round.betweenKeys)
        });

        test.hold = test.hold.concat(round.hold);
        test.flight = test.flight.concat(round.flight);
        test.betweenKeys = test.betweenKeys.concat(round.betweenKeys);
        test.corrections += round.corrections;
        test.keystrokes += round.keystrokes;

        prompt.classList.add('enhance-prompt-done');
        input.disabled = true;
        round = null;
        renderRounds();
        refreshLive();

        test.roundIndex += 1;
        if (test.roundIndex >= ENHANCE_ROUNDS) {
            finish();
            return;
        }

        setStatus(
            `Round ${test.roundIndex} of ${ENHANCE_ROUNDS} recorded. Next sentence...`,
            'ok'
        );
        setTimeout(showRound, 700);
    }

    function renderRounds() {
        results.hidden = test.rounds.length === 0;
        roundsBody.replaceChildren();
        for (const entry of test.rounds) {
            const tr = document.createElement('tr');
            for (const value of [
                entry.round,
                entry.characters,
                Math.round(entry.durationMs / 100) / 10,
                entry.wpm,
                entry.holdMs.mean,
                entry.flightMs.mean,
                entry.corrections
            ]) {
                const td = document.createElement('td');
                td.textContent = value === null ? '—' : String(value);
                tr.append(td);
            }
            roundsBody.append(tr);
        }
    }

    function profile() {
        const wpmValues = test.rounds.map((entry) => entry.wpm);
        return {
            rounds: ENHANCE_ROUNDS,
            keystrokes: test.keystrokes,
            corrections: test.corrections,
            totalDurationMs: test.rounds.reduce(
                (sum, entry) => sum + entry.durationMs, 0
            ),
            holdMs: statistics(test.hold),
            flightMs: statistics(test.flight),
            betweenKeysMs: statistics(test.betweenKeys),
            wpm: statistics(wpmValues),
            perRound: test.rounds
        };
    }

    async function finish() {
        progress.textContent = `${ENHANCE_ROUNDS} of ${ENHANCE_ROUNDS} complete`;
        barFill.style.width = '100%';
        prompt.textContent = 'Typing test complete';
        nextBtn.hidden = true;
        resetBtn.hidden = false;

        const username = usernameField.value.trim();
        if (!username) {
            setStatus(
                'Enter an account username above, then press Restart to save a profile.',
                'warn'
            );
            return;
        }

        setStatus('Saving the enhanced profile...', 'working');
        try {
            const response = await fetch('/api/behavior/enhanced', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, profile: profile() })
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(body.error || 'The profile could not be saved.');
            }
            setStatus(
                `Enhanced profile saved for ${username}: ${test.keystrokes} keystrokes `
                + `across ${ENHANCE_ROUNDS} sentences.`,
                'ok'
            );
        } catch (error) {
            setStatus(error.message, 'error');
        }
    }

    input.addEventListener('keydown', (event) => {
        if (!test.running || !round || event.repeat) {
            return;
        }
        const now = event.timeStamp;
        round.pending.set(event.code || event.key, now);
        if (round.lastKeyAt !== null) {
            round.betweenKeys.push(now - round.lastKeyAt);
        }
        if (round.lastKeyUpAt !== null) {
            round.flight.push(now - round.lastKeyUpAt);
        }
        if (round.firstKeyAt === null) {
            round.firstKeyAt = now;
        }
        round.lastKeyAt = now;
        round.keystrokes += 1;
        if (event.key === 'Backspace' || event.key === 'Delete') {
            round.corrections += 1;
        }
    });

    input.addEventListener('keyup', (event) => {
        if (!test.running || !round) {
            return;
        }
        const identity = event.code || event.key;
        const downAt = round.pending.get(identity);
        if (downAt !== undefined) {
            round.hold.push(event.timeStamp - downAt);
            round.pending.delete(identity);
        }
        round.lastKeyUpAt = event.timeStamp;
        refreshLive();

        // A round ends the moment the field matches the sentence exactly.
        if (input.value === ENHANCE_SENTENCES[test.roundIndex]) {
            completeRound();
        }
    });

    input.addEventListener('paste', (event) => {
        event.preventDefault();
        setStatus('Type the sentence; pasting is not recorded.', 'warn');
    });

    function startTest() {
        test.running = true;
        test.roundIndex = 0;
        test.rounds = [];
        test.hold = [];
        test.flight = [];
        test.betweenKeys = [];
        test.corrections = 0;
        test.keystrokes = 0;
        startBtn.hidden = true;
        resetBtn.hidden = true;
        nextBtn.hidden = true;
        results.hidden = true;
        roundsBody.replaceChildren();
        setStatus('Type the sentence exactly as shown.', null);
        refreshLive();
        showRound();
    }

    nextBtn.addEventListener('click', () => {
        if (test.running && round && round.keystrokes >= MIN_KEYS_FOR_NEXT) {
            completeRound();
        }
    });

    startBtn.addEventListener('click', startTest);
    resetBtn.addEventListener('click', startTest);
}
