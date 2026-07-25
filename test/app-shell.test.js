"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");

test("serves a bounded health response", async (context) => {
  const server = createApp().listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/health`,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.service, "odysseus-behavioral-auth-mvp");
  assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});
