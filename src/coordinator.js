// 技能研学行程协调引擎（纯函数、事件溯源）。
//
// 核心约定：
// - 状态只能由 applyEvent 折叠事件得到；命令（planRoute / replan / tick / reconcile）只产出新事件。
// - 时间一律由命令参数传入（可控时钟），引擎不读系统时钟；到期事件 id 由占用 id 确定性派生，
//   因此服务重启后重放日志、再按原截止时间推进候补，结论一致且幂等。
// - 离线设备事件携带 source_id/source_seq，同一来源严格按序号合并；旧序号、重复事件不产生任何扣减。
// - 改道只取消未开始环节；已签到/已完成环节与学习证据永久保留；替代方案必须满足全部强制安全条件。

import { randomUUID } from "node:crypto";
import { DEFAULT_AGING_INTERVAL_MINUTES, DEVICE_KINDS, QUEUE_RANKING_RULE, REASON_CODES, validateEvent } from "./events.js";

export const REASONS = REASON_CODES;
export const DEFAULT_CLOCK = "default";
export { QUEUE_RANKING_RULE, DEFAULT_AGING_INTERVAL_MINUTES };

// 成员无障碍需要 -> 站点必须提供的支持；替代站缺少对应支持即不可选（不得降低安全条件）。
export const ACCESSIBILITY_SUPPORT = Object.freeze({ wheelchair: "step_free_access" });

// 计入容量占用的环节状态。
const CAPACITY_HOLDING = new Set(["held", "confirmed", "checkedin", "completed"]);
// 尚未开始、允许被改道取消的环节状态。
const NOT_STARTED = new Set(["held", "confirmed"]);
// 占用仍可被设备确认/拒绝的状态。
const HOLD_OPEN = new Set(["held", "confirmed"]);

const t = (iso) => Date.parse(iso);

export class EventRejectedError extends Error {
  constructor(problems, event) {
    super(`事件被拒绝：${problems.join("、")}`);
    this.name = "EventRejectedError";
    this.problems = problems;
    this.event = event;
  }
}

// ---------------------------------------------------------------------------
// 状态与折叠
// ---------------------------------------------------------------------------

export function initialState() {
  return {
    groups: new Map(),
    stations: new Map(), // station_id -> { current, versions[] }
    holds: new Map(), // hold_id -> 占用（与环节一对一）
    segments: new Map(), // segment_id -> 环节（含历史链，跨改道保留）
    waits: new Map(), // wait_id -> 候补条目
    evidences: new Map(),
    sources: new Map(), // source_id -> 已合并最大 source_seq
    event_ids: new Set(),
    counters: { wait: 0 },
    impacts: [], // 每次改道的影响记录（协调员视图）
    ignored: [], // 被丢弃的旧消息/重复消息留痕
  };
}

// 应用单个事件。契约不合法抛 EventRejectedError；过期/重复/旧序号消息不改变状态，
// 仅记入 state.ignored，便于审计"旧消息没有再次扣减资源"。
export function applyEvent(state, event) {
  const problems = validateEvent(event);
  if (problems.length) throw new EventRejectedError(problems, event);

  if (state.event_ids.has(event.event_id)) {
    return ignore(state, event, "duplicate_event_id");
  }
  if (DEVICE_KINDS.includes(event.kind)) {
    const seen = state.sources.get(event.source_id) ?? 0;
    if (event.source_seq <= seen) {
      return ignore(state, event, "stale_source_seq", { source_id: event.source_id, source_seq: event.source_seq, last_seq: seen });
    }
  }

  const s = copy(state);
  if (DEVICE_KINDS.includes(event.kind)) s.sources.set(event.source_id, event.source_seq);
  FOLD[event.kind]?.(s, event);
  s.event_ids.add(event.event_id);
  return s;
}

// 顺序应用一批事件（便捷封装）。
export function append(state, events) {
  return events.reduce((st, e) => applyEvent(st, e), state);
}

// 重放日志恢复状态；再用 restore 按当前时钟补出到期事件（截止时间来自持久化的 expires_at）。
export function replay(events) {
  return append(initialState(), events);
}

export function restore(events, nowIso, clockId = DEFAULT_CLOCK) {
  return tick(replay(events), nowIso, clockId);
}

function ignore(state, event, reason, extra = {}) {
  const s = copy(state);
  s.ignored.push({ event_id: event.event_id, kind: event.kind, reason, ...extra });
  return s;
}

function copy(s) {
  return {
    ...s,
    groups: new Map(s.groups),
    stations: new Map(s.stations),
    holds: new Map(s.holds),
    segments: new Map(s.segments),
    waits: new Map(s.waits),
    evidences: new Map(s.evidences),
    sources: new Map(s.sources),
    event_ids: new Set(s.event_ids),
    counters: { ...s.counters },
    impacts: [...s.impacts],
    ignored: [...s.ignored],
  };
}

const FOLD = {
  GROUP_REQUESTED(s, e) {
    if (s.groups.has(e.payload.group_id)) {
      s.ignored.push({ event_id: e.event_id, reason: "group_already_exists" });
      return;
    }
    s.groups.set(e.payload.group_id, {
      group_id: e.payload.group_id,
      request: e.payload,
      updates: [],
      current_party: e.payload.party,
      current_window: e.payload.time_window,
      plan: [],
      unexpected_visits: [],
      finalized: null,
    });
  },

  GROUP_UPDATED(s, e) {
    const g = s.groups.get(e.payload.group_id);
    if (!g) {
      s.ignored.push({ event_id: e.event_id, reason: "unknown_group" });
      return;
    }
    g.updates.push(e.payload);
    if (e.payload.changes?.party) g.current_party = e.payload.changes.party;
    if (e.payload.changes?.time_window) g.current_window = e.payload.changes.time_window;
    if (e.payload.changes?.eta) g.eta = e.payload.changes.eta;
  },

  STATION_CAPACITY_SET(s, e) {
    const p = e.payload;
    const rec = s.stations.get(p.station_id) ?? { versions: [] };
    // 带版本公布：乱序/重传的旧版本不覆盖新版本。
    if (rec.current && p.version <= rec.current.version) {
      s.ignored.push({ event_id: e.event_id, reason: "stale_station_version", version: p.version });
      return;
    }
    rec.current = p;
    rec.versions.push(p);
    s.stations.set(p.station_id, rec);
  },

  ITINERARY_HELD(s, e) {
    const p = e.payload;
    if (s.holds.has(p.hold_id)) return;
    for (const seg of p.segments) {
      s.holds.set(p.hold_id, {
        hold_id: p.hold_id,
        group_id: p.group_id,
        segment_id: seg.segment_id,
        station_id: seg.station_id,
        slot: seg.slot,
        objective_id: seg.objective_id,
        status: "held",
        created_at: p.created_at,
        expires_at: p.expires_at,
        clock_id: p.basis?.clock_id ?? DEFAULT_CLOCK,
        promoted_from_wait: p.basis?.promoted_from_wait ?? null,
      });
      putSegment(s, {
        segment_id: seg.segment_id,
        group_id: p.group_id,
        station_id: seg.station_id,
        planned_station_id: seg.planned_station_id ?? seg.station_id,
        slot: seg.slot,
        objective_id: seg.objective_id,
        status: "held",
        hold_id: p.hold_id,
        predecessor_id: seg.predecessor_id ?? null,
        evidence_ids: [],
        history: [{ at: p.created_at, status: "held", via: "ITINERARY_HELD" }],
      });
    }
  },

  ITINERARY_CONFIRMED(s, e) {
    const h = s.holds.get(e.payload.hold_id);
    if (!h || !HOLD_OPEN.has(h.status)) {
      s.ignored.push({ event_id: e.event_id, reason: "hold_not_active", hold_id: e.payload.hold_id });
      return;
    }
    if (h.status === "held") {
      h.status = "confirmed";
      setSegment(s, h.segment_id, { status: "confirmed" }, { at: e.occurred_at, status: "confirmed", via: "ITINERARY_CONFIRMED" });
    }
  },

  ITINERARY_REJECTED(s, e) {
    const h = s.holds.get(e.payload.hold_id);
    if (!h || !HOLD_OPEN.has(h.status)) {
      s.ignored.push({ event_id: e.event_id, reason: "hold_not_active", hold_id: e.payload.hold_id });
      return;
    }
    h.status = "rejected";
    setSegment(s, h.segment_id, { status: "rejected" }, { at: e.occurred_at, status: "rejected", via: "ITINERARY_REJECTED", detail: e.payload.reason });
  },

  SEGMENT_CHECKED_IN(s, e) {
    const p = e.payload;
    const seg = s.segments.get(p.segment_id);
    if (!seg || seg.group_id !== p.group_id || !CAPACITY_HOLDING.has(seg.status)) {
      // 占用过期/取消后的迟到签到：记录到访事实用于核销，但绝不重新占用容量。
      s.ignored.push({ event_id: e.event_id, reason: "segment_not_active", segment_id: p.segment_id });
      const g = s.groups.get(p.group_id);
      if (g) g.unexpected_visits.push({ ...p, received_at: e.occurred_at });
      return;
    }
    seg.status = "checkedin";
    seg.actual = { station_id: p.station_id, checked_in_at: p.checked_in_at };
    const h = s.holds.get(seg.hold_id);
    if (h) h.status = "checkedin";
    seg.history.push({ at: p.checked_in_at, status: "checkedin", via: "SEGMENT_CHECKED_IN" });
  },

  LEARNING_EVIDENCE_RECORDED(s, e) {
    const p = e.payload;
    if (s.evidences.has(p.evidence_id)) return; // 证据幂等
    s.evidences.set(p.evidence_id, p);
    const seg = s.segments.get(p.segment_id);
    if (seg && seg.group_id === p.group_id) {
      seg.status = "completed";
      seg.evidence_ids.push(p.evidence_id);
      if (!seg.actual) seg.actual = { station_id: seg.station_id, checked_in_at: null };
      seg.history.push({ at: p.completed_at, status: "completed", via: "LEARNING_EVIDENCE_RECORDED", evidence_id: p.evidence_id });
    }
  },

  HOLD_EXPIRED(s, e) {
    // 幂等：event_id 去重已在外层保证；这里只处理仍处于未确认占位的占用。
    const h = s.holds.get(e.payload.hold_id);
    if (!h || h.status !== "held") return;
    h.status = "expired";
    setSegment(s, h.segment_id, { status: "expired" }, { at: e.payload.expired_at, status: "expired", via: "HOLD_EXPIRED" });
  },

  WAITLIST_ENQUEUED(s, e) {
    if (s.waits.has(e.payload.wait_id)) return;
    s.counters.wait += 1;
    const w = { ...e.payload, enqueue_seq: s.counters.wait, status: "active" };
    s.waits.set(w.wait_id, w);
  },

  WAITLIST_PROMOTED(s, e) {
    const w = s.waits.get(e.payload.wait_id);
    if (w) w.status = "promoted";
  },

  WAITLIST_WITHDRAWN(s, e) {
    const w = s.waits.get(e.payload.wait_id);
    if (w) {
      w.status = "withdrawn";
      w.withdraw_reason = e.payload.reason;
    }
  },

  ROUTE_REPLANNED(s, e) {
    const p = e.payload;
    for (const sid of p.cancelled_segments) {
      const seg = s.segments.get(sid);
      // 折叠层防御：已开始/完成的环节即使被错误列入也不会取消（证据保留）。
      if (seg && NOT_STARTED.has(seg.status)) {
        seg.status = "cancelled";
        const h = s.holds.get(seg.hold_id);
        if (h && HOLD_OPEN.has(h.status)) h.status = "cancelled";
        seg.history.push({ at: p.changed_at, status: "cancelled", via: "ROUTE_REPLANNED", trigger: p.trigger });
      }
    }
    s.impacts.push({
      replan_id: p.replan_id,
      trigger: p.trigger,
      changed_at: p.changed_at,
      affected_groups: p.affected_groups,
      explanation: p.explanation,
      safety_check: p.safety_check,
    });
  },

  VISIT_RECONCILED(s, e) {
    const g = s.groups.get(e.payload.group_id);
    if (g) g.finalized = e;
  },
};

function putSegment(s, seg) {
  s.segments.set(seg.segment_id, seg);
  const g = s.groups.get(seg.group_id);
  if (g && !g.plan.includes(seg.segment_id)) g.plan.push(seg.segment_id);
}

function setSegment(s, id, patch, history) {
  const seg = s.segments.get(id);
  if (!seg) return;
  Object.assign(seg, patch);
  if (history) seg.history.push(history);
}

// ---------------------------------------------------------------------------
// 站点版本与容量
// ---------------------------------------------------------------------------

export const bucketKey = (stationId, slotStart) => `${stationId}@${slotStart}`;

function stationAt(s, stationId, nowIso) {
  const rec = s.stations.get(stationId);
  if (!rec) return undefined;
  const now = t(nowIso);
  return rec.versions.filter((v) => t(v.effective_at) <= now).sort((a, b) => b.version - a.version)[0];
}

function usedSeats(s, stationId, slotStart) {
  let n = 0;
  for (const seg of s.segments.values()) {
    if (CAPACITY_HOLDING.has(seg.status) && seg.station_id === stationId && seg.slot.start === slotStart) {
      n += s.groups.get(seg.group_id)?.current_party.total ?? 0;
    }
  }
  return n;
}

// 同一团队自身已占环节与候选时段重叠时跳过（避免组内双重预定）。
function overlapsOwnPlan(s, g, slot) {
  for (const sid of g.plan) {
    const seg = s.segments.get(sid);
    if (seg && CAPACITY_HOLDING.has(seg.status) && t(seg.slot.start) < t(slot.end) && t(slot.start) < t(seg.slot.end)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 资格核对：先修、强制安全条件、无障碍支持、规模、时间窗
// ---------------------------------------------------------------------------

function completedObjectives(s, g) {
  const done = new Set(g.request.prerequisites_completed ?? []);
  for (const id of g.plan) {
    const seg = s.segments.get(id);
    if (seg?.status === "completed") done.add(seg.objective_id);
    for (const eid of seg.evidence_ids ?? []) {
      for (const o of s.evidences.get(eid)?.objectives ?? []) done.add(o);
    }
  }
  return done;
}

// 返回 null 表示合格；否则返回阻断原因。任何强制安全条件/无障碍支持不满足都不可安排。
function eligibility(s, g, station, slot, nowIso) {
  const party = g.current_party;
  const win = g.current_window;
  if (party.total > station.seats_per_slot) return { reason: REASONS.PARTY_EXCEEDS_CAPACITY, detail: `${party.total} > ${station.seats_per_slot}` };
  for (const pre of station.prerequisites ?? []) {
    if (!completedObjectives(s, g).has(pre)) return { reason: REASONS.PREREQUISITE_MISSING, detail: pre };
  }
  for (const req of station.safety_requirements?.mandatory ?? []) {
    if (!(party.compliance ?? []).includes(req)) return { reason: REASONS.NO_SAFE_ALTERNATIVE, detail: req };
  }
  for (const need of party.accessibility_needs ?? []) {
    const support = ACCESSIBILITY_SUPPORT[need] ?? need;
    if (!(station.safety_requirements?.provides ?? []).includes(support)) {
      return { reason: REASONS.NO_SAFE_ALTERNATIVE, detail: support };
    }
  }
  if (t(slot.start) < t(nowIso)) return { reason: REASONS.OUTSIDE_TIME_WINDOW, detail: "slot already started" };
  if (t(slot.start) < t(win.start) || t(slot.end) > t(win.end)) return { reason: REASONS.OUTSIDE_TIME_WINDOW, detail: "outside group window" };
  return null;
}

// 为一个学习目标选择：立即可占用 / 可候补 / 不可满足，全部附解释。
function chooseAssignment(s, g, objectiveId, nowIso, trigger) {
  const bookable = [];
  const full = [];
  let blocked = null;

  for (const stationId of s.stations.keys()) {
    const station = stationAt(s, stationId, nowIso);
    if (!station || !(station.objectives ?? []).includes(objectiveId)) continue;
    if (station.status === "suspended") {
      blocked ??= { reason: REASONS.STATION_SUSPENDED, detail: stationId };
      continue;
    }
    for (const slot of station.slots) {
      const problem = eligibility(s, g, station, slot, nowIso);
      if (problem) {
        if (problem.reason !== REASONS.OUTSIDE_TIME_WINDOW) blocked = { ...problem, station: stationId };
        continue;
      }
      if (overlapsOwnPlan(s, g, slot)) continue;
      const seats = usedSeats(s, stationId, slot.start);
      // 剩余席位必须能容纳整团，否则视为满员（进入候补而非超额占用）。
      const fits = seats + g.current_party.total <= station.seats_per_slot;
      const candidate = { kind: "slot", stationId, station, slot, seats };
      (fits ? bookable : full).push(candidate);
    }
  }

  const byStart = (a, b) => t(a.slot.start) - t(b.slot.start);
  if (bookable.length) {
    const c = bookable.sort(byStart)[0];
    return { kind: "hold", stationId: c.stationId, station: c.station, slot: c.slot };
  }
  if (full.length) {
    const c = full.sort(byStart)[0];
    const rerouted = trigger === "station_suspended";
    return {
      kind: "wait",
      stationId: c.stationId,
      slot: c.slot,
      reason_code: rerouted ? REASONS.REROUTED : REASONS.CAPACITY_FULL,
      reason_detail: `${rerouted ? "原站停用改道至 " : ""}${c.stationId} 班次已满（${c.seats}/${c.station.seats_per_slot}）`,
    };
  }
  return {
    kind: "unmet",
    reason_code: blocked?.reason ?? REASONS.OUTSIDE_TIME_WINDOW,
    reason_detail: blocked ? `${blocked.detail}（${blocked.station ?? ""}）` : "时间窗内无可用班次",
  };
}

// ---------------------------------------------------------------------------
// 事件构造（id 可注入，便于确定性测试与重放核对）
// ---------------------------------------------------------------------------

// 默认工厂用 UUID 保证跨命令全局唯一；确定性测试/重放核对可注入顺序号工厂。
function makeIdFactory() {
  return (prefix) => `${prefix}-${randomUUID()}`;
}

function buildHold(groupId, choice, objectiveId, nowIso, ctx, overrides = {}) {
  ctx.seq[groupId] = (ctx.seq[groupId] ?? 0) + 1;
  const holdId = overrides.holdId ?? ctx.ids("hold");
  const segmentId = overrides.segmentId ?? `${groupId}:seg${ctx.seq[groupId]}`;
  const ttlMinutes = overrides.ttlMinutes ?? ctx.ttlMinutes ?? 10;
  return {
    event_id: ctx.ids("evt"),
    kind: "ITINERARY_HELD",
    occurred_at: nowIso,
    subject_id: groupId,
    payload: {
      hold_id: holdId,
      group_id: groupId,
      created_at: nowIso,
      expires_at: new Date(t(nowIso) + ttlMinutes * 60000).toISOString(),
      segments: [
        {
          segment_id: segmentId,
          station_id: choice.stationId,
          slot: choice.slot,
          objective_id: objectiveId,
          predecessor_id: overrides.predecessorId ?? null,
          planned_station_id: overrides.plannedStationId ?? choice.stationId,
        },
      ],
      basis: { clock_id: ctx.clockId, ttl_minutes: ttlMinutes, station_version: choice.station.version, promoted_from_wait: overrides.promotedFromWait ?? null },
    },
  };
}

function buildWait(g, choice, objectiveId, nowIso, ctx, overrides = {}) {
  return {
    event_id: ctx.ids("evt"),
    kind: "WAITLIST_ENQUEUED",
    occurred_at: nowIso,
    subject_id: g.group_id,
    payload: {
      wait_id: overrides.waitId ?? ctx.ids("wait"),
      group_id: g.group_id,
      resource: bucketKey(choice.stationId, choice.slot.start),
      station_id: choice.stationId,
      slot: choice.slot,
      objective_id: objectiveId,
      enqueued_at: nowIso,
      reason_code: choice.reason_code,
      reason_detail: choice.reason_detail,
      aging_interval_minutes: ctx.agingMinutes ?? DEFAULT_AGING_INTERVAL_MINUTES,
      ranking_rule: QUEUE_RANKING_RULE,
      predecessor_segment_id: overrides.predecessorSegmentId ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// 命令：初次排程 —— 形成有期限占用 / 进入公开候补 / 记录不可满足原因
// ---------------------------------------------------------------------------

export function planRoute(state, groupId, nowIso, options = {}) {
  const g = state.groups.get(groupId);
  if (!g) throw new Error(`未知团队 ${groupId}`);
  const ctx = { ids: options.idFactory ?? makeIdFactory(), seq: {}, clockId: options.clockId ?? DEFAULT_CLOCK, ttlMinutes: options.ttlMinutes ?? 10, agingMinutes: options.agingMinutes };

  const events = [];
  const unmet = [];
  let work = state;
  for (const obj of g.request.learning_objectives) {
    const objectiveId = obj.id ?? obj;
    const choice = chooseAssignment(work, g, objectiveId, nowIso, null);
    if (choice.kind === "hold") {
      const ev = buildHold(groupId, choice, objectiveId, nowIso, ctx);
      events.push(ev);
      work = applyEvent(work, ev);
    } else if (choice.kind === "wait") {
      const ev = buildWait(g, choice, objectiveId, nowIso, ctx);
      events.push(ev);
      work = applyEvent(work, ev);
    } else {
      unmet.push({ objective_id: objectiveId, reason_code: choice.reason_code, reason_detail: choice.reason_detail });
    }
  }
  return { events, unmet };
}

// ---------------------------------------------------------------------------
// 可控时钟：到期释放 + 候补按公开顺序提升
// ---------------------------------------------------------------------------

export function agingPoints(w, nowIso) {
  const mins = (t(nowIso) - t(w.enqueued_at)) / 60000;
  return Math.max(0, Math.floor(mins / (w.aging_interval_minutes ?? DEFAULT_AGING_INTERVAL_MINUTES)));
}

// 公开排队顺序：老化积分降序（持续等待逐步获得优先权），同分按入队先后升序。
export function rankWaits(waits, nowIso) {
  return waits
    .filter((w) => w.status === "active")
    .map((w) => ({ w, points: agingPoints(w, nowIso) }))
    .sort((a, b) => b.points - a.points || a.w.enqueue_seq - b.w.enqueue_seq);
}

function allActiveBuckets(s) {
  const keys = new Set();
  for (const w of s.waits.values()) if (w.status === "active") keys.add(w.resource);
  return keys;
}

// 在指定资源桶上尽可能提升候补；资格/安全条件按当前站点版本与团队现状重新核对。
function promoteInPlace(s, nowIso, clockId, out, buckets, ctx) {
  for (const key of buckets) {
    let guard = 0;
    while (guard++ < 200) {
      const ranked = rankWaits([...s.waits.values()].filter((w) => w.resource === key), nowIso);
      if (!ranked.length) break;
      const { w, points } = ranked[0];
      const station = stationAt(s, w.station_id, nowIso);
      const g = s.groups.get(w.group_id);
      if (!station || !g || station.status === "suspended") break;
      const problem = eligibility(s, g, station, w.slot, nowIso);
      if (problem) {
        // 等待期间资格失效（成员变化/时间窗结束/新版本安全条件提高）：撤出并公开原因。
        out.push({
          event_id: ctx.ids("evt"),
          kind: "WAITLIST_WITHDRAWN",
          occurred_at: nowIso,
          subject_id: w.group_id,
          payload: { wait_id: w.wait_id, reason: problem.reason, detail: problem.detail },
        });
        const withdrawn = out[out.length - 1];
        const updated = applyEvent(s, withdrawn);
        Object.assign(s, updated);
        continue;
      }
      // 队首团队自身时段仍冲突时不能跳过它提升后面的人（公开顺序），整桶暂停。
      if (overlapsOwnPlan(s, g, w.slot)) break;
      const seats = usedSeats(s, w.station_id, w.slot.start);
      // 公开顺序：队首整团塞不下剩余席位时整桶暂停（不越过队首提升后来者），等待扩容版本。
      if (seats + g.current_party.total > station.seats_per_slot) break;

      const holdId = `hold:${w.wait_id}`;
      const segmentId = `${w.group_id}:seg:${w.wait_id}`;
      const held = buildHold(g.group_id, { stationId: w.station_id, station, slot: w.slot }, w.objective_id, nowIso, ctx, {
        holdId,
        segmentId,
        predecessorId: w.predecessor_segment_id ?? null,
        plannedStationId: w.predecessor_segment_id ? s.segments.get(w.predecessor_segment_id)?.planned_station_id : undefined,
        promotedFromWait: w.wait_id,
      });
      const promoted = {
        event_id: `promoted:${w.wait_id}`,
        kind: "WAITLIST_PROMOTED",
        occurred_at: nowIso,
        subject_id: w.group_id,
        payload: { wait_id: w.wait_id, group_id: w.group_id, resource: key, promoted_at: nowIso, hold_id: holdId, aging_points: points },
      };
      out.push(held, promoted);
      const updated = append(s, [held, promoted]);
      Object.assign(s, updated);
    }
  }
}

// 推进可控时钟：释放到期的未确认占用，空出的名额按公开顺序提升候补。
// HOLD_EXPIRED 用确定性 id（expired:<hold_id>），重启重放不会重复释放。
export function tick(state, nowIso, clockId = DEFAULT_CLOCK) {
  const events = [];
  for (const h of state.holds.values()) {
    if (h.status === "held" && t(h.expires_at) <= t(nowIso)) {
      events.push({
        event_id: `expired:${h.hold_id}`,
        kind: "HOLD_EXPIRED",
        occurred_at: h.expires_at,
        subject_id: h.group_id,
        payload: { hold_id: h.hold_id, expired_at: h.expires_at, clock_id: clockId },
      });
    }
  }
  let work = append(state, events);
  const freed = new Set(events.map((e) => {
    const h = state.holds.get(e.payload.hold_id);
    return h ? bucketKey(h.station_id, h.slot.start) : null;
  }).filter(Boolean));
  if (freed.size) {
    const ctx = { ids: makeIdFactory(), seq: {}, clockId, ttlMinutes: 10 };
    const more = [];
    promoteInPlace(work, nowIso, clockId, more, freed, ctx);
    work = append(work, more);
    events.push(...more);
  }
  return { state: work, events };
}

// 容量公布变更（新版本扩容/增加导师班次）后主动重算全部活跃候补桶。
export function processWaitlist(state, nowIso, options = {}) {
  const ctx = { ids: options.idFactory ?? makeIdFactory(), seq: {}, clockId: options.clockId ?? DEFAULT_CLOCK, ttlMinutes: options.ttlMinutes ?? 10, agingMinutes: options.agingMinutes };
  const events = [];
  promoteInPlace(state, nowIso, ctx.clockId, events, allActiveBuckets(state), ctx);
  return { state: append(state, events), events };
}

// 重放恢复时调用：重放历史后按当前时钟补出到期事件，截止时间仍取自持久化的 expires_at。
export function runDueTimers(state, nowIso, clockId = DEFAULT_CLOCK) {
  return tick(state, nowIso, clockId);
}

// ---------------------------------------------------------------------------
// 命令：改道（停站 / 迟到 / 成员变化 / 时间窗变化）
// ---------------------------------------------------------------------------

export function replan(state, input, nowIso, options = {}) {
  const ctx = { ids: options.idFactory ?? makeIdFactory(), seq: {}, clockId: options.clockId ?? DEFAULT_CLOCK, ttlMinutes: options.ttlMinutes ?? 10, agingMinutes: options.agingMinutes };
  const trigger = input.trigger;
  const events = [];
  const effects = new Map(); // group_id -> {lost,gained,waited,unmet}
  const effect = (gid) => {
    if (!effects.has(gid)) effects.set(gid, { lost: [], gained: [], waited: [], unmet: [] });
    return effects.get(gid);
  };

  // 1) 找出受影响的未开始环节与需要撤出的候补。
  let targets = [];
  if (trigger === "station_suspended") {
    for (const [gid, g] of state.groups) {
      const segs = g.plan.map((id) => state.segments.get(id)).filter((seg) => seg && NOT_STARTED.has(seg.status) && seg.station_id === input.station_id);
      if (segs.length) targets.push({ gid, segments: segs });
    }
    for (const w of state.waits.values()) {
      if (w.status === "active" && w.station_id === input.station_id) {
        events.push({
          event_id: ctx.ids("evt"),
          kind: "WAITLIST_WITHDRAWN",
          occurred_at: nowIso,
          subject_id: w.group_id,
          payload: { wait_id: w.wait_id, reason: REASONS.STATION_SUSPENDED, detail: `候补站点 ${input.station_id} 停用` },
        });
        effect(w.group_id).unmet.push({ objective_id: w.objective_id, reason_code: REASONS.STATION_SUSPENDED, reason_detail: "候补站点停用，参与重新竞争" });
      }
    }
  } else {
    const g = state.groups.get(input.group_id);
    if (!g) throw new Error(`未知团队 ${input.group_id}`);
    let segs = g.plan.map((id) => state.segments.get(id)).filter((seg) => seg && NOT_STARTED.has(seg.status));
    if (trigger === "late") segs = segs.filter((seg) => t(seg.slot.start) < t(input.eta));
    targets.push({ gid: input.group_id, segments: segs });
  }

  const cancelled = [];
  const retainedSet = new Set();
  const freed = new Set();
  for (const { gid, segments } of targets) {
    for (const seg of segments) {
      cancelled.push(seg.segment_id);
      freed.add(bucketKey(seg.station_id, seg.slot.start));
      effect(gid).lost.push({ segment_id: seg.segment_id, station_id: seg.station_id, slot: seg.slot, objective_id: seg.objective_id });
    }
    const g = state.groups.get(gid);
    for (const sid of g.plan) {
      const seg = state.segments.get(sid);
      if (seg && ["checkedin", "completed"].includes(seg.status)) retainedSet.add(sid);
    }
  }

  // 2) 先折叠候补撤出；未开始环节的取消在工作副本上就地执行（与 ROUTE_REPLANNED 折叠等价、
  //    且对重放幂等），这样汇总事件可以在 payload 全部填好后再入日志。
  const safetyCheck = [];
  const replacementRefs = [];
  const waitlistedRefs = [];
  const unmetRefs = [];
  const replanId = ctx.ids("replan");
  let work = append(state, events);
  cancelSegments(work, cancelled, nowIso, trigger);

  // 3) 释放出的名额先满足已在候补的团队（老化排名），改道团队随后竞争 —— 公开顺序。
  const promotions = [];
  if (freed.size) promoteInPlace(work, nowIso, ctx.clockId, promotions, freed, ctx);
  for (const e of promotions.filter((e) => e.kind === "WAITLIST_PROMOTED")) {
    effect(e.payload.group_id).gained.push({ wait_id: e.payload.wait_id, hold_id: e.payload.hold_id, aging_points: e.payload.aging_points, resource: e.payload.resource });
  }
  work = append(work, promotions);

  // 4) 受影响团队重新竞争替代环节；安全条件不满足时只记录 unmet，绝不降级安排。
  const newEvents = [];
  for (const { gid, segments } of targets) {
    const g = work.groups.get(gid);
    for (const lost of segments) {
      const rerouteNo = (lost.reroute_count ?? 0) + 1;
      const choice = chooseAssignment(work, g, lost.objective_id, nowIso, trigger);
      if (choice.kind === "hold") {
        const ev = buildHold(gid, choice, lost.objective_id, nowIso, ctx, {
          segmentId: `${lost.segment_id}#r${rerouteNo}`,
          predecessorId: lost.segment_id,
          plannedStationId: lost.planned_station_id ?? lost.station_id,
        });
        newEvents.push(ev);
        work = applyEvent(work, ev);
        const ref = ev.payload.segments[0];
        replacementRefs.push({ group_id: gid, ...ref, hold_id: ev.payload.hold_id });
        effect(gid).gained.push({ segment_id: ref.segment_id, station_id: choice.stationId, slot: choice.slot, hold_id: ev.payload.hold_id });
        safetyCheck.push({
          group_id: gid,
          replacement_station: choice.stationId,
          mandatory_satisfied: (choice.station.safety_requirements?.mandatory ?? []).every((r) => (g.current_party.compliance ?? []).includes(r)),
          accessibility_satisfied: (g.current_party.accessibility_needs ?? []).every((need) => (choice.station.safety_requirements?.provides ?? []).includes(ACCESSIBILITY_SUPPORT[need] ?? need)),
        });
      } else if (choice.kind === "wait") {
        const ev = buildWait(g, choice, lost.objective_id, nowIso, ctx, { predecessorSegmentId: lost.segment_id });
        newEvents.push(ev);
        work = applyEvent(work, ev);
        waitlistedRefs.push({ group_id: gid, wait_id: ev.payload.wait_id, resource: ev.payload.resource, reason_code: ev.payload.reason_code });
        effect(gid).waited.push({ wait_id: ev.payload.wait_id, reason_code: choice.reason_code, reason_detail: choice.reason_detail });
      } else {
        unmetRefs.push({ group_id: gid, objective_id: lost.objective_id, reason_code: choice.reason_code, reason_detail: choice.reason_detail });
        effect(gid).unmet.push({ objective_id: lost.objective_id, reason_code: choice.reason_code, reason_detail: choice.reason_detail });
        if (choice.reason_code === REASONS.NO_SAFE_ALTERNATIVE) {
          safetyCheck.push({ group_id: gid, objective_id: lost.objective_id, blocker: choice.reason_detail, downgrade_allowed: false });
        }
      }
    }
  }

  const affectedGroups = [...effects.entries()].map(([group_id, v]) => ({ group_id, ...v }));
  const explanation = buildExplanation(trigger, input, cancelled, replacementRefs, waitlistedRefs, unmetRefs, retainedSet);
  const summary = {
    event_id: replanId,
    kind: "ROUTE_REPLANNED",
    occurred_at: nowIso,
    subject_id: trigger === "station_suspended" ? input.station_id : input.group_id,
    payload: {
      replan_id: replanId,
      trigger,
      station_id: trigger === "station_suspended" ? input.station_id : undefined,
      group_id: trigger === "station_suspended" ? undefined : input.group_id,
      changed_at: nowIso,
      cancelled_segments: cancelled,
      retained_segments: [...retainedSet],
      replacement_segments: replacementRefs,
      waitlisted: waitlistedRefs,
      unmet: unmetRefs,
      affected_groups: affectedGroups,
      safety_check: safetyCheck,
      explanation,
    },
  };
  work = applyEvent(work, summary);
  return { state: work, events: [...events, summary, ...promotions, ...newEvents], affected: affectedGroups, unmet: unmetRefs, replan_id: replanId };
}

// 与 ROUTE_REPLANNED 折叠层取消逻辑等价的本地步骤：只取消未开始环节。
function cancelSegments(s, segmentIds, changedAt, trigger) {
  for (const sid of segmentIds) {
    const seg = s.segments.get(sid);
    if (seg && NOT_STARTED.has(seg.status)) {
      seg.status = "cancelled";
      const h = s.holds.get(seg.hold_id);
      if (h && HOLD_OPEN.has(h.status)) h.status = "cancelled";
      seg.history.push({ at: changedAt, status: "cancelled", via: "ROUTE_REPLANNED", trigger });
    }
  }
}

function buildExplanation(trigger, input, cancelled, replacements, waitlisted, unmet, retained) {
  const why = {
    station_suspended: `站点 ${input.station_id} 临时停用：取消 ${cancelled.length} 个未开始环节，保留 ${retained.size} 个已到访/完成环节及其证据`,
    late: `团队 ${input.group_id} 预计 ${input.eta} 到达：仅重排赶不上的 ${cancelled.length} 个未开始环节，已完成环节保留`,
    members_changed: `团队 ${input.group_id} 成员结构变化：重新核对 ${cancelled.length} 个未开始环节的容量与强制安全条件`,
    time_window_changed: `团队 ${input.group_id} 时间窗变化：仅重排 ${cancelled.length} 个未开始环节`,
  }[trigger];
  const lines = [why];
  if (replacements.length) lines.push(`形成 ${replacements.length} 个替代有期限占用，全部通过强制安全/无障碍核对`);
  if (waitlisted.length) lines.push(`${waitlisted.length} 个环节进入公开候补，推迟原因已记录`);
  if (unmet.length) lines.push(`${unmet.length} 个目标暂无可接受方案（不允许降低安全条件）`);
  return lines.join("；");
}

// ---------------------------------------------------------------------------
// 命令：核销 —— 以实际到访为准，计划与实绩对齐
// ---------------------------------------------------------------------------

export function reconcile(state, groupId, nowIso, options = {}) {
  const g = state.groups.get(groupId);
  if (!g) throw new Error(`未知团队 ${groupId}`);
  const ids = options.idFactory ?? makeIdFactory();
  const planned = [];
  const actual = [];
  const deviations = [];
  const evidenceIds = [];

  for (const sid of g.plan) {
    const seg = state.segments.get(sid);
    const plannedStation = seg.planned_station_id ?? seg.station_id;
    planned.push({ segment_id: sid, station_id: plannedStation, slot: seg.slot, objective_id: seg.objective_id, status: seg.status });
    if (seg.status === "completed") {
      actual.push({ segment_id: sid, station_id: seg.actual?.station_id ?? seg.station_id, checked_in_at: seg.actual?.checked_in_at ?? null, completed: true });
      for (const eid of seg.evidence_ids) {
        evidenceIds.push(eid);
        const ev = state.evidences.get(eid);
        actual.push({ evidence_id: eid, segment_id: sid, objectives: ev?.objectives ?? [], completed_at: ev?.completed_at });
      }
      if (plannedStation !== seg.station_id) deviations.push({ segment_id: sid, type: "rerouted", from: plannedStation, to: seg.station_id });
    } else if (seg.status === "checkedin") {
      actual.push({ segment_id: sid, station_id: seg.actual?.station_id ?? seg.station_id, checked_in_at: seg.actual?.checked_in_at, completed: false });
      deviations.push({ segment_id: sid, type: "visited_without_evidence", station_id: seg.station_id });
    } else if (seg.status === "cancelled") {
      deviations.push({ segment_id: sid, type: "cancelled", planned_station: plannedStation });
    } else if (seg.status === "expired") {
      deviations.push({ segment_id: sid, type: "hold_expired", station_id: seg.station_id });
    } else if (seg.status === "rejected") {
      deviations.push({ segment_id: sid, type: "rejected", station_id: seg.station_id });
    } else if (["held", "confirmed"].includes(seg.status)) {
      deviations.push({ segment_id: sid, type: "no_show", station_id: seg.station_id });
    }
  }
  for (const v of g.unexpected_visits) {
    actual.push({ station_id: v.station_id, checked_in_at: v.checked_in_at, note: "到访时无有效占用，未重新扣减容量" });
    deviations.push({ type: "unexpected_visit", segment_id: v.segment_id, station_id: v.station_id, checked_in_at: v.checked_in_at });
  }

  const event = {
    event_id: ids("reconcile"),
    kind: "VISIT_RECONCILED",
    occurred_at: nowIso,
    subject_id: groupId,
    payload: { group_id: groupId, finalized_at: nowIso, planned, actual, deviations, evidence_ids: [...new Set(evidenceIds)] },
  };
  return { event, state: applyEvent(state, event) };
}

// ---------------------------------------------------------------------------
// 协调员只读视图
// ---------------------------------------------------------------------------

// 公开候补队列：按资源桶分组，给出排队顺序、当前老化积分与推迟原因。
export function queueView(state, nowIso) {
  const buckets = new Map();
  for (const w of state.waits.values()) {
    if (!buckets.has(w.resource)) buckets.set(w.resource, []);
    buckets.get(w.resource).push(w);
  }
  return [...buckets].map(([resource, waits]) => ({
    resource,
    queue: rankWaits(waits, nowIso).map(({ w, points }) => ({
      wait_id: w.wait_id,
      group_id: w.group_id,
      objective_id: w.objective_id,
      enqueue_seq: w.enqueue_seq,
      enqueued_at: w.enqueued_at,
      aging_points: points,
      status: w.status,
      reason_code: w.reason_code,
      reason_detail: w.reason_detail,
    })),
  }));
}

// 计划与实绩差异（含环节完整状态史）。
export function planVsActual(state, groupId) {
  const g = state.groups.get(groupId);
  if (!g) throw new Error(`未知团队 ${groupId}`);
  return g.plan.map((sid) => {
    const seg = state.segments.get(sid);
    const plannedStation = seg.planned_station_id ?? seg.station_id;
    return {
      segment_id: sid,
      objective_id: seg.objective_id,
      planned: { station_id: plannedStation, slot: seg.slot },
      actual: seg.actual ?? null,
      status: seg.status,
      rerouted: plannedStation !== seg.station_id,
      evidence_ids: seg.evidence_ids ?? [],
      history: seg.history,
    };
  });
}

// 每次改道对谁产生了影响：谁失去原环节、谁获得替代/候补提升、谁被推迟、安全核对结果。
export function rerouteImpacts(state) {
  return state.impacts.map((i) => ({
    replan_id: i.replan_id,
    trigger: i.trigger,
    changed_at: i.changed_at,
    explanation: i.explanation,
    safety_check: i.safety_check,
    affected_groups: i.affected_groups,
  }));
}
