# 技能研学资源编排

本项目整理技能研学资源编排领域中的**事件名称、交换字段、协调规则与脱敏样例**，让业务、运营和研发在同一套术语下讨论实时行程协调服务。资料只包含领域约定与纯函数参考实现，不包含真实个人信息、生产连接或外部账号。

## 背景场景

周三上午两个学校团队同时抵达技能博物馆，原定的数控实训站临时停用：一个团队含轮椅成员，另一个即将错过返程大巴。运营侧不能整条路线作废，也不能临时超导师/设备容量塞人。领域约定要支持：

- 团队按学习目标、时间窗、成员结构、必要支持提交申请；
- 站点以**带版本**方式公布容量、先修条件、设备与导师班次；
- 确认行程先形成**有期限的资源占用**；
- 停站、迟到、成员变化**只重排未开始的环节**，完成的学习证据保留；
- 替代方案**不得降低强制安全条件**（含轮椅无障碍支持）；
- 多团队竞争同一资源时使用**公开排队顺序**，记录每个被推迟的原因，持续等待者通过老化积分逐步获得优先权；
- 离线设备传来的确认/拒绝/签到**按来源序列号合并**，旧消息不能把资源再次扣减；
- 过期占用由**可控时钟**释放；服务重启后仍按原截止时间推进候补；
- 参观结束以**实际到访**核销，协调员能看到计划/实绩差异与每次改道对谁产生了影响。

## 目录

- `src/events.js`：事件目录、设备/系统事件分类、推迟原因码、每类事件的 payload 契约与 `validateEvent`。
- `src/coordinator.js`：事件溯源协调引擎（纯函数参考实现，时间全部由参数传入，不读系统时钟）。
- `src/skill_museum_learning.js`：兼容入口，保留基线导出（`EVENT_KINDS` / `REQUIRED_FIELDS` / `validateEvent`）。
- `data/sample.json`：符合契约的虚构脱敏事件。
- `tests/contract.test.js`：样例与领域约定一致性。
- `tests/scenario_wednesday.test.js`：周三上午完整剧情（停用改道、候补、加开提升、离线合并、核销、重放）。
- `tests/invariants.test.js`：逐条锁定业务不变量。

## 事件目录

### 外部事件（来自申请方或离线设备）

| 事件 | 主体 | 关键 payload |
| --- | --- | --- |
| `GROUP_REQUESTED` | 团队 | `group_id`、`learning_objectives[]`、`time_window{start,end}`、`party{total,accessibility_needs[],compliance[]}` |
| `GROUP_UPDATED` | 团队 | `reason`（`late`/`members_changed`/`time_window_changed`）、`effective_at`、`changes` |
| `STATION_CAPACITY_SET` | 站点 | `version`、`effective_at`、`status`（`active`/`suspended`）、`slots[]`、`seats_per_slot`、`prerequisites[]`、`equipment[]`、`mentor_shifts[]`、`safety_requirements{mandatory[],provides[]}`、`objectives[]` |
| `ITINERARY_CONFIRMED` | 设备 | `hold_id` |
| `ITINERARY_REJECTED` | 设备 | `hold_id`、`reason` |
| `SEGMENT_CHECKED_IN` | 设备 | `group_id`、`segment_id`、`station_id`、`checked_in_at` |
| `LEARNING_EVIDENCE_RECORDED` | 设备 | `group_id`、`segment_id`、`evidence_id`、`objectives[]`、`completed_at` |

### 系统派生事件（由既有事件与时钟确定性推导）

| 事件 | 含义 |
| --- | --- |
| `ITINERARY_HELD` | 有期限占用；`expires_at` 是硬截止，`basis` 记录时钟、TTL 与所依据的站点版本 |
| `HOLD_EXPIRED` | 到点释放**未确认**占用；事件 id 固定为 `expired:<hold_id>`，重放幂等 |
| `WAITLIST_ENQUEUED` | 进入公开候补；含资源桶、入队序号、推迟原因码与说明、老化区间、排队规则 |
| `WAITLIST_PROMOTED` | 候补胜出形成新占用；记录胜出时的老化积分 |
| `WAITLIST_WITHDRAWN` | 站点停用 / 等待期间资格失效 / 改道成功而撤出 |
| `ROUTE_REPLANNED` | 改道汇总：触发原因、取消与保留的环节、替代环节、候补、不可满足项、受影响各方、安全核对、人话解释 |
| `VISIT_RECONCILED` | 核销：计划清单、实际到访与证据、逐项差异 |

所有事件顶层统一为 `event_id / kind / occurred_at / subject_id / payload`。设备事件额外要求 `source_id` 与从 1 起递增的 `source_seq`。

## 协调规则

### 1. 带版本的站点公布

`STATION_CAPACITY_SET` 以 `version` 单调公布；乱序或重传到达的旧版本不覆盖新版本。停用即发布 `status: "suspended"`，恢复/扩容/加导师班次则发布新版本（容量取 `seats_per_slot` 与班次共同决定的可接纳人数）。

### 2. 有期限占用

排程（`planRoute`）对每个学习目标产生三种结果之一：

1. **占用** `ITINERARY_HELD`：携带 `expires_at`（默认 10 分钟，可配）。
2. **候补** `WAITLIST_ENQUEUED`：没有能容纳整团的剩余席位时排队，并写明原因。
3. **不可满足**：仅返回 `unmet` 原因码，不产生任何资源承诺。

容量按**人数**累计（团队 `party.total`），剩余席位不足以容纳整团时不允许部分挤入；同一团队自身时段重叠的环节会被排除。

只有仍处于 `held` 的占用会被时钟过期；一旦设备 `CONFIRMED`，占用固化，迟到的 `HOLD_EXPIRED` 不再翻转状态。

### 3. 可控时钟与重启恢复

- 引擎不读系统时钟，所有时间通过 `tick(state, now, clockId)` 等参数传入。
- `tick` 先释放到期未确认占用（确定性 id `expired:<hold_id>`），再在空出的资源桶上提升候补。
- 服务重启时对持久化日志执行 `replay(events)`，再 `restore(events, now, clockId)`；截止时间全部来自日志中的 `expires_at`，内存定时器丢失不影响候补推进，且不会重复释放。

### 4. 公开候补顺序与推迟原因

排队规则（事件内显式记录为 `ranking_rule`）：

```
aging_points_desc : enqueue_seq_asc
```

- 老化积分 = 已等待分钟数 ÷ `aging_interval_minutes`（默认 5 分钟）向下取整；持续等待者积分自然增长。
- 积分相同按入队先后（`enqueue_seq`）。
- 队首整团塞不下剩余席位时**整桶暂停**，不越过队首提升后来者；扩容新版本发布后调用 `processWaitlist` 重算。
- 等待期间资格失效（成员变化、时间窗结束、新版本提高安全门槛、站点停用）会撤出候补并公开原因。

原因码见 `src/events.js` 的 `REASON_CODES`：`capacity_full`、`station_suspended`、`rerouted`、`no_safe_alternative`、`prerequisite_missing`、`outside_time_window`、`party_exceeds_capacity`、`hold_expired`、`rejected_by_lead`。

### 5. 改道：只动未开始环节，安全不降级

`replan(state, { trigger, ... }, now)` 支持 `station_suspended` / `late` / `members_changed` / `time_window_changed`：

- 仅取消 `held`/`confirmed` 的未开始环节；`checkedin`/`completed` 环节与学习证据在折叠层也有防御性保留。
- 取消释放的名额**先满足已在候补的团队**（公开老化顺序），受影响团队随后重新竞争。
- 替代环节逐站重新核对：时间窗、组内时段、先修条件、**强制安全项**、无障碍支持（如 `wheelchair → step_free_access`）、整团容量。
- 任何强制条件不满足时只记录 `unmet`/`safety_check.downgrade_allowed=false`，绝不安排到不达标站点。
- 汇总事件的 `affected_groups` 与协调员视图可回答"这次改道让谁失去了环节、谁获得了替代、谁被推迟、谁的诉求未满足"。

### 6. 离线设备消息合并

- 同一 `source_id` 严格按 `source_seq` 合并：序号 ≤ 已见最大序号的消息（含重传）整体丢弃，记入 `state.ignored[].reason = "stale_source_seq"`，**不产生任何容量扣减或状态翻转**。
- 重复 `event_id` 同样幂等丢弃（`duplicate_event_id`）。
- 占用过期/取消后才到达的签到不重新占用容量，到访事实进入 `unexpected_visits`，核销时可见。

### 7. 核销与差异视图

- `reconcile(groupId, now)` 以**实际到访**核销：完成环节按证据归档，改道（计划站 ≠ 实际站）、到访无证据、未到访（`no_show`）、过期、拒绝、取消逐项列入 `deviations`。
- `planVsActual(state, groupId)` 给出逐环节计划/实绩、状态史与证据链。
- `rerouteImpacts(state)` 给出每次改道的人话解释、受影响各方与安全核对结果。
- `queueView(state, now)` 给出各资源桶当前的公开排队顺序、老化积分与推迟原因。

## 参考 API（`src/coordinator.js`）

命令（返回新事件，不直接改状态）：`planRoute`、`replan`、`tick`/`restore`、`processWaitlist`、`reconcile`。
折叠与视图：`applyEvent`、`append`、`replay`、`queueView`、`planVsActual`、`rerouteImpacts`、`agingPoints`、`rankWaits`。

典型用法：

```js
import { replay, planRoute, append, replan, tick } from "./src/coordinator.js";

let state = replay(eventsFromStore);
const plan = planRoute(state, "team-a", "2026-09-23T09:05:00+08:00", { ttlMinutes: 10 });
state = append(state, plan.events);
// 持久化 plan.events …

const r = replan(state, { trigger: "station_suspended", station_id: "cnc-lab" }, "2026-09-23T09:21:00+08:00");
state = r.state;
```

## 本地核对

```bash
npm run build   # 语法检查全部源文件与测试
npm test        # 契约 + 周三场景 + 不变量（共 15 项）
```
