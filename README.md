# 技能研学资源编排

本项目整理技能研学资源编排领域的事件名称、交换字段与脱敏样例，并在 `src/coordination.js` 中提供可重放的行程协调领域服务，方便业务、运营和研发人员在同一套术语下讨论后续服务。资料只包含领域约定与虚构样例，不包含真实个人信息、生产连接或外部账号。

## 事件种类

| 事件 | 含义 | payload 最小字段 |
| --- | --- | --- |
| `GROUP_REQUESTED` | 团队申请：学习目标、时间窗、成员结构、必要支持 | `objectives, time_window, members, support_needs` |
| `STATION_CAPACITY_SET` | 站点公告：带版本的容量、先修条件、设备、导师班次、安全条件 | `version, status, capacity, prerequisites, equipment, mentor_shifts, safety` |
| `ITINERARY_HELD` | 行程占位：有期限的资源占用 | `hold_id, group_id, segment_id, station_id, slot, quantity, expires_at` |
| `ITINERARY_CONFIRMED` | 占位确认（可来自离线设备） | `hold_id, source` |
| `ITINERARY_REJECTED` | 占位拒绝（可来自离线设备） | `hold_id, source, reason` |
| `CHECKIN_RECORDED` | 现场签到（可来自离线设备） | `group_id, segment_id, station_id, source` |
| `HOLD_RELEASED` | 占用释放：过期、拒绝或改道 | `hold_id, reason` |
| `GROUP_DEFERRED` | 竞争失败：公开排队位置与被推迟原因 | `group_id, segment_id, station_id, slot, quantity, reason, queue_position` |
| `ROUTE_REPLANNED` | 改道：仅重排未开始的环节 | `group_id, cause, replaced_segment_ids, new_segments, affected` |
| `EVIDENCE_RECORDED` | 学习证据：完成环节沉淀为目标达成 | `group_id, segment_id, evidence` |
| `VISIT_RECONCILED` | 参观核销：计划与实绩差异 | `group_id, planned, actual, differences` |

## 协调规则

- **占位与期限**：确认行程先形成 `ITINERARY_HELD`（带 `expires_at`）；过期占用只能由可控时钟（`advanceTo`）以 `HOLD_RELEASED` 释放，确认过的占用不受影响。
- **强制安全条件**：轮椅通行、最大团队规模、随行导师数、先修条件、导师班次。改道的替代方案不得降低这些条件，否则决策被拒绝（`safety_would_degrade`）。
- **仅重排未开始环节**：已开始或已完成的环节不可改道（`segment_locked`），完成过的学习证据始终保留，并计入团队的 `completed_objectives` 用于先修判定。
- **竞争与候补**：容量不足或队列非空时发出 `GROUP_DEFERRED`，记录公开排队位置与原因；队列按（被推迟次数、入队时间、团队编号）排序，持续等待者逐步获得优先权；容量释放或增加后按公开顺序晋升候补，队首阻塞时不跳过。
- **离线合并**：确认、拒绝、签到携带 `source`（设备与序列号），按来源序列合并；重复或过期消息不会再次扣减资源；旧版本的站点公告不覆盖新版本。
- **重启与核销**：状态完全由事件重放得到（`restoreService`），候补仍按事件中的原截止时间推进；参观结束以实际到访核销（`VISIT_RECONCILED`）。协调员可查看计划与实绩差异（`planVsActual`）、推迟记录（`deferralLog`）、公开队列（`publicQueue`）与每次改道的影响（`replanImpacts`）。

## 目录

- `src/skill_museum_learning.js`：事件种类与最小字段校验。
- `src/coordination.js`：行程协调领域服务（决策、合并、查询）。
- `data/sample.json` / `data/sample_stream.json`：用于核对资料格式的虚构事件。
- `tests/`：保证样例与领域约定一致，并覆盖上述协调规则。

## 本地核对

```bash
npm run build
npm test
```
