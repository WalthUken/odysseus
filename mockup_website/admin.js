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

    function renderVerdict(comparison) {
        verdictBox.hidden = false;

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
            ? 'Inconsistent with the real user'
            : 'Consistent with the real user';

        const largest = comparison.largestDifference;
        verdictDetail.textContent = [
            `Average difference across ${comparison.comparedMetrics} statistics: `
            + `${comparison.averageDifference}%.`,
            largest
                ? `Largest gap: ${largest.label} at ${largest.differencePercent}%.`
                : '',
            `Flagged when the average passes ${comparison.thresholds.averagePercent}% `
            + `or any single statistic passes ${comparison.thresholds.singleMetricPercent}%.`,
            'This is a demo comparison against fixed thresholds, not a verified '
            + 'identity decision.'
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

            renderVerdict(payload.comparison);
            renderRows(payload.comparison);

            raw.hidden = false;
            rawJson.textContent = JSON.stringify(
                { baseline: payload.baseline, sample: payload.sample },
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
});
