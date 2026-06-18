# tests/

pi-autoname 的测试目录。

## 文件说明

| 文件 | 职责 |
|---|---|
| `pi-autoname.test.ts` | `extensions/lib.ts` 纯函数测试：配置、脱敏、名称质量、对话提取、marker 解析 |
| `extension-lifecycle.test.ts` | `extensions/index.ts` 事件流测试：`session_start`、`agent_end`、冷却时间、手工改名检测、session 文件诊断 |

## 运行

```bash
npm test
```
