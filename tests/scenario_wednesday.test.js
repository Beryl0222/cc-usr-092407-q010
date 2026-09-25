// 周三上午技能博物馆的完整业务场景：
// 两个学校团队同时抵达，数控实训站临时停用；一个团队含轮椅成员，另一个要赶返程。
// 覆盖：带版本公布、有期限占用、停站改道、公开候补与推迟原因、扩容版本提升、
// 离线设备按来源序号合并、过期释放、证据保留、按实际到访核销与改道影响视图。

import assert from "node:assert/strict";
import test from "node:test";

import {
  REASONS,
  applyEvent,
  append,
  planRoute,
  processWaitlist,
  queueView,
  rerouteImpacts,
  reconcile,
  replan,
  planVsActual,
  initialState,
} from "../src/coordinator.js";

const DAY = "2026-09-23";
const iso = (hm) => `${DAY}T${hm}+08:00`;

function stationEvent(station_id, version, patch, effective = iso("08:00")) {
  return {
    event_id: `pub-${station_id}-v${version}`,
    kind: "STATION_CAPACITY_SET",
    occurred_at: effective,
    subject_id: station_id,
    payload: {
      station_id,
      version,
      effective_at: effective,
      status: "active",
      slots: [
        { start: iso("09:30"), end: iso("10:30") },
        { start: iso("10:45"), end: iso("11:45") },
      ],
      seats_per_slot: 20,
      prerequisites: [],
      equipment: [],
      mentor_shifts: [],
      safety_requirements: { mandatory: ["safety_induction"], provides: ["step_free_access"] },
      objectives: [],
      ...patch,
    },
  };
}

function groupEvent(group_id, patch) {
  return {
    event_id: `req-${group_id}`,
    kind: "GROUP_REQUESTED",
    occurred_at: iso("09:00"),
    subject_id: group_id,
    payload: {
      group_id,
      learning_objectives: ["cnc_basic"],
      time_window: { start: iso("09:00"), end: iso("12:00") },
      party: { total: 6, compliance: ["safety_induction"] },
      ...patch,
    },
  };
}

const device = (source_id, source_seq, kind, subject_id, payload, at) => ({
  event_id: `dev-${source_id}-${source_seq}-${kind}`,
  kind,
  occurred_at: at,
  subject_id,
  source_id,
  source_seq,
  payload,
});

// 全场景共用顺序号工厂，使事件日志确定性可重放。
function sharedIds() {
  let n = 0;
  return (prefix) => `${prefix}-${(++n).toString(10).padStart(4, "0")}`;
}

function buildScenario() {
  const log = [];
  let state = initialState();
  const ids = sharedIds();
  const emit = (events) => {
    state = append(state, events);
    log.push(...events);
    return events;
  };

  // 08:00 站点带版本公布。
  emit([
    stationEvent("cnc-lab", 1, {
      objectives: ["cnc_basic"],
      equipment: ["cnc_lathe_x6"],
      mentor_shifts: [{ mentor_id: "mentor-cnc-1", shift: "09:30-11:45" }],
    }),
    stationEvent("digital-lab", 1, {
      seats_per_slot: 8,
      objectives: ["cnc_basic"],
      equipment: ["laser_cutter_x4", "3d_printer_x4"],
      mentor_shifts: [{ mentor_id: "mentor-dm-1", shift: "09:30-11:45" }],
      safety_requirements: { mandatory: ["safety_induction"], provides: ["step_free_access"] },
    }),
  ]);

  // 09:00 两个团队同时抵达并提交申请。
  emit([
    groupEvent("team-a", {
      party: { total: 6, accessibility_needs: ["wheelchair"], compliance: ["safety_induction"] },
      support_needs: ["step_free_access"],
      note: "虚构脱敏：含轮椅成员的学校团队",
    }),
    groupEvent("team-b", {
      time_window: { start: iso("09:00"), end: iso("11:30") },
      note: "虚构脱敏：11:30 返程大巴",
    }),
  ]);

  // 09:05 排程：两团都落在数控站 09:30 班次（共 12 人，容量 20）。
  emit(planRoute(state, "team-a", iso("09:05"), { idFactory: ids }).events);
  emit(planRoute(state, "team-b", iso("09:05"), { idFactory: ids }).events);

  const holdA = [...state.holds.values()].find((h) => h.group_id === "team-a");
  const holdB = [...state.holds.values()].find((h) => h.group_id === "team-b");
  assert.equal(holdA.station_id, "cnc-lab");
  assert.equal(holdB.station_id, "cnc-lab");

  // 09:15 导师离线平板分别确认两个占用。
  emit([
    device("tablet-7f", 1, "ITINERARY_CONFIRMED", "team-a", { hold_id: holdA.hold_id }, iso("09:15")),
    device("tablet-3b", 1, "ITINERARY_CONFIRMED", "team-b", { hold_id: holdB.hold_id }, iso("09:15")),
  ]);

  // 09:20 数控站设备故障，公布 v2 停用。
  emit([stationEvent("cnc-lab", 2, { status: "suspended" }, iso("09:20"))]);

  // 09:21 全站改道：只取消未开始环节；替代站必须无障碍。
  const replan1 = replan(
    state,
    { trigger: "station_suspended", station_id: "cnc-lab" },
    iso("09:21"),
    { idFactory: ids },
  );
  state = replan1.state;
  log.push(...replan1.events);

  return { log, get state() { return state; }, ids, emit, holdA, holdB, replan1 };
}

test("场景：数控站停用后，轮椅团队改道无障碍站点，返程团队进入公开候补", () => {
  const sc = buildScenario();
  const { state, replan1 } = sc;

  // 原数控站占用全部取消（当时均未开始）。
  assert.ok([...state.holds.values()].filter((h) => h.station_id === "cnc-lab").every((h) => h.status === "cancelled"));

  // 轮椅团队 A 得到数字化制造站（无台阶通道）的替代有期限占用。
  const newHoldA = [...state.holds.values()].find((h) => h.group_id === "team-a" && h.status === "held");
  assert.equal(newHoldA.station_id, "digital-lab");

  // B 因 09:30 班次剩余名额不足以容纳整团，且 10:45 班次超出其返程时间窗，进入公开候补。
  const queue = queueView(state, iso("09:21"));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].queue[0].group_id, "team-b");
  assert.equal(queue[0].queue[0].reason_code, REASONS.REROUTED);
  assert.match(queue[0].queue[0].reason_detail, /改道/);

  // 安全核对：替代方案满足强制安训与轮椅无障碍，未降低任何强制条件。
  const aSafety = replan1.events.find((e) => e.kind === "ROUTE_REPLANNED").payload.safety_check.find((c) => c.group_id === "team-a");
  assert.deepEqual(aSafety, {
    group_id: "team-a",
    replacement_station: "digital-lab",
    mandatory_satisfied: true,
    accessibility_satisfied: true,
  });

  // 影响可解释：A 失去数控环节又获得替代；B 失去后被推迟，原因可查。
  const impacts = rerouteImpacts(state);
  assert.equal(impacts.length, 1);
  const groups = Object.fromEntries(impacts[0].affected_groups.map((g) => [g.group_id, g]));
  assert.equal(groups["team-a"].lost.length, 1);
  assert.equal(groups["team-a"].gained.length, 1);
  assert.equal(groups["team-b"].lost.length, 1);
  assert.equal(groups["team-b"].waited.length, 1);
  assert.match(impacts[0].explanation, /临时停用/);
});

test("场景：站点公布加开班次后，候补按公开记录获得占用，截止时间重新计时", () => {
  const sc = buildScenario();
  let { state, ids, emit } = sc;

  // 09:24 数字化制造站公布 v2：加开导师班次，09:30 容量 8 -> 12。
  emit([
    stationEvent(
      "digital-lab",
      2,
      {
        seats_per_slot: 12,
        mentor_shifts: [
          { mentor_id: "mentor-dm-1", shift: "09:30-11:45" },
          { mentor_id: "mentor-dm-2", shift: "09:30-11:45" },
        ],
        safety_requirements: { mandatory: ["safety_induction"], provides: ["step_free_access"] },
      },
      iso("09:24"),
    ),
  ]);

  const before = queueView(state, iso("09:24"))[0].queue;
  assert.equal(before[0].group_id, "team-b");

  const promo = processWaitlist(state, iso("09:24"), { idFactory: ids });
  state = promo.state;
  sc.log.push(...promo.events);

  const promoted = promo.events.find((e) => e.kind === "WAITLIST_PROMOTED");
  assert.equal(promoted.payload.group_id, "team-b");
  assert.equal(promoted.payload.aging_points, 0);
  assert.ok(Date.parse(promo.events.find((e) => e.kind === "ITINERARY_HELD").payload.expires_at) > Date.parse(iso("09:24")));

  const holdB = [...state.holds.values()].find((h) => h.hold_id === promoted.payload.hold_id);
  assert.equal(holdB.station_id, "digital-lab");

  // 离线设备重连：B 的平板用 seq=2 确认新占用；旧数控占用的 seq=1 确认重传必须被忽略。
  const stale = { ...device("tablet-3b", 1, "ITINERARY_CONFIRMED", "team-b", { hold_id: "hold-cnc-b" }, iso("09:25")), event_id: "stale-replay-cnc-confirm" };
  const fresh = device("tablet-3b", 2, "ITINERARY_CONFIRMED", "team-b", { hold_id: holdB.hold_id }, iso("09:26"));
  state = append(state, [stale, fresh]);
  sc.log.push(stale, fresh);
  assert.ok(state.ignored.some((i) => i.event_id === stale.event_id && i.reason === "stale_source_seq"));
  assert.equal(holdB.status, "confirmed");

  // 09:30 两团签到（真实到访）。
  const segA = [...state.segments.values()].find((s) => s.group_id === "team-a" && s.station_id === "digital-lab");
  const segB = [...state.segments.values()].find((s) => s.segment_id === holdB.segment_id);
  const checkins = [
    device("tablet-7f", 2, "SEGMENT_CHECKED_IN", "team-a", { group_id: "team-a", segment_id: segA.segment_id, station_id: "digital-lab", checked_in_at: iso("09:30") }, iso("09:30")),
    device("tablet-3b", 3, "SEGMENT_CHECKED_IN", "team-b", { group_id: "team-b", segment_id: segB.segment_id, station_id: "digital-lab", checked_in_at: iso("09:31") }, iso("09:31")),
  ];
  state = append(state, checkins);
  sc.log.push(...checkins);

  // 完成学习证据（B 赶返程，先完成）。
  const evidences = [
    device("tablet-3b", 4, "LEARNING_EVIDENCE_RECORDED", "team-b", { group_id: "team-b", segment_id: segB.segment_id, evidence_id: "ev-b-1", objectives: ["cnc_basic"], completed_at: iso("10:10") }, iso("10:10")),
    device("tablet-7f", 3, "LEARNING_EVIDENCE_RECORDED", "team-a", { group_id: "team-a", segment_id: segA.segment_id, evidence_id: "ev-a-1", objectives: ["cnc_basic"], completed_at: iso("10:20") }, iso("10:20")),
  ];
  state = append(state, evidences);
  sc.log.push(...evidences);

  // 核销：以实际到访为准；计划站是 cnc-lab，实际在 digital-lab，差异与改道链可查。
  const recB = reconcile(state, "team-b", iso("11:35"), { idFactory: ids });
  state = recB.state;
  sc.log.push(recB.event);
  const recA = reconcile(state, "team-a", iso("12:05"), { idFactory: ids });
  state = recA.state;
  sc.log.push(recA.event);

  const diffA = planVsActual(state, "team-a");
  const reroutedA = diffA.filter((d) => d.rerouted);
  assert.equal(reroutedA.length, 1);
  assert.equal(reroutedA[0].planned.station_id, "cnc-lab");
  assert.equal(reroutedA[0].actual.station_id, "digital-lab");
  assert.deepEqual(reroutedA[0].evidence_ids, ["ev-a-1"]);

  const deviationsB = recB.event.payload.deviations;
  assert.ok(deviationsB.some((d) => d.type === "rerouted" && d.from === "cnc-lab" && d.to === "digital-lab"));
  assert.deepEqual(recB.event.payload.evidence_ids, ["ev-b-1"]);

  // 整个日志从零重放，状态一致（事件溯源 + 确定性派生 id）。
  const replayState = sc.log.reduce((s, e) => applyEvent(s, e), initialState());
  assert.equal(replayState.segments.size, state.segments.size);
  assert.equal(replayState.evidences.size, 2);
  assert.deepEqual(
    [...replayState.segments.values()].map((s) => [s.segment_id, s.status]).sort(),
    [...state.segments.values()].map((s) => [s.segment_id, s.status]).sort(),
  );
});

test("场景：旧消息重传不能把资源再次扣减或翻转已定状态", () => {
  const sc = buildScenario();
  let state = sc.state;
  const segA = [...state.segments.values()].find((s) => s.group_id === "team-a" && s.station_id === "digital-lab");
  const holdA = state.holds.get(segA.hold_id);

  // seq=2 签到；随后离线路由器重放一条更小序号的拒绝，必须按来源序列丢弃。
  const checkin = device("tablet-7f", 2, "SEGMENT_CHECKED_IN", "team-a", { group_id: "team-a", segment_id: segA.segment_id, station_id: "digital-lab", checked_in_at: iso("09:30") }, iso("09:30"));
  const lateReject = device("tablet-7f", 1, "ITINERARY_REJECTED", "team-a", { hold_id: holdA.hold_id, reason: "stale reject" }, iso("09:32"));
  state = append(state, [checkin, lateReject]);
  assert.ok(state.ignored.some((i) => i.event_id === lateReject.event_id && i.reason === "stale_source_seq"));
  assert.equal(holdA.status, "checkedin");

  // 同一条签到重传（同 event_id）也是幂等的，不产生第二次到访/扣减。
  const ignoredBefore = state.ignored.length;
  state = append(state, [checkin]);
  assert.equal(state.ignored.length, ignoredBefore + 1);
  assert.equal(state.ignored.at(-1).reason, "duplicate_event_id");

  // 过期取消之后才送到的签到：记录到访事实，但不重新占用容量（核销时仍可见）。
  const otherHold = [...state.holds.values()].find((h) => h.group_id === "team-b" && h.status === "cancelled");
  assert.ok(otherHold);
  const lateCheckin = device("tablet-3b", 9, "SEGMENT_CHECKED_IN", "team-b", { group_id: "team-b", segment_id: otherHold.segment_id, station_id: "cnc-lab", checked_in_at: iso("11:00") }, iso("11:00"));
  state = append(state, [lateCheckin]);
  assert.ok(state.ignored.some((i) => i.event_id === lateCheckin.event_id && i.reason === "segment_not_active"));
  assert.equal(state.groups.get("team-b").unexpected_visits.length, 1);
});
