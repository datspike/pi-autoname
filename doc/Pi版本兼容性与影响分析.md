# Pi 版本兼容性与影响分析

> 记录上游 Pi 更新对本项目的直接影响和可改进点，供维护决策参考。

---

## 适用范围

本文档跟踪的 Pi 更新基线：**2026-06-09 发布版**

核心变更：
- Skill-wrapped prompts 间距修复（#5371）
- Compaction summarization prompt 措辞修复（#5401）
- Project trust / SDK 导出增强等

---

## 影响评估：🟢 低 — Skill Prompt 间距修复带来微小利好

### 变更详情

> Fixed skill-wrapped prompts to insert spacing between skill instructions and the user message (#5371).

### 与 autoname 的关系

pi-autoname 是一个 **extension**（通过 `pi.extensions[]` 注册），不是 skill。它的核心流程：

1. 监听 `agent_end` 事件
2. 收集会话消息
3. 调用 LLM 生成语义化名称
4. 通过 `pi.setSessionName()` 设置名称（读取用 `pi.getSessionName()`，会话分支用 `ctx.sessionManager.getBranch()`）

### 直接影响

| 维度 | 说明 |
|------|------|
| Extension 路径 | 🔵 **无直接影响** — autoname 是 extension，不走 skill wrapper |
| 间接利好 | ⚠️ **微小** — 如果用户通过某种 skill 包装方式触发命名（非标准用法），间距问题已解决 |

### 建议动作

**无需专门处理。** 本更新对 autoname 是纯正面（减少边缘情况的异常），不需要代码改动。

---

## 次要关联

| 变更项 | 影响 | 说明 |
|--------|------|------|
| Compaction prompt 措辞 | 🔵 无 | autoname 不参与 compaction |
| Project Trust | 🔵 无 | 全局 extension，不依赖项目本地资源 |
| SDK / RPC 类型导出 | 🔵 无 | autoname 不涉及 RPC / UI 类型 |
| Cache-hit CH | 📊 可观测 | autoname 的 LLM 调用在 `agent_end` 后执行，不计入主会话 CH |

---

## 版本记录

| 日期 | Pi 基线 | 变更 |
|------|---------|------|
| 2026-06-09 | 2026-06-09 发布版 | 初版创建；确认为低影响 |
