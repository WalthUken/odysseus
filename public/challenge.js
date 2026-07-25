(function (global) {
  "use strict";

  const MIN_FREE_TYPING_CHARACTERS = 24;
  const MIN_FREE_TYPING_WORDS = 4;

  const ENROLLMENT_ROUNDS = Object.freeze([
    Object.freeze({
      id: "north-bridge",
      label: "Northern bridge",
      prompt: "Quiet signals cross the northern bridge before sunrise",
      route: Object.freeze([0, 8, 2, 6, 4, 1]),
    }),
    Object.freeze({
      id: "amber-route",
      label: "Amber route",
      prompt: "Seven amber lights mark the safest route through the station",
      route: Object.freeze([2, 6, 0, 8, 4, 7]),
    }),
    Object.freeze({
      id: "access-review",
      label: "Access review",
      prompt: "I review unusual activity before approving protected access",
      route: Object.freeze([6, 2, 8, 0, 4, 5]),
    }),
    Object.freeze({
      id: "pointer-check",
      label: "Pointer check",
      prompt: "Careful pointer movements help Odysseus compare this session",
      route: Object.freeze([8, 0, 6, 2, 4, 3]),
    }),
    Object.freeze({
      id: "rhythm-check",
      label: "Rhythm check",
      prompt: "My usual keyboard rhythm stays steady across different tasks",
      route: Object.freeze([1, 7, 3, 5, 0, 8]),
    }),
  ]);

  const VERIFICATION_ROUNDS = Object.freeze([
    Object.freeze({
      id: "steady-session",
      label: "Steady session",
      prompt: "A trusted session combines steady typing with smooth movement",
      route: Object.freeze([0, 5, 6, 2, 7, 1]),
    }),
    Object.freeze({
      id: "green-checkpoint",
      label: "Green checkpoint",
      prompt: "The green checkpoint opens after the signal pattern is reviewed",
      route: Object.freeze([2, 3, 8, 0, 5, 7]),
    }),
    Object.freeze({
      id: "grant-review",
      label: "Grant review",
      prompt: "Before sharing a report I confirm the account and active grant",
      route: Object.freeze([6, 1, 8, 3, 2, 4]),
    }),
    Object.freeze({
      id: "cautious-decision",
      label: "Cautious decision",
      prompt: "Consistent interaction can support a cautious security decision",
      route: Object.freeze([8, 3, 0, 5, 6, 2]),
    }),
    Object.freeze({
      id: "private-words",
      label: "Private words",
      prompt: "This short challenge measures timing without saving these words",
      route: Object.freeze([1, 6, 5, 0, 7, 2]),
    }),
  ]);

  function roundsFor(mode) {
    if (mode === "enrollment") {
      return ENROLLMENT_ROUNDS;
    }
    if (mode === "verification") {
      return VERIFICATION_ROUNDS;
    }
    throw new TypeError("Challenge mode must be enrollment or verification.");
  }

  function roundAt(mode, index) {
    const rounds = roundsFor(mode);
    const numericIndex = Number(index);
    if (!Number.isSafeInteger(numericIndex)) {
      throw new TypeError("Challenge round index must be an integer.");
    }
    const normalizedIndex =
      ((numericIndex % rounds.length) + rounds.length) % rounds.length;
    return rounds[normalizedIndex];
  }

  function normalizeText(value) {
    return String(value || "")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function editDistance(left, right) {
    if (left === right) {
      return 0;
    }
    if (!left.length) {
      return right.length;
    }
    if (!right.length) {
      return left.length;
    }

    let previous = Array.from(
      { length: right.length + 1 },
      (_, index) => index
    );

    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = [leftIndex];
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const substitutionCost =
          left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
        current[rightIndex] = Math.min(
          current[rightIndex - 1] + 1,
          previous[rightIndex] + 1,
          previous[rightIndex - 1] + substitutionCost
        );
      }
      previous = current;
    }

    return previous[right.length];
  }

  function compareText(value, expected) {
    const typed = typeof value === "string" ? value : "";
    const target = typeof expected === "string" ? expected : "";
    const normalizedTyped = normalizeText(typed);
    const normalizedTarget = normalizeText(target);
    let matchingCharacters = 0;
    const comparableLength = Math.min(
      normalizedTyped.length,
      normalizedTarget.length
    );

    while (
      matchingCharacters < comparableLength &&
      normalizedTyped[matchingCharacters] ===
        normalizedTarget[matchingCharacters]
    ) {
      matchingCharacters += 1;
    }

    const targetLength = normalizedTarget.length;
    const typedLength = normalizedTyped.length;
    const allowedMistakes = Math.max(2, Math.floor(targetLength * 0.08));
    const distance = editDistance(normalizedTyped, normalizedTarget);
    const minimumAcceptedLength = Math.max(1, targetLength);
    const accepted =
      targetLength > 0 &&
      typedLength >= minimumAcceptedLength &&
      distance <= allowedMistakes;
    const exact = normalizedTyped === normalizedTarget;
    const prefixMatches = matchingCharacters === typedLength;
    const similarity =
      Math.max(typedLength, targetLength) > 0
        ? 1 - distance / Math.max(typedLength, targetLength)
        : 1;

    return Object.freeze({
      accepted,
      exact,
      prefixMatches,
      matchingCharacters,
      typedLength,
      targetLength,
      remainingCharacters: Math.max(0, targetLength - typedLength),
      hasExtraCharacters: typedLength > targetLength + allowedMistakes,
      allowedMistakes,
      distance,
      similarity,
      needsCorrection:
        typedLength >= minimumAcceptedLength && !accepted,
    });
  }

  function evaluateFreeTyping(value) {
    const normalized = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    const characterCount = normalized.length;
    const wordCount = normalized ? normalized.split(" ").length : 0;
    return Object.freeze({
      complete:
        characterCount >= MIN_FREE_TYPING_CHARACTERS &&
        wordCount >= MIN_FREE_TYPING_WORDS,
      characterCount,
      wordCount,
      remainingCharacters: Math.max(
        0,
        MIN_FREE_TYPING_CHARACTERS - characterCount
      ),
      remainingWords: Math.max(0, MIN_FREE_TYPING_WORDS - wordCount),
    });
  }

  function targetFor(round, completedTargets) {
    if (!round || !Array.isArray(round.route)) {
      throw new TypeError("A valid challenge round is required.");
    }
    const progress = Number(completedTargets);
    if (!Number.isSafeInteger(progress) || progress < 0) {
      throw new TypeError(
        "Completed target count must be a non-negative integer."
      );
    }
    return progress < round.route.length ? round.route[progress] : null;
  }

  function acceptTarget(round, completedTargets, slot) {
    const expectedSlot = targetFor(round, completedTargets);
    const receivedSlot = Number(slot);
    const accepted =
      expectedSlot !== null &&
      Number.isSafeInteger(receivedSlot) &&
      receivedSlot === expectedSlot;
    return Object.freeze({
      accepted,
      complete:
        accepted && completedTargets + 1 >= round.route.length,
      completedTargets: accepted ? completedTargets + 1 : completedTargets,
      expectedSlot,
    });
  }

  const api = Object.freeze({
    ENROLLMENT_ROUNDS,
    MIN_FREE_TYPING_CHARACTERS,
    MIN_FREE_TYPING_WORDS,
    VERIFICATION_ROUNDS,
    acceptTarget,
    compareText,
    evaluateFreeTyping,
    roundAt,
    roundsFor,
    targetFor,
  });

  global.OdysseusChallenge = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
