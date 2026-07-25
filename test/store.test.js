"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { TemplateStore } = require("../src/store");

test("persists, reloads, lists, and deletes templates", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "odysseus-store-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "templates.json");
  const template = {
    version: 1,
    featureKeys: ["dwellMean"],
    means: { dwellMean: 100 },
    deviations: { dwellMean: 4 },
    scales: { dwellMean: 4 },
    acceptanceThreshold: 1.5,
    calibration: { p90Distance: 1, maximumDistance: 1.2 },
    sampleCount: 5,
    enrolledAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
  };

  const firstStore = await new TemplateStore(filePath).init();
  await firstStore.set("demo-user", template);

  const reloadedStore = await new TemplateStore(filePath).init();
  assert.deepEqual(reloadedStore.get("demo-user"), template);
  assert.equal(reloadedStore.list().length, 1);

  assert.equal(await reloadedStore.delete("demo-user"), true);
  assert.equal(await reloadedStore.delete("demo-user"), false);

  const emptyStore = await new TemplateStore(filePath).init();
  assert.equal(emptyStore.get("demo-user"), null);
});
