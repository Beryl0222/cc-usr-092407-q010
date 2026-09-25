// 技能研学资源编排：事件目录与字段契约。
//
// 事件分两类来源：
// - 外部/设备事件：团队申请、站点公布、离线设备传来的确认/拒绝/签到/证据。
// - 系统派生事件：占用过期、候补推进、改道、核销，均由绝对时间戳与既有事件确定性推导，
//   因此服务重启后重放可以得到相同结论（见 coordinator.js）。

export const EVENT_KINDS = Object.freeze([
  // 外部事件
  "GROUP_REQUESTED", // 团队提交申请：学习目标、时间窗、成员结构、必要支持
  "GROUP_UPDATED", // 迟到 / 成员变化 / 时间窗变化
  "STATION_CAPACITY_SET", // 站点带版本的容量公布（设备、导师班次、先修、安全条件）
  "ITINERARY_CONFIRMED", // 离线设备：导师确认占用
  "ITINERARY_REJECTED", // 离线设备：导师/团队拒绝占用
  "SEGMENT_CHECKED_IN", // 离线设备：签到
  "LEARNING_EVIDENCE_RECORDED", // 离线设备：完成环节的学习证据
  // 系统派生事件
  "ITINERARY_HELD", // 有期限的资源占用（占位）
  "HOLD_EXPIRED", // 可控时钟释放过期占用
  "WAITLIST_ENQUEUED", // 进入公开候补队列，记录被推迟原因
  "WAITLIST_PROMOTED", // 候补胜出，形成新占用
  "WAITLIST_WITHDRAWN", // 团队改道成功/离馆等，撤出候补
  "ROUTE_REPLANNED", // 仅重排未开始环节，记录受影响各方与安全核对
  "VISIT_RECONCILED", // 参观结束：按实际到访核销，计划与实绩对齐
]);

// 需要从离线设备合并的事件：必须在事件顶层携带 source_id / source_seq。
// 同一来源严格按 source_seq 递增合并，旧序号一律丢弃，不能再次扣减资源。
export const DEVICE_KINDS = Object.freeze([
  "ITINERARY_CONFIRMED",
  "ITINERARY_REJECTED",
  "SEGMENT_CHECKED_IN",
  "LEARNING_EVIDENCE_RECORDED",
]);

export const SYSTEM_KINDS = Object.freeze([
  "ITINERARY_HELD",
  "HOLD_EXPIRED",
  "WAITLIST_ENQUEUED",
  "WAITLIST_PROMOTED",
  "WAITLIST_WITHDRAWN",
  "ROUTE_REPLANNED",
  "VISIT_RECONCILED",
]);

// 候补推迟原因代码，对协调员与团队公开。
export const REASON_CODES = Object.freeze({
  CAPACITY_FULL: "capacity_full", // 站点名额已满（含导师班次容量）
  STATION_SUSPENDED: "station_suspended", // 站点临时停用
  NO_SAFE_ALTERNATIVE: "no_safe_alternative", // 仅剩降低安全条件的选项，不允许
  PREREQUISITE_MISSING: "prerequisite_missing", // 先修条件未满足
  OUTSIDE_TIME_WINDOW: "outside_time_window", // 时间窗内无可用班次
  PARTY_EXCEEDS_CAPACITY: "party_exceeds_capacity", // 成员规模超单站容量
  HOLD_EXPIRED: "hold_expired", // 占位逾期未确认
  REJECTED_BY_LEAD: "rejected_by_lead", // 导师/团队主动拒绝
  REROUTED: "rerouted", // 原站停用后改道竞争同一资源
});

// 公开排队规则：同一资源先按老化积分（每等待一个老化区间 +1）降序，
// 积分相同按入队先后（全局序号）升序。持续等待者随时间逐步获得优先权。
export const QUEUE_RANKING_RULE = "aging_points_desc:enqueue_seq_asc";
export const DEFAULT_AGING_INTERVAL_MINUTES = 5;

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

const PAYLOAD_REQUIRED = Object.freeze({
  GROUP_REQUESTED: ["group_id", "learning_objectives", "time_window", "party"],
  GROUP_UPDATED: ["group_id", "reason", "effective_at", "changes"],
  STATION_CAPACITY_SET: [
    "station_id",
    "version",
    "effective_at",
    "status",
    "slots",
    "prerequisites",
    "equipment",
    "mentor_shifts",
    "safety_requirements",
    "objectives",
    "seats_per_slot",
  ],
  ITINERARY_HELD: ["hold_id", "group_id", "created_at", "expires_at", "segments", "basis"],
  ITINERARY_CONFIRMED: ["hold_id"],
  ITINERARY_REJECTED: ["hold_id", "reason"],
  SEGMENT_CHECKED_IN: ["group_id", "segment_id", "station_id", "checked_in_at"],
  LEARNING_EVIDENCE_RECORDED: ["group_id", "segment_id", "evidence_id", "objectives", "completed_at"],
  HOLD_EXPIRED: ["hold_id", "expired_at", "clock_id"],
  WAITLIST_ENQUEUED: [
    "wait_id",
    "group_id",
    "resource",
    "objective_id",
    "enqueued_at",
    "reason_code",
    "reason_detail",
    "aging_interval_minutes",
    "ranking_rule",
  ],
  WAITLIST_PROMOTED: ["wait_id", "group_id", "resource", "promoted_at", "hold_id", "aging_points"],
  WAITLIST_WITHDRAWN: ["wait_id", "reason"],
  ROUTE_REPLANNED: [
    "replan_id",
    "trigger",
    "changed_at",
    "cancelled_segments",
    "retained_segments",
    "replacement_segments",
    "waitlisted",
    "affected_groups",
    "safety_check",
    "explanation",
  ],
  VISIT_RECONCILED: ["group_id", "finalized_at", "planned", "actual", "deviations", "evidence_ids"],
});

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// 返回问题字段/说明数组；为空数组表示通过。保持纯函数，便于在入库前与测试中复用。
export function validateEvent(record) {
  const problems = [];
  for (const name of REQUIRED_FIELDS) {
    if (!(name in record)) problems.push(`missing:${name}`);
  }
  if (problems.length > 0) return problems;

  if (!EVENT_KINDS.includes(record.kind)) {
    problems.push("kind:unknown");
    return problems;
  }
  if (!isObject(record.payload)) {
    problems.push("payload:object");
    return problems;
  }
  for (const name of PAYLOAD_REQUIRED[record.kind] ?? []) {
    if (!(name in record.payload)) problems.push(`${record.kind}.payload.missing:${name}`);
  }
  if (DEVICE_KINDS.includes(record.kind)) {
    if (typeof record.source_id !== "string" || record.source_id.length === 0) {
      problems.push(`${record.kind}.source_id`);
    }
    if (!Number.isInteger(record.source_seq) || record.source_seq < 1) {
      problems.push(`${record.kind}.source_seq`);
    }
  }
  if (Number.isNaN(Date.parse(record.occurred_at))) problems.push("occurred_at:iso");

  const p = record.payload;
  if (record.kind === "GROUP_REQUESTED") {
    if (!isObject(p.time_window) || Number.isNaN(Date.parse(p.time_window.start)) || Number.isNaN(Date.parse(p.time_window.end))) {
      problems.push("time_window:{start,end}");
    }
    if (!isObject(p.party) || !Number.isInteger(p.party.total) || p.party.total < 1) {
      problems.push("party.total");
    }
    if (!Array.isArray(p.learning_objectives) || p.learning_objectives.length === 0) {
      problems.push("learning_objectives[]");
    }
  }
  if (record.kind === "GROUP_UPDATED" && !["late", "members_changed", "time_window_changed"].includes(p.reason)) {
    problems.push("reason:late|members_changed|time_window_changed");
  }
  if (record.kind === "STATION_CAPACITY_SET") {
    if (!Number.isInteger(p.version) || p.version < 1) problems.push("version>=1");
    if (!["active", "suspended"].includes(p.status)) problems.push("status:active|suspended");
    if (!Array.isArray(p.slots) || p.slots.some((s) => !isObject(s) || Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end)))) {
      problems.push("slots[{start,end}]");
    }
    if (!Number.isInteger(p.seats_per_slot) || p.seats_per_slot < 1) problems.push("seats_per_slot>=1");
  }
  if (record.kind === "ITINERARY_HELD") {
    if (!Array.isArray(p.segments) || p.segments.length === 0) problems.push("segments[]");
    if (Number.isNaN(Date.parse(p.expires_at))) problems.push("expires_at:iso");
  }
  return problems;
}
