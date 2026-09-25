import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EVENT_KINDS, PAYLOAD_FIELDS, validateEvent } from "../src/skill_museum_learning.js";
import { createState, ingest } from "../src/coordination.js";

test("样例符合领域约定", async () => {
  const record = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(record), []);
});

test("每种事件都声明了 payload 最小字段", () => {
  for (const kind of EVENT_KINDS) assert.ok(Array.isArray(PAYLOAD_FIELDS[kind]), kind);
});

test("虚构事件流结构合法且可完整重放", async () => {
  const events = JSON.parse(await readFile(new URL("../data/sample_stream.json", import.meta.url), "utf8"));
  const state = createState();
  for (const record of events) {
    assert.deepEqual(validateEvent(record), [], record.event_id);
    assert.equal(ingest(state, record).applied, true, record.event_id);
  }
});
