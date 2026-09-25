// 行程协调领域服务。
//
// 在事件基线（src/skill_museum_learning.js）之上提供实时但可解释的编排：
// - 申请、公告、占位、确认、签到、改道、候补与核销都落成事件，状态完全由事件重放得到；
// - 确认、拒绝、签到可来自离线设备，按来源序列合并，旧消息不会重复扣减资源；
// - 过期占用只能由可控时钟（advanceTo）释放，服务重启后按事件中的原截止时间继续推进候补；
// - 每次推迟与改道都记录原因和受影响方，协调员可解释每一步决策。

import { validateEvent } from "./skill_museum_learning.js";

export class DomainRejection extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "DomainRejection";
    this.reason = reason;
    this.detail = detail;
  }
}

const ACTIVE_HOLD = new Set(["held", "confirmed"]); // 仍占用容量的占位状态
const REPLANNABLE = new Set(["waiting", "held", "confirmed", "released"]); // 未开始、可改道的环节
const OPEN_SEGMENT = new Set(["waiting", "held", "confirmed"]); // 尚未到场的环节

const iso = (ms) => new Date(ms).toISOString();
const slotKey = (slot) => `${slot.start}/${slot.end}`;
const queueKey = (stationId, slot) => `${stationId}|${slotKey(slot)}`;
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function createState() {
  return {
    groups: new Map(), // group_id -> 团队（含被推迟次数等资历）
    stations: new Map(), // station_id -> 当前生效的站点公告（按版本）
    holds: new Map(), // hold_id -> 资源占用
    itineraries: new Map(), // group_id -> Map(segment_id -> 环节)
    waitlists: new Map(), // 站点+时段 -> 候补队列（公开顺序见 publicQueue）
    deferrals: [], // 被推迟记录（含原因，公开可查）
    replans: [], // 改道记录（含受影响方）
    reconciliations: new Map(), // group_id -> 核销结果
    sources: new Map(), // device_id -> 已合并的最大序列号
    seen: new Set(), // 已合并的 event_id（幂等）
  };
}

// ---------- 查询：容量、安全与公开顺序 ----------

export function getGroup(state, groupId) {
  const group = state.groups.get(groupId);
  if (!group) throw new DomainRejection("group_unknown", { group_id: groupId });
  return group;
}

export function getStation(state, stationId) {
  const station = state.stations.get(stationId);
  if (!station) throw new DomainRejection("station_unknown", { station_id: stationId });
  return station;
}

export function availableCapacity(state, stationId, slot) {
  const station = state.stations.get(stationId);
  if (!station || station.status !== "open") return 0;
  let used = 0;
  for (const hold of state.holds.values()) {
    if (hold.station_id === stationId && slotKey(hold.slot) === slotKey(slot) && ACTIVE_HOLD.has(hold.status)) {
      used += hold.quantity;
    }
  }
  return station.capacity - used;
}

// 强制安全条件：替代方案不得降低这些条件。
export function safetyProblems(group, station) {
  const problems = [];
  if ((group.support_needs ?? []).includes("wheelchair_access") && !station.safety?.wheelchair_accessible) {
    problems.push("wheelchair_access");
  }
  const total = group.members?.total ?? 0;
  if (station.safety?.max_group_size != null && total > station.safety.max_group_size) {
    problems.push("max_group_size");
  }
  if (station.safety?.min_mentors != null && (group.members?.mentors ?? 0) < station.safety.min_mentors) {
    problems.push("min_mentors");
  }
  const done = new Set(group.completed_objectives ?? []);
  for (const required of station.prerequisites ?? []) {
    if (!done.has(required)) problems.push(`prerequisite:${required}`);
  }
  return problems;
}

export function mentorCoverageOk(station, slot) {
  return (station.mentor_shifts ?? []).some(
    (shift) =>
      Date.parse(shift.start) <= Date.parse(slot.start) &&
      Date.parse(shift.end) >= Date.parse(slot.end) &&
      (shift.mentors ?? 0) > 0,
  );
}

// 公开顺序：被推迟次数多者优先（持续等待者逐步获得优先权），其次入队时间、编号。
export function publicQueue(state, stationId, slot) {
  const entries = state.waitlists.get(queueKey(stationId, slot)) ?? [];
  return entries
    .map((entry) => ({ ...entry, defer_count: state.groups.get(entry.group_id)?.defer_count ?? 0 }))
    .sort(
      (a, b) =>
        b.defer_count - a.defer_count ||
        Date.parse(a.enqueued_at) - Date.parse(b.enqueued_at) ||
        compareText(a.group_id, b.group_id) ||
        compareText(a.segment_id, b.segment_id),
    );
}

export function deferralLog(state, groupId = null) {
  return state.deferrals.filter((entry) => groupId == null || entry.group_id === groupId);
}

export function replanImpacts(state, groupId = null) {
  return state.replans.filter((entry) => groupId == null || entry.group_id === groupId);
}

export function planVsActual(state, groupId) {
  return state.reconciliations.get(groupId) ?? null;
}

// 站点停用/迟到/成员变化时，列出仍有未开始环节受影响的团队。
export function groupsAffectedByStation(state, stationId) {
  const affected = [];
  for (const [groupId, segments] of state.itineraries) {
    const open = [...segments.values()].filter((s) => s.station_id === stationId && OPEN_SEGMENT.has(s.status));
    if (open.length > 0) affected.push({ group_id: groupId, segments: open.map((s) => s.segment_id) });
  }
  return affected;
}

// ---------- 事件合并：幂等 + 来源序列 ----------

export function ingest(state, event) {
  const problems = validateEvent(event);
  if (problems.length > 0) throw new DomainRejection("invalid_event", { problems });
  if (state.seen.has(event.event_id)) return { applied: false, reason: "duplicate_event" };
  const source = event.payload?.source;
  if (source != null) {
    const last = state.sources.get(source.device_id) ?? 0;
    if ((source.seq ?? 0) <= last) return { applied: false, reason: "stale_source_sequence" };
  }
  applyEvent(state, event);
  state.seen.add(event.event_id);
  if (source != null) state.sources.set(source.device_id, source.seq);
  return { applied: true };
}

function applyEvent(state, event) {
  const p = event.payload;
  switch (event.kind) {
    case "GROUP_REQUESTED": {
      state.groups.set(event.subject_id, {
        id: event.subject_id,
        objectives: p.objectives,
        time_window: p.time_window,
        members: p.members,
        support_needs: p.support_needs,
        completed_objectives: [...(p.completed_objectives ?? [])],
        status: "requested",
        requested_at: event.occurred_at,
        defer_count: 0,
      });
      break;
    }
    case "STATION_CAPACITY_SET": {
      const prev = state.stations.get(event.subject_id);
      if (prev && p.version <= prev.version) break; // 旧版本公告不覆盖现状
      state.stations.set(event.subject_id, {
        id: event.subject_id,
        version: p.version,
        status: p.status,
        capacity: p.capacity,
        prerequisites: p.prerequisites,
        equipment: p.equipment,
        mentor_shifts: p.mentor_shifts,
        safety: p.safety,
      });
      break;
    }
    case "ITINERARY_HELD": {
      state.holds.set(p.hold_id, {
        id: p.hold_id,
        group_id: p.group_id,
        segment_id: p.segment_id,
        station_id: p.station_id,
        slot: p.slot,
        quantity: p.quantity,
        expires_at: p.expires_at,
        status: "held",
      });
      upsertSegment(state, p.group_id, p.segment_id, {
        station_id: p.station_id,
        slot: p.slot,
        quantity: p.quantity,
        status: "held",
        hold_id: p.hold_id,
      });
      dequeue(state, p.station_id, p.slot, p.segment_id);
      break;
    }
    case "ITINERARY_CONFIRMED": {
      const hold = mustHold(state, p.hold_id);
      if (hold.status !== "held") {
        throw new DomainRejection("hold_not_active", { hold_id: p.hold_id, status: hold.status });
      }
      hold.status = "confirmed";
      setSegmentStatus(state, hold.group_id, hold.segment_id, "confirmed");
      break;
    }
    case "ITINERARY_REJECTED": {
      const hold = mustHold(state, p.hold_id);
      if (!ACTIVE_HOLD.has(hold.status)) {
        throw new DomainRejection("hold_not_active", { hold_id: p.hold_id, status: hold.status });
      }
      hold.status = "released";
      setSegmentStatus(state, hold.group_id, hold.segment_id, "released");
      break;
    }
    case "CHECKIN_RECORDED": {
      const seg = mustSegment(state, p.group_id, p.segment_id);
      if (seg.status !== "held" && seg.status !== "confirmed") {
        throw new DomainRejection("segment_not_checkinable", { segment_id: p.segment_id, status: seg.status });
      }
      seg.status = "started";
      seg.checked_in_at = event.occurred_at;
      break;
    }
    case "HOLD_RELEASED": {
      const hold = mustHold(state, p.hold_id);
      if (!ACTIVE_HOLD.has(hold.status)) break; // 已释放，幂等
      hold.status = "released";
      const seg = state.itineraries.get(hold.group_id)?.get(hold.segment_id);
      if (seg && seg.status !== "replanned") seg.status = "released";
      break;
    }
    case "GROUP_DEFERRED": {
      const group = state.groups.get(p.group_id);
      if (group) group.defer_count += 1;
      const key = queueKey(p.station_id, p.slot);
      if (!state.waitlists.has(key)) state.waitlists.set(key, []);
      const list = state.waitlists.get(key);
      if (!list.some((entry) => entry.segment_id === p.segment_id)) {
        list.push({
          group_id: p.group_id,
          segment_id: p.segment_id,
          station_id: p.station_id,
          slot: p.slot,
          enqueued_at: event.occurred_at,
          reason: p.reason,
        });
      }
      upsertSegment(state, p.group_id, p.segment_id, {
        station_id: p.station_id,
        slot: p.slot,
        quantity: p.quantity,
        status: "waiting",
      });
      state.deferrals.push({
        group_id: p.group_id,
        station_id: p.station_id,
        slot: p.slot,
        reason: p.reason,
        queue_position: p.queue_position,
        occurred_at: event.occurred_at,
      });
      break;
    }
    case "ROUTE_REPLANNED": {
      for (const segmentId of p.replaced_segment_ids) {
        const seg = mustSegment(state, p.group_id, segmentId);
        if (!REPLANNABLE.has(seg.status)) {
          throw new DomainRejection("segment_locked", { segment_id: segmentId, status: seg.status });
        }
        seg.status = "replanned";
        seg.replaced_by = p.new_segments.map((s) => s.segment_id);
        dequeueBySegment(state, segmentId);
      }
      state.replans.push({
        group_id: p.group_id,
        cause: p.cause,
        replaced_segment_ids: p.replaced_segment_ids,
        new_segments: p.new_segments,
        affected: p.affected,
        occurred_at: event.occurred_at,
      });
      break;
    }
    case "EVIDENCE_RECORDED": {
      const seg = mustSegment(state, p.group_id, p.segment_id);
      if (seg.status !== "started" && seg.status !== "confirmed" && seg.status !== "held") {
        throw new DomainRejection("segment_not_started", { segment_id: p.segment_id, status: seg.status });
      }
      seg.status = "completed";
      seg.evidence = p.evidence;
      const group = state.groups.get(p.group_id);
      if (group) {
        for (const objective of p.evidence.objectives ?? []) {
          if (!group.completed_objectives.includes(objective)) group.completed_objectives.push(objective);
        }
      }
      break;
    }
    case "VISIT_RECONCILED": {
      state.reconciliations.set(p.group_id, {
        planned: p.planned,
        actual: p.actual,
        differences: p.differences,
        occurred_at: event.occurred_at,
      });
      const group = state.groups.get(p.group_id);
      if (group) group.status = "reconciled";
      break;
    }
    default:
      throw new DomainRejection("unknown_kind", { kind: event.kind });
  }
}

function mustHold(state, holdId) {
  const hold = state.holds.get(holdId);
  if (!hold) throw new DomainRejection("hold_unknown", { hold_id: holdId });
  return hold;
}

function mustSegment(state, groupId, segmentId) {
  const seg = state.itineraries.get(groupId)?.get(segmentId);
  if (!seg) throw new DomainRejection("segment_unknown", { group_id: groupId, segment_id: segmentId });
  return seg;
}

function upsertSegment(state, groupId, segmentId, patch) {
  if (!state.itineraries.has(groupId)) state.itineraries.set(groupId, new Map());
  const segments = state.itineraries.get(groupId);
  segments.set(segmentId, { segment_id: segmentId, ...segments.get(segmentId), ...patch });
}

function setSegmentStatus(state, groupId, segmentId, status) {
  const seg = state.itineraries.get(groupId)?.get(segmentId);
  if (seg) seg.status = status;
}

function dequeue(state, stationId, slot, segmentId) {
  const list = state.waitlists.get(queueKey(stationId, slot));
  if (!list) return;
  const index = list.findIndex((entry) => entry.segment_id === segmentId);
  if (index >= 0) list.splice(index, 1);
}

function dequeueBySegment(state, segmentId) {
  for (const list of state.waitlists.values()) {
    const index = list.findIndex((entry) => entry.segment_id === segmentId);
    if (index >= 0) list.splice(index, 1);
  }
}

function withinWindow(window, slot) {
  if (!window?.start || !window?.end) return true;
  return Date.parse(slot.start) >= Date.parse(window.start) && Date.parse(slot.end) <= Date.parse(window.end);
}

// ---------- 决策：命令 -> 事件 ----------

function makeEvent(ctx, kind, subjectId, payload) {
  return { event_id: ctx.nextId(), kind, occurred_at: iso(ctx.now), subject_id: subjectId, payload };
}

// 容量足够且轮到本团队时占位，否则进入公开候补并记录原因。
function holdOrDefer(work, group, stop, segmentId, ctx) {
  const quantity = stop.quantity ?? group.members?.total ?? 1;
  const queue = publicQueue(work, stop.station_id, stop.slot);
  const head = queue[0];
  const mayUseHead = !head || head.group_id === group.id;
  if (mayUseHead && availableCapacity(work, stop.station_id, stop.slot) >= quantity) {
    return makeEvent(ctx, "ITINERARY_HELD", group.id, {
      hold_id: `hold-${segmentId}`,
      group_id: group.id,
      segment_id: segmentId,
      station_id: stop.station_id,
      slot: stop.slot,
      quantity,
      expires_at: iso(ctx.now + ctx.holdTtlMs),
    });
  }
  return makeEvent(ctx, "GROUP_DEFERRED", group.id, {
    group_id: group.id,
    segment_id: segmentId,
    station_id: stop.station_id,
    slot: stop.slot,
    quantity,
    reason: mayUseHead ? "capacity_exhausted" : "queue_ahead",
    queue_position: queue.length + 1,
  });
}

export function decideRequest(state, cmd, ctx) {
  return [
    makeEvent(ctx, "GROUP_REQUESTED", cmd.group_id, {
      objectives: cmd.objectives ?? [],
      time_window: cmd.time_window,
      members: cmd.members,
      support_needs: cmd.support_needs ?? [],
      ...(cmd.completed_objectives ? { completed_objectives: cmd.completed_objectives } : {}),
    }),
  ];
}

export function decidePublishStation(state, cmd, ctx) {
  return [
    makeEvent(ctx, "STATION_CAPACITY_SET", cmd.station_id, {
      version: cmd.version,
      status: cmd.status ?? "open",
      capacity: cmd.capacity,
      prerequisites: cmd.prerequisites ?? [],
      equipment: cmd.equipment ?? [],
      mentor_shifts: cmd.mentor_shifts ?? [],
      safety: cmd.safety ?? {},
    }),
  ];
}

export function decidePlan(state, cmd, ctx) {
  const group = getGroup(state, cmd.group_id);
  const work = structuredClone(state); // 同一批 stops 之间要看到彼此的占位
  const workGroup = work.groups.get(group.id);
  const base = work.itineraries.get(group.id)?.size ?? 0;
  const events = [];
  cmd.stops.forEach((stop, index) => {
    const station = getStation(work, stop.station_id);
    if (station.status !== "open") {
      throw new DomainRejection("station_closed", { station_id: stop.station_id });
    }
    if (!withinWindow(workGroup.time_window, stop.slot)) {
      throw new DomainRejection("outside_time_window", { station_id: stop.station_id, slot: stop.slot });
    }
    const problems = safetyProblems(workGroup, station);
    if (problems.length > 0) {
      throw new DomainRejection("safety_unmet", { station_id: stop.station_id, problems });
    }
    if (!mentorCoverageOk(station, stop.slot)) {
      throw new DomainRejection("mentor_shift_missing", { station_id: stop.station_id, slot: stop.slot });
    }
    const segmentId = stop.segment_id ?? `${group.id}-seg-${base + index + 1}`;
    const event = holdOrDefer(work, workGroup, stop, segmentId, ctx);
    applyEvent(work, event);
    events.push(event);
  });
  return events;
}

export function decideConfirm(state, cmd, ctx) {
  const hold = mustHold(state, cmd.hold_id);
  return [makeEvent(ctx, "ITINERARY_CONFIRMED", hold.group_id, { hold_id: cmd.hold_id, source: cmd.source })];
}

export function decideReject(state, cmd, ctx) {
  const hold = mustHold(state, cmd.hold_id);
  return [
    makeEvent(ctx, "ITINERARY_REJECTED", hold.group_id, {
      hold_id: cmd.hold_id,
      source: cmd.source,
      reason: cmd.reason ?? "rejected",
    }),
  ];
}

export function decideCheckin(state, cmd, ctx) {
  return [
    makeEvent(ctx, "CHECKIN_RECORDED", cmd.group_id, {
      group_id: cmd.group_id,
      segment_id: cmd.segment_id,
      station_id: cmd.station_id,
      source: cmd.source,
    }),
  ];
}

export function decideEvidence(state, cmd, ctx) {
  return [
    makeEvent(ctx, "EVIDENCE_RECORDED", cmd.group_id, {
      group_id: cmd.group_id,
      segment_id: cmd.segment_id,
      evidence: cmd.evidence,
    }),
  ];
}

// 改道：仅重排未开始的环节；替代方案不得降低强制安全条件。
export function decideReplan(state, cmd, ctx) {
  const group = getGroup(state, cmd.group_id);
  // 先整体校验，避免半截改道
  for (const r of cmd.replacements) {
    const seg = mustSegment(state, cmd.group_id, r.replaces_segment_id);
    if (!REPLANNABLE.has(seg.status)) {
      throw new DomainRejection("segment_locked", { segment_id: r.replaces_segment_id, status: seg.status });
    }
    const station = getStation(state, r.station_id);
    if (station.status !== "open") {
      throw new DomainRejection("station_closed", { station_id: r.station_id });
    }
    const problems = safetyProblems(group, station);
    if (problems.length > 0) {
      throw new DomainRejection("safety_would_degrade", { station_id: r.station_id, problems });
    }
    if (!mentorCoverageOk(station, r.slot)) {
      throw new DomainRejection("mentor_shift_missing", { station_id: r.station_id, slot: r.slot });
    }
  }
  const work = structuredClone(state);
  const workGroup = work.groups.get(group.id);
  const base = work.itineraries.get(group.id)?.size ?? 0;
  const events = [];
  const replacedIds = [];
  const newSegments = [];
  const affected = [{ group_id: group.id, effect: "rerouted", cause: cmd.cause.type }];
  cmd.replacements.forEach((r, index) => {
    const seg = mustSegment(work, group.id, r.replaces_segment_id);
    const hold = seg.hold_id ? work.holds.get(seg.hold_id) : null;
    if (hold && ACTIVE_HOLD.has(hold.status)) {
      const release = makeEvent(ctx, "HOLD_RELEASED", group.id, { hold_id: hold.id, reason: "replanned" });
      applyEvent(work, release);
      events.push(release);
      // 释放的容量可能让候补者受益，记录受影响方
      for (const entry of publicQueue(work, hold.station_id, hold.slot)) {
        if (entry.group_id !== group.id && !affected.some((a) => a.group_id === entry.group_id)) {
          affected.push({ group_id: entry.group_id, effect: "capacity_freed", station_id: hold.station_id });
        }
      }
    }
    replacedIds.push(r.replaces_segment_id);
    const segmentId = `${group.id}-seg-${base + index + 1}`;
    const stop = { station_id: r.station_id, slot: r.slot, quantity: r.quantity ?? seg.quantity };
    const event = holdOrDefer(work, workGroup, stop, segmentId, ctx);
    applyEvent(work, event);
    events.push(event);
    newSegments.push({
      segment_id: segmentId,
      station_id: r.station_id,
      slot: r.slot,
      status: event.kind === "ITINERARY_HELD" ? "held" : "waiting",
    });
  });
  const replanned = makeEvent(ctx, "ROUTE_REPLANNED", group.id, {
    group_id: group.id,
    cause: cmd.cause,
    replaced_segment_ids: replacedIds,
    new_segments: newSegments,
    affected,
  });
  applyEvent(work, replanned);
  events.push(replanned);
  return events;
}

// 可控时钟：只释放到期仍未确认的占位；确认过的占用不受影响。
export function decideTick(state, ctx) {
  const events = [];
  for (const hold of state.holds.values()) {
    if (hold.status === "held" && Date.parse(hold.expires_at) <= ctx.now) {
      events.push(makeEvent(ctx, "HOLD_RELEASED", hold.group_id, { hold_id: hold.id, reason: "hold_expired" }));
    }
  }
  return events;
}

// 容量释放或增加后，按公开顺序晋升候补（队首阻塞则不跳过，保证顺序可解释）。
export function decidePromotions(state, ctx) {
  const work = structuredClone(state);
  const events = [];
  for (const key of [...work.waitlists.keys()]) {
    for (;;) {
      const entries = work.waitlists.get(key) ?? [];
      if (entries.length === 0) break;
      const head = publicQueue(work, entries[0].station_id, entries[0].slot)[0];
      if (!head) break;
      const group = work.groups.get(head.group_id);
      const station = work.stations.get(head.station_id);
      const seg = work.itineraries.get(head.group_id)?.get(head.segment_id);
      if (!group || !station || !seg || seg.status !== "waiting" || station.status !== "open") break;
      if (safetyProblems(group, station).length > 0) break;
      if (!mentorCoverageOk(station, head.slot)) break;
      const quantity = seg.quantity ?? group.members?.total ?? 1;
      if (availableCapacity(work, head.station_id, head.slot) < quantity) break;
      const event = makeEvent(ctx, "ITINERARY_HELD", head.group_id, {
        hold_id: `hold-${head.segment_id}`,
        group_id: head.group_id,
        segment_id: head.segment_id,
        station_id: head.station_id,
        slot: head.slot,
        quantity,
        expires_at: iso(ctx.now + ctx.holdTtlMs),
      });
      applyEvent(work, event);
      events.push(event);
    }
  }
  return events;
}

// 参观结束以实际到访核销，输出计划与实绩差异。
export function decideReconcile(state, cmd, ctx) {
  getGroup(state, cmd.group_id);
  const segments = [...(state.itineraries.get(cmd.group_id)?.values() ?? [])];
  const planned = segments
    .filter((s) => s.status !== "replanned")
    .map((s) => ({ segment_id: s.segment_id, station_id: s.station_id, slot: s.slot, status: s.status }));
  const plannedIds = new Set(planned.map((s) => s.segment_id));
  const actualIds = new Set(cmd.actual.map((a) => a.segment_id).filter(Boolean));
  const differences = [];
  for (const segment of planned) {
    if (!actualIds.has(segment.segment_id)) {
      differences.push({ type: "missed", planned: segment });
    } else if (segment.status !== "completed") {
      differences.push({ type: "attended_without_evidence", planned: segment });
    }
  }
  for (const visit of cmd.actual) {
    if (!visit.segment_id || !plannedIds.has(visit.segment_id)) {
      differences.push({ type: "unplanned_visit", actual: visit });
    }
  }
  return [
    makeEvent(ctx, "VISIT_RECONCILED", cmd.group_id, {
      group_id: cmd.group_id,
      planned,
      actual: cmd.actual,
      differences,
    }),
  ];
}

// ---------- 服务装配 ----------

export function createService({ now = 0, holdTtlMs = 15 * 60 * 1000, idPrefix = "evt" } = {}) {
  const state = createState();
  const log = []; // 已合并事件，可用于重启重放
  let clock = now;
  let sequence = 0;
  const nextId = () => `${idPrefix}-${String(++sequence).padStart(4, "0")}`;
  const ctx = () => ({ now: clock, holdTtlMs, nextId });
  const ingestAndLog = (event) => {
    const result = ingest(state, event);
    if (result.applied) log.push(event);
    return result;
  };
  const emit = (events) =>
    events.map((event) => {
      ingestAndLog(event);
      return event;
    });
  const settle = () => emit(decidePromotions(state, ctx()));
  return {
    state,
    log,
    now: () => clock,
    ingest: ingestAndLog, // 离线设备事件的合并入口
    requestGroup: (cmd) => emit(decideRequest(state, cmd, ctx())),
    publishStation: (cmd) => [...emit(decidePublishStation(state, cmd, ctx())), ...settle()],
    plan: (cmd) => emit(decidePlan(state, cmd, ctx())),
    confirm: (cmd) => emit(decideConfirm(state, cmd, ctx())),
    reject: (cmd) => [...emit(decideReject(state, cmd, ctx())), ...settle()],
    checkin: (cmd) => emit(decideCheckin(state, cmd, ctx())),
    recordEvidence: (cmd) => emit(decideEvidence(state, cmd, ctx())),
    replan: (cmd) => [...emit(decideReplan(state, cmd, ctx())), ...settle()],
    advanceTo: (ms) => {
      clock = ms;
      return [...emit(decideTick(state, ctx())), ...settle()];
    },
    reconcile: (cmd) => emit(decideReconcile(state, cmd, ctx())),
  };
}

// 服务重启：从事件日志重建状态，候补仍按事件中的原截止时间推进。
export function restoreService(events, { now = 0, holdTtlMs, idPrefix = "evt-r" } = {}) {
  const service = createService({ now, ...(holdTtlMs != null ? { holdTtlMs } : {}), idPrefix });
  for (const event of events) service.ingest(event);
  return service;
}
