// skill_museum_learning 领域资料的基础结构。
//
// 事件信封固定为 REQUIRED_FIELDS；每种事件（kind）的 payload 最小字段见 PAYLOAD_FIELDS。
// 这里只做结构核对，不做业务判断；编排规则见 src/coordination.js。

export const EVENT_KINDS = Object.freeze([
  "GROUP_REQUESTED", // 团队申请：学习目标、时间窗、成员结构、必要支持
  "STATION_CAPACITY_SET", // 站点公告：带版本的容量、先修条件、设备、导师班次与安全条件
  "ITINERARY_HELD", // 行程占位：有期限的资源占用
  "ITINERARY_CONFIRMED", // 占位确认（可来自离线设备，按来源序列合并）
  "ITINERARY_REJECTED", // 占位拒绝（可来自离线设备）
  "CHECKIN_RECORDED", // 现场签到（可来自离线设备）
  "HOLD_RELEASED", // 占用释放：过期、拒绝或改道
  "GROUP_DEFERRED", // 竞争失败：公开排队位置与被推迟原因
  "ROUTE_REPLANNED", // 改道：仅重排未开始的环节，记录原因与受影响方
  "EVIDENCE_RECORDED", // 学习证据：完成过的环节沉淀为目标达成记录
  "VISIT_RECONCILED", // 参观核销：计划与实绩差异
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export const PAYLOAD_FIELDS = Object.freeze({
  GROUP_REQUESTED: ["objectives", "time_window", "members", "support_needs"],
  STATION_CAPACITY_SET: ["version", "status", "capacity", "prerequisites", "equipment", "mentor_shifts", "safety"],
  ITINERARY_HELD: ["hold_id", "group_id", "segment_id", "station_id", "slot", "quantity", "expires_at"],
  ITINERARY_CONFIRMED: ["hold_id", "source"],
  ITINERARY_REJECTED: ["hold_id", "source", "reason"],
  CHECKIN_RECORDED: ["group_id", "segment_id", "station_id", "source"],
  HOLD_RELEASED: ["hold_id", "reason"],
  GROUP_DEFERRED: ["group_id", "segment_id", "station_id", "slot", "quantity", "reason", "queue_position"],
  ROUTE_REPLANNED: ["group_id", "cause", "replaced_segment_ids", "new_segments", "affected"],
  EVIDENCE_RECORDED: ["group_id", "segment_id", "evidence"],
  VISIT_RECONCILED: ["group_id", "planned", "actual", "differences"],
});

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) {
    problems.push("kind");
    return problems;
  }
  const payload = record.payload ?? {};
  for (const name of PAYLOAD_FIELDS[record.kind] ?? []) {
    if (!(name in payload)) problems.push(`payload.${name}`);
  }
  return problems;
}
