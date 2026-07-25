// Records interaction timing for the signed-in session and turns it into
// plain numbers. Key identities are used only to pair a keydown with its
// keyup and are never stored or sent. No typed text, no cursor coordinates.
(function (global) {
    'use strict';

    const SAMPLE_CAP = 2000;      // values kept for the median
    const MAX_MOVE_GAP_MS = 400;  // longer pauses are idle, not movement
    const DIRECTION_CHANGE_DEGREES = 45;

    function accumulator() {
        return {
            count: 0,
            mean: 0,
            m2: 0,
            min: Infinity,
            max: -Infinity,
            sample: []
        };
    }

    // Welford keeps mean and deviation exact over the whole session while the
    // reservoir keeps a bounded, unbiased set of values for the median.
    function record(acc, value) {
        if (!Number.isFinite(value)) {
            return;
        }
        acc.count += 1;
        const delta = value - acc.mean;
        acc.mean += delta / acc.count;
        acc.m2 += delta * (value - acc.mean);
        if (value < acc.min) {
            acc.min = value;
        }
        if (value > acc.max) {
            acc.max = value;
        }
        if (acc.sample.length < SAMPLE_CAP) {
            acc.sample.push(value);
        } else {
            const index = Math.floor(Math.random() * acc.count);
            if (index < SAMPLE_CAP) {
                acc.sample[index] = value;
            }
        }
    }

    function round(value, places = 2) {
        if (!Number.isFinite(value)) {
            return null;
        }
        const factor = 10 ** places;
        return Math.round(value * factor) / factor;
    }

    function median(values) {
        if (values.length === 0) {
            return null;
        }
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
            ? (sorted[middle - 1] + sorted[middle]) / 2
            : sorted[middle];
    }

    function summarize(acc) {
        return {
            count: acc.count,
            mean: round(acc.count > 0 ? acc.mean : null),
            median: round(median(acc.sample)),
            stdDev: round(acc.count > 1 ? Math.sqrt(acc.m2 / (acc.count - 1)) : null),
            min: round(acc.count > 0 ? acc.min : null),
            max: round(acc.count > 0 ? acc.max : null)
        };
    }

    function createCollector() {
        const state = {
            startedAt: Date.now(),
            pendingKeys: new Map(),
            keyCount: 0,
            firstKeyAt: null,
            lastKeyAt: null,
            lastKeyUpAt: null,
            dwell: accumulator(),
            flight: accumulator(),
            downDown: accumulator(),
            moveCount: 0,
            totalDistance: 0,
            activeMoveMs: 0,
            directionChanges: 0,
            lastMove: null,
            lastVector: null,
            speed: accumulator(),
            clicks: 0,
            lastClickAt: null,
            clickInterval: accumulator()
        };

        function onKeyDown(event) {
            if (event.repeat) {
                return;
            }
            const now = event.timeStamp || performance.now();
            // The key name lives in this map only until its keyup arrives.
            state.pendingKeys.set(event.code || event.key, now);

            if (state.lastKeyAt !== null) {
                record(state.downDown, now - state.lastKeyAt);
            }
            if (state.lastKeyUpAt !== null) {
                record(state.flight, now - state.lastKeyUpAt);
            }
            if (state.firstKeyAt === null) {
                state.firstKeyAt = now;
            }
            state.lastKeyAt = now;
            state.keyCount += 1;
        }

        function onKeyUp(event) {
            const identity = event.code || event.key;
            const downAt = state.pendingKeys.get(identity);
            const now = event.timeStamp || performance.now();
            if (downAt !== undefined) {
                record(state.dwell, now - downAt);
                state.pendingKeys.delete(identity);
            }
            state.lastKeyUpAt = now;
        }

        function onMouseMove(event) {
            const now = event.timeStamp || performance.now();
            const point = { x: event.clientX, y: event.clientY, at: now };

            if (state.lastMove) {
                const dx = point.x - state.lastMove.x;
                const dy = point.y - state.lastMove.y;
                const dt = point.at - state.lastMove.at;
                const distance = Math.hypot(dx, dy);

                if (dt > 0 && dt <= MAX_MOVE_GAP_MS && distance > 0) {
                    state.totalDistance += distance;
                    state.activeMoveMs += dt;
                    state.moveCount += 1;
                    record(state.speed, (distance / dt) * 1000);

                    const angle = Math.atan2(dy, dx);
                    if (state.lastVector !== null) {
                        let change = Math.abs(angle - state.lastVector);
                        if (change > Math.PI) {
                            change = 2 * Math.PI - change;
                        }
                        if (change > (DIRECTION_CHANGE_DEGREES * Math.PI) / 180) {
                            state.directionChanges += 1;
                        }
                    }
                    state.lastVector = angle;
                }
            }
            state.lastMove = point;
        }

        function onClick(event) {
            const now = event.timeStamp || performance.now();
            state.clicks += 1;
            if (state.lastClickAt !== null) {
                record(state.clickInterval, now - state.lastClickAt);
            }
            state.lastClickAt = now;
        }

        function metrics() {
            const sessionMs = Date.now() - state.startedAt;
            const typingSpanMs =
                state.firstKeyAt !== null && state.lastKeyAt !== null
                    ? state.lastKeyAt - state.firstKeyAt
                    : 0;
            const activeMoveSeconds = state.activeMoveMs / 1000;

            return {
                capturedAt: new Date().toISOString(),
                sessionDurationMs: sessionMs,
                keyboard: {
                    keystrokes: state.keyCount,
                    typingSpanMs: round(typingSpanMs),
                    keysPerSecond:
                        typingSpanMs > 0 && state.keyCount > 1
                            ? round(((state.keyCount - 1) / typingSpanMs) * 1000, 3)
                            : null,
                    holdMs: summarize(state.dwell),
                    flightMs: summarize(state.flight),
                    betweenKeysMs: summarize(state.downDown)
                },
                mouse: {
                    moveSamples: state.moveCount,
                    totalDistancePx: round(state.totalDistance),
                    movingTimeMs: round(state.activeMoveMs),
                    speedPxPerSecond: summarize(state.speed),
                    directionChanges: state.directionChanges,
                    directionChangesPerSecond:
                        activeMoveSeconds > 0
                            ? round(state.directionChanges / activeMoveSeconds, 3)
                            : null,
                    clicks: state.clicks,
                    betweenClicksMs: summarize(state.clickInterval)
                }
            };
        }

        function start(target = document) {
            target.addEventListener('keydown', onKeyDown, true);
            target.addEventListener('keyup', onKeyUp, true);
            target.addEventListener('mousemove', onMouseMove, true);
            target.addEventListener('click', onClick, true);
        }

        return { start, metrics, startedAt: state.startedAt };
    }

    global.BehaviorCollector = { create: createCollector };
})(window);
