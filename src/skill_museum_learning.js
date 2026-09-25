// 兼容入口：领域事件约定已拆分为 events.js（事件目录/字段契约）
// 与 coordinator.js（事件溯源协调引擎），此处保留原有导出名。
export { EVENT_KINDS, REQUIRED_FIELDS, validateEvent } from "./events.js";
