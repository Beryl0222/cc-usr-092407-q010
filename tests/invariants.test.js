// 协调引擎不变量测试：不依赖周三具体剧情，逐条锁定业务规则。

import assert from "node:assert/strict";
import test from "node:test";

import {
  REASONS,
  agingPoints,
  append,
  applyEvent,
  initialState,
  planRoute,
  planVsActual,
  processWaitlist,
  queueView,
  reconcile,
  replan,
  restore,
  tick,
} from "../src/coordinator.js";

const DAY = "2026-09-23";
const iso = (hm) => `${DAY}T${hm}:00+08:00`;
let counter = 0;
const ids = () => (p) => `${p}-t${(++counter).toString(10).padStart(3, "0")}`;

function station(station_id, patch = {}) {
  return {
    event_id: `pub-${station_id}-${(patch.version ?? 1)}`,
    kind: "STATION_CAPACITY_SET",
    occurred_at: iso("08:00"),
    subject_id: station_id,
    payload: {
      station_id,
      version: 1,
      effective_at: iso("08:00"),
      status: "active",
      slots: [{ start: iso("09:30"), end: iso("10:30") }],
      seats_per_slot: 20,
      prerequisites: [],
      equipment: [],
      mentor_shifts: [],
      safety_requirements: { mandatory: [], provides: [] },
      objectives: ["obj-x"],
      ...patch,
    },
  };
}

function group(group_id, patch = {}) {
  return {
    event_id: `req-${group_id}`,
    kind: "GROUP_REQUESTED",
    occurred_at: iso("09:00"),
    subject_id: group_id,
    payload: {
      group_id,
      learning_objectives: ["obj-x"],
      time_window: { start: iso("09:00"), end: iso("12:00") },
      party: { total: 10, compliance: [] },
      ...patch,
    },
  };
}

test("不变量：容量绝不超额；候补按入队顺序排队并公开原因", () => {
  let s = initialState();
  s = append(s, [station("lab", { seats_per_slot: 15 }), group("g1"), group("g2")]);
  const p1 = planRoute(s, "g1", iso("09:05"), { idFactory: ids() });
  s = append(s, p1.events);
  const p2 = planRoute(s, "g2", iso("09:06"), { idFactory: ids() });
  s = append(s, p2.events);

  // g1 占用 10；g2（10 人）塞不进仅剩 5 席，进入候补而非超额。
  assert.equal(p1.events.length, 1);
  assert.equal(p2.events[0].kind, "WAITLIST_ENQUEUED");
  assert.equal(p2.events[0].payload.reason_code, REASONS.CAPACITY_FULL);
  const q = queueView(s, iso("09:06"));
  assert.equal(q[0].queue.length, 1);
  assert.equal(q[0].queue[0].group_id, "g2");
});

test("不变量：持续等待者老化积分增长，并在公开顺序中超过后来者", () => {
  let s = initialState();
  s = append(s, [station("lab", { seats_per_slot: 10 }), group("g1", { party: { total: 10 } }), group("g2"), group("g3")]);
  s = append(s, planRoute(s, "g1", iso("09:00"), { idFactory: ids() }).events);
  s = append(s, planRoute(s, "g2", iso("09:01"), { idFactory: ids() }).events); // g2 先排
  s = append(s, planRoute(s, "g3", iso("09:02"), { idFactory: ids() }).events); // g3 后排

  const waitOf = (gid) => [...s.waits.values()].find((w) => w.group_id === gid);
  assert.equal(agingPoints(waitOf("g2"), iso("09:03")), 0);
  assert.equal(agingPoints(waitOf("g2"), iso("09:30")), 5); // 默认每 5 分钟 1 分

  // 09:30 扩容到 30 席：两个候补都能进；队首仍是等待更久的 g2（同分时按入队顺序）。
  s = append(s, [station("lab", { version: 2, seats_per_slot: 30 })]);
  const promo = processWaitlist(s, iso("09:30"), { idFactory: ids() });
  const promotedGroups = promo.events.filter((e) => e.kind === "WAITLIST_PROMOTED").map((e) => e.payload.group_id);
  assert.deepEqual(promotedGroups, ["g2", "g3"]);
});

test("不变量：有期限占用到期由可控时钟释放，并提升队首候补", () => {
  let s = initialState();
  s = append(s, [station("lab", { seats_per_slot: 10 }), group("g1", { party: { total: 10 } }), group("g2")]);
  s = append(s, planRoute(s, "g1", iso("09:00"), { idFactory: ids(), ttlMinutes: 10 }).events);
  s = append(s, planRoute(s, "g2", iso("09:01"), { idFactory: ids() }).events);
  assert.equal([...s.waits.values()].length, 1);

  // 09:15 时钟推进：g1 的未确认占用过期，g2 候补提升为新占用。
  const after = tick(s, iso("09:15"));
  const expired = [...after.state.holds.values()].filter((h) => h.status === "expired");
  assert.equal(expired.length, 1);
  assert.ok([...after.state.holds.values()].some((h) => h.promoted_from_wait && h.group_id === "g2"));

  // 再 tick 一次不产生重复过期/重复提升（派生事件幂等）。
  const again = tick(after.state, iso("09:20"));
  assert.equal(again.events.length, 0);
});

test("不变量：重启重放得到与连续运行一致的候补结果（截止时间来自日志）", () => {
  const log = [];
  let s = initialState();
  const feed = (es) => {
    s = append(s, es);
    log.push(...es);
  };
  feed([station("lab", { seats_per_slot: 10 }), group("g1", { party: { total: 10 } }), group("g2")]);
  feed(planRoute(s, "g1", iso("09:00"), { idFactory: ids(), ttlMinutes: 10 }).events);
  feed(planRoute(s, "g2", iso("09:01"), { idFactory: ids() }).events);

  // 连续运行：09:15 时钟推进。
  const online = tick(s, iso("09:15"));
  // 宕机恢复：只凭日志重放到 09:15。
  const restarted = restore(log, iso("09:15"));

  const statuses = (st) => [...st.holds.values()].map((h) => `${h.group_id}:${h.status}`).sort();
  assert.deepEqual(statuses(restarted.state ?? restarted), statuses(online.state));
  assert.ok(statuses(online.state).includes("g2:held"));
  assert.ok(statuses(online.state).includes("g1:expired"));
});

test("不变量：已确认占用不过期；过期事件迟到也不翻转确认状态", () => {
  let s = initialState();
  s = append(s, [station("lab"), group("g1")]);
  const plan = planRoute(s, "g1", iso("09:00"), { idFactory: ids(), ttlMinutes: 10 });
  s = append(s, plan.events);
  const holdId = plan.events[0].payload.hold_id;
  s = append(s, [
    {
      event_id: "conf-1",
      kind: "ITINERARY_CONFIRMED",
      occurred_at: iso("09:05"),
      subject_id: "g1",
      source_id: "tab-1",
      source_seq: 1,
      payload: { hold_id: holdId },
    },
  ]);
  const after = tick(s, iso("09:30"));
  assert.equal(after.events.length, 0);
  assert.equal(s.holds.get(holdId).status, "confirmed");
});

test("不变量：迟到只重排赶不上的未开始环节，已到访/证据环节保留", () => {
  const log = [];
  let s = initialState();
  const feed = (es) => {
    s = append(s, es);
    log.push(...es);
  };
  feed([
    station("lab", { slots: [{ start: iso("09:30"), end: iso("10:00") }, { start: iso("10:30"), end: iso("11:00") }] }),
    group("g1"),
  ]);
  // 手工放两个环节（同一目标的两个班次不重叠，分别占用）。
  feed(
    planRoute(s, "g1", iso("09:00"), { idFactory: ids() }).events,
  );
  const firstSeg = g1Segments(s)[0];
  // 第一环节已完成并留下证据。
  feed([
    {
      event_id: "ck-1",
      kind: "SEGMENT_CHECKED_IN",
      occurred_at: iso("09:30"),
      subject_id: "g1",
      source_id: "tab",
      source_seq: 1,
      payload: { group_id: "g1", segment_id: firstSeg.segment_id, station_id: "lab", checked_in_at: iso("09:30") },
    },
    {
      event_id: "ev-1",
      kind: "LEARNING_EVIDENCE_RECORDED",
      occurred_at: iso("09:55"),
      subject_id: "g1",
      source_id: "tab",
      source_seq: 2,
      payload: { group_id: "g1", segment_id: firstSeg.segment_id, evidence_id: "evidence-1", objectives: ["obj-x"], completed_at: iso("09:55") },
    },
  ]);
  // 第二个未开始环节在 10:30；团队迟到至 10:45，该环节赶不上 -> 改到…… 无更晚班次时记录取消原因。
  // 先给第二个环节一个占位：用另一个学习目标简化，这里直接断言迟到重排不碰已完成环节。
  const r = replan(s, { trigger: "late", group_id: "g1", eta: iso("10:45") }, iso("10:05"), { idFactory: ids() });
  const retained = r.events.find((e) => e.kind === "ROUTE_REPLANNED").payload.retained_segments;
  assert.deepEqual(retained, [firstSeg.segment_id]);
  assert.equal(s.segments.get(firstSeg.segment_id).status, "completed");
  assert.deepEqual(s.segments.get(firstSeg.segment_id).evidence_ids, ["evidence-1"]);

  // 核销时证据仍在，实际到访被如实记录。
  const rec = reconcile(r.state, "g1", iso("12:00"), { idFactory: ids() });
  assert.deepEqual(rec.event.payload.evidence_ids, ["evidence-1"]);
});

test("不变量：成员变化后重新核对容量与强制安全条件，不降低安全门槛", () => {
  let s = initialState();
  s = append(s, [
    station("lab", { seats_per_slot: 8, safety_requirements: { mandatory: ["goggle"], provides: [] } }),
    group("g1", { party: { total: 6, compliance: ["goggle"] } }),
  ]);
  s = append(s, planRoute(s, "g1", iso("09:00"), { idFactory: ids() }).events);
  assert.equal([...s.holds.values()].filter((h) => h.status === "held").length, 1);

  // 成员扩到 12 人且新增一名未戴护目镜资质的成员的合规缺失：超出容量且强制条件不满足。
  s = append(s, [
    {
      event_id: "upd-1",
      kind: "GROUP_UPDATED",
      occurred_at: iso("09:10"),
      subject_id: "g1",
      payload: {
        group_id: "g1",
        reason: "members_changed",
        effective_at: iso("09:10"),
        changes: { party: { total: 12, compliance: [] } },
      },
    },
  ]);
  const r = replan(s, { trigger: "members_changed", group_id: "g1" }, iso("09:11"), { idFactory: ids() });
  const unmet = r.unmet;
  assert.ok(unmet.some((u) => u.reason_code === REASONS.PARTY_EXCEEDS_CAPACITY || u.reason_code === REASONS.NO_SAFE_ALTERNATIVE));
  const safety = r.events.find((e) => e.kind === "ROUTE_REPLANNED").payload.safety_check;
  assert.ok(safety.every((c) => c.downgrade_allowed === false || c.mandatory_satisfied === true));
  // 原未开始占用已取消，且没有产生 g1 的新占用（不超额、不合规绝不安排）。
  assert.ok(![...r.state.holds.values()].some((h) => h.group_id === "g1" && ["held", "confirmed"].includes(h.status)));
});

test("不变量：站点带版本公布，乱序旧版本不覆盖新版本", () => {
  let s = initialState();
  s = append(s, [station("lab", { version: 2, seats_per_slot: 30, status: "suspended" })]);
  s = append(s, [station("lab", { version: 1, seats_per_slot: 20, status: "active" })]); // 迟到的旧版本
  assert.equal(s.stations.get("lab").current.version, 2);
  assert.equal(s.stations.get("lab").current.status, "suspended");
  assert.ok(s.ignored.some((i) => i.reason === "stale_station_version"));
});

test("不变量：先修条件未满足不可安排，完成先修后才能占用", () => {
  let s = initialState();
  s = append(s, [
    station("lab", { prerequisites: ["safety_basic"] }),
    group("g1"),
  ]);
  const r = planRoute(s, "g1", iso("09:00"), { idFactory: ids() });
  assert.equal(r.events.length, 0);
  assert.equal(r.unmet[0].reason_code, REASONS.PREREQUISITE_MISSING);
});

test("不变量：无安全可选方案时宁可标记不可满足，也不安排到不达标站点", () => {
  let s = initialState();
  s = append(s, [
    station("stairs-only", { safety_requirements: { mandatory: [], provides: [] } }),
    group("g1", { party: { total: 4, accessibility_needs: ["wheelchair"], compliance: [] } }),
  ]);
  const r = planRoute(s, "g1", iso("09:00"), { idFactory: ids() });
  assert.equal(r.events.length, 0);
  assert.equal(r.unmet[0].reason_code, REASONS.NO_SAFE_ALTERNATIVE);
  assert.match(r.unmet[0].reason_detail, /^step_free_access/);
});

test("不变量：计划与实绩差异完整反映改道、缺席与证据", () => {
  const log = [];
  let s = initialState();
  const feed = (es) => {
    s = append(s, es);
    log.push(...es);
  };
  feed([station("a", { objectives: ["obj-x"] }), station("b", { objectives: ["obj-x"] }), group("g1")]);
  feed(planRoute(s, "g1", iso("09:00"), { idFactory: ids() }).events);
  feed([station("a", { version: 2, status: "suspended" })]);
  const r = replan(s, { trigger: "station_suspended", station_id: "a" }, iso("09:10"), { idFactory: ids() });
  feed(r.events);
  const rec = reconcile(r.state, "g1", iso("12:00"), { idFactory: ids() });
  feed([rec.event]);

  const diff = planVsActual(rec.state, "g1");
  const cancelled = diff.filter((d) => d.status === "cancelled");
  const rerouted = diff.filter((d) => d.rerouted && d.status !== "cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(rerouted.length, 1);
  assert.equal(rerouted[0].planned.station_id, "a");
  assert.equal(rerouted[0].actual, null); // 未到访：有改道计划但无实际到访
  assert.ok(rec.event.payload.deviations.some((d) => d.type === "no_show"));
});

function g1Segments(s) {
  return s.groups.get("g1").plan.map((id) => s.segments.get(id));
}
