import assert from "node:assert/strict";
import test from "node:test";
import {
  DomainRejection,
  availableCapacity,
  createService,
  deferralLog,
  groupsAffectedByStation,
  planVsActual,
  publicQueue,
  replanImpacts,
  restoreService,
} from "../src/coordination.js";

const MIN = 60 * 1000;
const T0 = Date.parse("2026-09-23T09:00:00+08:00");
const WINDOW = { start: "2026-09-23T09:00:00+08:00", end: "2026-09-23T12:00:00+08:00" };
const SLOT = { start: "2026-09-23T09:30:00+08:00", end: "2026-09-23T10:30:00+08:00" };
const SLOT2 = { start: "2026-09-23T10:45:00+08:00", end: "2026-09-23T11:45:00+08:00" };
const SHIFT = { start: "2026-09-23T08:00:00+08:00", end: "2026-09-23T12:00:00+08:00", mentors: 2 };

const iso = (ms) => new Date(ms).toISOString();

function openStation(overrides = {}) {
  return {
    version: 1,
    status: "open",
    capacity: 10,
    prerequisites: [],
    equipment: [],
    mentor_shifts: [SHIFT],
    safety: { wheelchair_accessible: true, max_group_size: 20 },
    ...overrides,
  };
}

function newService() {
  const svc = createService({ now: T0, holdTtlMs: 30 * MIN });
  svc.publishStation({ station_id: "cnc", ...openStation() });
  svc.publishStation({ station_id: "welding", ...openStation() });
  svc.publishStation({
    station_id: "foundry",
    ...openStation({ safety: { wheelchair_accessible: false, max_group_size: 20 } }),
  });
  return svc;
}

function requestTeam(svc, id, total, extra = {}) {
  svc.requestGroup({
    group_id: id,
    objectives: ["cnc-basics"],
    time_window: WINDOW,
    members: { total, mentors: 1, ...(extra.members ?? {}) },
    support_needs: extra.support_needs ?? [],
    ...(extra.completed_objectives ? { completed_objectives: extra.completed_objectives } : {}),
  });
}

test("确认行程先形成有期限的资源占用，重复事件不会重复扣减", () => {
  const svc = newService();
  requestTeam(svc, "team-a", 8);
  const [held] = svc.plan({ group_id: "team-a", stops: [{ station_id: "cnc", slot: SLOT }] });
  assert.equal(held.kind, "ITINERARY_HELD");
  assert.equal(held.payload.expires_at, iso(T0 + 30 * MIN));
  assert.equal(availableCapacity(svc.state, "cnc", SLOT), 2);

  const again = svc.ingest(held);
  assert.deepEqual(again, { applied: false, reason: "duplicate_event" });
  assert.equal(availableCapacity(svc.state, "cnc", SLOT), 2);
});

test("竞争同一资源时采用公开顺序并记录被推迟原因", () => {
  const svc = newService();
  requestTeam(svc, "team-a", 8);
  requestTeam(svc, "team-b", 6);
  svc.plan({ group_id: "team-a", stops: [{ station_id: "cnc", slot: SLOT }] });
  const [deferred] = svc.plan({ group_id: "team-b", stops: [{ station_id: "cnc", slot: SLOT }] });

  assert.equal(deferred.kind, "GROUP_DEFERRED");
  assert.equal(deferred.payload.reason, "capacity_exhausted");
  assert.equal(deferred.payload.queue_position, 1);
  assert.deepEqual(
    publicQueue(svc.state, "cnc", SLOT).map((e) => e.group_id),
    ["team-b"],
  );
  const log = deferralLog(svc.state, "team-b");
  assert.equal(log.length, 1);
  assert.equal(log[0].reason, "capacity_exhausted");
});

test("过期占用由可控时钟释放，持续等待者先于新申请者获得资源", () => {
  const svc = createService({ now: T0, holdTtlMs: 30 * MIN });
  svc.publishStation({ station_id: "cnc", ...openStation({ capacity: 6 }) });
  requestTeam(svc, "team-a", 6);
  requestTeam(svc, "team-b", 6);
  requestTeam(svc, "team-c", 6);
  svc.plan({ group_id: "team-a", stops: [{ station_id: "cnc", slot: SLOT }] });
  svc.plan({ group_id: "team-b", stops: [{ station_id: "cnc", slot: SLOT }] }); // 容量不足，入队
  svc.plan({ group_id: "team-c", stops: [{ station_id: "cnc", slot: SLOT }] }); // 队非空，排在其后

  const events = svc.advanceTo(T0 + 31 * MIN);
  const promoted = events.find((e) => e.kind === "ITINERARY_HELD");
  assert.ok(events.some((e) => e.kind === "HOLD_RELEASED" && e.payload.reason === "hold_expired"));
  assert.equal(promoted.payload.group_id, "team-b"); // 等待者优先于 team-c
  assert.equal(promoted.payload.expires_at, iso(T0 + 61 * MIN));
  assert.equal(availableCapacity(svc.state, "cnc", SLOT), 0);
  assert.deepEqual(
    publicQueue(svc.state, "cnc", SLOT).map((e) => e.group_id),
    ["team-c"],
  );
});

test("过期释放后迟到的确认被拒绝", () => {
  const svc = newService();
  requestTeam(svc, "team-a", 8);
  const [held] = svc.plan({ group_id: "team-a", stops: [{ station_id: "cnc", slot: SLOT }] });
  svc.advanceTo(T0 + 31 * MIN);
  assert.throws(
    () => svc.confirm({ hold_id: held.payload.hold_id, source: { device_id: "kiosk-1", seq: 1 } }),
    (err) => err instanceof DomainRejection && err.reason === "hold_not_active",
  );
});

test("确认、拒绝与签到按来源序列合并，旧版本公告不覆盖现状", () => {
  const svc = newService();
  requestTeam(svc, "team-a", 8);
  const [held] = svc.plan({ group_id: "team-a", stops: [{ station_id: "cnc", slot: SLOT }] });
  const holdId = held.payload.hold_id;

  const confirm = (eventId, seq) =>
    svc.ingest({
      event_id: eventId,
      kind: "ITINERARY_CONFIRMED",
      occurred_at: iso(T0 + 5 * MIN),
      subject_id: "team-a",
      payload: { hold_id: holdId, source: { device_id: "kiosk-1", seq } },
    });
  assert.equal(confirm("ext-1", 2).applied, true);
  assert.deepEqual(confirm("ext-2", 2), { applied: false, reason: "stale_source_sequence" }); // 同序列重发
  assert.deepEqual(confirm("ext-3", 1), { applied: false, reason: "stale_source_sequence" }); // 更旧的序列
  assert.equal(availableCapacity(svc.state, "cnc", SLOT), 2); // 确认不释放容量，也不重复扣减

  const rejected = svc.ingest({
    event_id: "ext-4",
    kind: "ITINERARY_REJECTED",
    occurred_at: iso(T0 + 6 * MIN),
    subject_id: "team-a",
    payload: { hold_id: holdId, source: { device_id: "kiosk-1", seq: 3 }, reason: "group_cancelled" },
  });
  assert.equal(rejected.applied, true);
  assert.equal(availableCapacity(svc.state, "cnc", SLOT), 10);

  svc.publishStation({ station_id: "cnc", ...openStation({ version: 3, capacity: 4 }) });
  svc.ingest({
    event_id: "ext-5",
    kind: "STATION_CAPACITY_SET",
    occurred_at: iso(T0 + 7 * MIN),
    subject_id: "cnc",
    payload: { ...openStation({ version: 2, capacity: 99 }) },
  });
  assert.equal(svc.state.stations.get("cnc").version, 3);
  assert.equal(svc.state.stations.get("cnc").capacity, 4);
});

test("停站改道仅重排未开始环节，证据保留且安全条件不降级", () => {
  const svc = newService();
  requestTeam(svc, "team-a", 8, { support_needs: ["wheelchair_access"], members: { wheelchair_users: 1 } });
  const [h1, h2] = svc.plan({
    group_id: "team-a",
    stops: [
      { station_id: "cnc", slot: SLOT },
      { station_id: "welding", slot: SLOT2 },
    ],
  });
  const seg1 = h1.payload.segment_id;
  const seg2 = h2.payload.segment_id;
  svc.checkin({ group_id: "team-a", segment_id: seg1, station_id: "cnc", source: { device_id: "kiosk-1", seq: 1 } });
  svc.recordEvidence({ group_id: "team-a", segment_id: seg1, evidence: { objectives: ["cnc-basics"], note: "完成（虚构）" } });

  svc.publishStation({ station_id: "welding", ...openStation({ version: 2, status: "closed", capacity: 0 }) });
  assert.deepEqual(groupsAffectedByStation(svc.state, "welding"), [{ group_id: "team-a", segments: [seg2] }]);

  // 替代方案不得降低强制安全条件（轮椅通行）
  assert.throws(
    () =>
      svc.replan({
        group_id: "team-a",
        cause: { type: "station_closed", station_id: "welding" },
        replacements: [{ replaces_segment_id: seg2, station_id: "foundry", slot: SLOT2 }],
      }),
    (err) => err instanceof DomainRejection && err.reason === "safety_would_degrade",
  );
  // 已完成的环节不能被重排
  assert.throws(
    () =>
      svc.replan({
        group_id: "team-a",
        cause: { type: "station_closed", station_id: "cnc" },
        replacements: [{ replaces_segment_id: seg1, station_id: "cnc", slot: SLOT2 }],
      }),
    (err) => err instanceof DomainRejection && err.reason === "segment_locked",
  );

  const events = svc.replan({
    group_id: "team-a",
    cause: { type: "station_closed", station_id: "welding" },
    replacements: [{ replaces_segment_id: seg2, station_id: "cnc", slot: SLOT2 }],
  });
  assert.deepEqual(
    events.map((e) => e.kind),
    ["HOLD_RELEASED", "ITINERARY_HELD", "ROUTE_REPLANNED"],
  );

  const itinerary = svc.state.itineraries.get("team-a");
  assert.equal(itinerary.get(seg1).status, "completed"); // 完成过的环节与证据保留
  assert.deepEqual(itinerary.get(seg1).evidence.objectives, ["cnc-basics"]);
  assert.equal(itinerary.get(seg2).status, "replanned");
  assert.equal(itinerary.get("team-a-seg-3").status, "held");

  const rerouted = events.find((e) => e.kind === "ROUTE_REPLANNED");
  assert.equal(rerouted.payload.cause.type, "station_closed");
  assert.ok(rerouted.payload.affected.some((a) => a.group_id === "team-a" && a.effect === "rerouted"));
  assert.equal(replanImpacts(svc.state, "team-a").length, 1);
});

test("先修条件与导师班次属于强制安全条件", () => {
  const svc = createService({ now: T0, holdTtlMs: 30 * MIN });
  svc.publishStation({
    station_id: "lathe",
    ...openStation({
      prerequisites: ["cnc-basics"],
      mentor_shifts: [{ start: "2026-09-23T08:00:00+08:00", end: "2026-09-23T10:00:00+08:00", mentors: 1 }],
    }),
  });
  requestTeam(svc, "team-a", 8);
  assert.throws(
    () => svc.plan({ group_id: "team-a", stops: [{ station_id: "lathe", slot: SLOT }] }),
    (err) => err.reason === "safety_unmet" && err.detail.problems.includes("prerequisite:cnc-basics"),
  );

  requestTeam(svc, "team-b", 8, { completed_objectives: ["cnc-basics"] });
  const slotCovered = { start: "2026-09-23T09:00:00+08:00", end: "2026-09-23T10:00:00+08:00" };
  const [held] = svc.plan({ group_id: "team-b", stops: [{ station_id: "lathe", slot: slotCovered }] });
  assert.equal(held.kind, "ITINERARY_HELD");
  // 时间窗之外
  assert.throws(
    () =>
      svc.plan({
        group_id: "team-b",
        stops: [{ station_id: "lathe", slot: { start: "2026-09-23T13:00:00+08:00", end: "2026-09-23T14:00:00+08:00" } }],
      }),
    (err) => err.reason === "outside_time_window",
  );
  // 时间窗之内但导师班次不覆盖
  assert.throws(
    () =>
      svc.plan({
        group_id: "team-b",
        stops: [{ station_id: "lathe", slot: { start: "2026-09-23T10:30:00+08:00", end: "2026-09-23T11:30:00+08:00" } }],
      }),
    (err) => err.reason === "mentor_shift_missing",
  );
});

test("服务重启后仍按原截止时间推进候补", () => {
  const svc = createService({ now: T0, holdTtlMs: 30 * MIN });
  svc.publishStation({ station_id: "cnc", ...openStation({ capacity: 6 }) });
  requestTeam(svc, "team-a", 6);
  requestTeam(svc, "team-b", 6);
  svc.plan({ group_id: "team-a", stops: [{ station_id: "cnc", slot: SLOT }] });
  svc.plan({ group_id: "team-b", stops: [{ station_id: "cnc", slot: SLOT }] });

  const restored = restoreService(svc.log, { now: T0, holdTtlMs: 30 * MIN });
  const events = restored.advanceTo(T0 + 31 * MIN);
  const promoted = events.find((e) => e.kind === "ITINERARY_HELD");
  assert.equal(promoted.payload.group_id, "team-b");
  assert.equal(promoted.payload.expires_at, iso(T0 + 61 * MIN));
  assert.equal(restored.state.groups.get("team-b").defer_count, 1);
});

test("参观结束按实际到访核销，计划与实绩差异可见", () => {
  const svc = newService();
  requestTeam(svc, "team-a", 8);
  const [h1, h2] = svc.plan({
    group_id: "team-a",
    stops: [
      { station_id: "cnc", slot: SLOT },
      { station_id: "welding", slot: SLOT2 },
    ],
  });
  svc.checkin({ group_id: "team-a", segment_id: h1.payload.segment_id, station_id: "cnc", source: { device_id: "kiosk-1", seq: 1 } });
  svc.recordEvidence({ group_id: "team-a", segment_id: h1.payload.segment_id, evidence: { objectives: ["cnc-basics"], note: "完成（虚构）" } });

  const [reconciled] = svc.reconcile({
    group_id: "team-a",
    actual: [{ segment_id: h1.payload.segment_id, station_id: "cnc", slot: SLOT }],
  });
  assert.equal(reconciled.kind, "VISIT_RECONCILED");
  const diff = planVsActual(svc.state, "team-a");
  assert.equal(diff.differences.length, 1);
  assert.equal(diff.differences[0].type, "missed");
  assert.equal(diff.differences[0].planned.segment_id, h2.payload.segment_id);
});
