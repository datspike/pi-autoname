# extensions/

pi-autoname 的核心逻辑所在。

## 文件说明

| 文件 | 职责 |
|------|------|
| `index.ts` | Extension 入口：注册事件监听（`session_start`、`agent_end`）、`/autoname` 命令、模型调用、命名决策 |
| `lib.ts` | 纯工具函数：配置规范化、敏感信息脱敏、名称质量检查、对话提取、降级命名 |

## 关键导出

### index.ts（默认导出）

```typescript
export default function extension(pi: ExtensionAPI): void
```

注册以下能力：
- `session_start` 事件 — 恢复命名状态
- `agent_end` 事件 — 首次对话自动命名 + 周期性重命名
- `/autoname` 命令 — 手动触发 AI 命名

### lib.ts（命名导出）

- `normalizeConfig()` — 配置规范化
- `redactSensitiveText()` — 敏感信息脱敏
- `isHighQualityName()` — 名称质量检查
- `smartFallbackName()` — 降级命名生成
- `getFirstDialogue()` / `getRecentDialogue()` — 对话提取
- 类型：`AutonameConfig`

## 测试

```bash
npm test
```

测试文件位于 `../tests/pi-autoname.test.ts`，主要覆盖 `lib.ts` 的纯函数。
