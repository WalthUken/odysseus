"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ENROLLMENT_ROUNDS,
  MIN_FREE_TYPING_CHARACTERS,
  MIN_FREE_TYPING_WORDS,
  VERIFICATION_ROUNDS,
  acceptTarget,
  compareText,
  evaluateFreeTyping,
  roundAt,
  targetFor,
} = require("../public/challenge");

test("provides distinct, substantial challenge prompts", () => {
  assert.equal(ENROLLMENT_ROUNDS.length, 5);
  assert.equal(VERIFICATION_ROUNDS.length, 5);

  const prompts = [
    ...ENROLLMENT_ROUNDS.map((round) => round.prompt),
    ...VERIFICATION_ROUNDS.map((round) => round.prompt),
  ];

  assert.equal(new Set(prompts).size, prompts.length);
  for (const prompt of prompts) {
    assert.ok(prompt.length >= 50);
    assert.ok(prompt.length <= 80);
    assert.equal(prompt.includes("."), false);
  }

  for (const round of [...ENROLLMENT_ROUNDS, ...VERIFICATION_ROUNDS]) {
    assert.equal(round.route.length, 6);
    assert.equal(new Set(round.route).size, round.route.length);
    assert.ok(round.route.every((slot) => slot >= 0 && slot <= 8));
  }
});

test("accepts guided text locally without demanding exact punctuation or spelling", () => {
  const prompt = ENROLLMENT_ROUNDS[0].prompt;
  const partial = compareText(prompt.slice(0, 18), prompt);
  assert.equal(partial.accepted, false);
  assert.equal(partial.exact, false);
  assert.equal(partial.prefixMatches, true);
  assert.equal(partial.remainingCharacters, prompt.length - 18);

  const missingLastCharacter = compareText(prompt.slice(0, -1), prompt);
  assert.equal(missingLastCharacter.accepted, false);
  assert.equal(missingLastCharacter.remainingCharacters, 1);

  const forgiving = compareText(
    prompt.toUpperCase().replace("SIGNALS", "SIGNELS") + ",",
    prompt
  );
  assert.equal(forgiving.accepted, true);
  assert.equal(forgiving.exact, false);
  assert.ok(forgiving.similarity > 0.9);

  const mismatch = compareText(
    "This unrelated response is long enough but does not match the prompt",
    prompt
  );
  assert.equal(mismatch.accepted, false);
  assert.equal(mismatch.needsCorrection, true);

  const exact = compareText(prompt, prompt);
  assert.equal(exact.accepted, true);
  assert.equal(exact.exact, true);
  assert.equal(exact.remainingCharacters, 0);
});

test("accepts a short free-typing response without inspecting its meaning", () => {
  const short = evaluateFreeTyping("A short note");
  assert.equal(short.complete, false);
  assert.ok(short.remainingCharacters > 0);
  assert.ok(short.remainingWords > 0);

  const complete = evaluateFreeTyping(
    "I am typing my own short response"
  );
  assert.equal(complete.complete, true);
  assert.ok(complete.characterCount >= MIN_FREE_TYPING_CHARACTERS);
  assert.ok(complete.wordCount >= MIN_FREE_TYPING_WORDS);
});

test("advances a pointer trail only when the active target is selected", () => {
  const round = roundAt("enrollment", 0);
  assert.equal(targetFor(round, 0), round.route[0]);

  const rejected = acceptTarget(round, 0, round.route[1]);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.completedTargets, 0);

  let completedTargets = 0;
  for (const slot of round.route) {
    const result = acceptTarget(round, completedTargets, slot);
    assert.equal(result.accepted, true);
    completedTargets = result.completedTargets;
  }

  assert.equal(completedTargets, round.route.length);
  assert.equal(targetFor(round, completedTargets), null);
});

test("wraps verification rounds without mutating their definitions", () => {
  assert.equal(roundAt("verification", 5), VERIFICATION_ROUNDS[0]);
  assert.equal(roundAt("verification", -1), VERIFICATION_ROUNDS[4]);
  assert.ok(Object.isFrozen(VERIFICATION_ROUNDS));
  assert.ok(Object.isFrozen(VERIFICATION_ROUNDS[0]));
  assert.ok(Object.isFrozen(VERIFICATION_ROUNDS[0].route));
});
