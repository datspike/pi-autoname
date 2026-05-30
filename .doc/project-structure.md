# pi-autoname 项目构成

## 发包入口

- `package.json`：npm 元信息、pi package manifest、发包白名单。
  - `pi.extensions` 指向 `./extensions`。
  - `files` 只包含 `extensions/`、`README.md`、`LICENSE`、`package.json`，因此 `.doc/` 不参与发包。
- `extensions/index.ts`：pi extension 主入口，负责自动命名、周期重命名、`/autoname` 命令。
- `README.md`：用户安装、配置、隐私说明。
- `LICENSE`：MIT License。

## 非发包/开发辅助内容

- `.doc/`：项目说明、审查与修复报告；不在 `package.json#files` 中，不会进入 npm tarball。
- `.diwu/`：本地任务状态，已被 `.gitignore` 忽略。
- `tests/`：当前为空目录。
- `add.js`、`add.py`、`calculator.py`、`fibonacci.py`、`hello.js`：当前被 `.gitignore` 忽略，不参与 npm 发包。
- `__pycache__/`：Python 缓存，已被 `.gitignore` 忽略。

## 核心运行流程

1. extension 加载时读取 `~/.pi/agent/pi-autoname.json`，不存在则创建默认配置。
2. `session_start`：根据已有 session name 和扩展持久化状态判断当前名称是扩展生成还是用户手动设置。
3. `agent_end`：
   - 未命名或上次仅 fallback 命名：在首轮完整对话后尝试命名。
   - 已由扩展 AI 命名：冷却时间到后用最近上下文周期重命名。
   - 检测为手动命名且 `respectManualName=true`：自动流程不覆盖。
4. `/autoname`：用户手动触发一次命名，可覆盖当前名称。

## 配置文件

默认路径：`~/.pi/agent/pi-autoname.json`

```json
{
  "enabled": true,
  "model": "",
  "fallbackModels": [],
  "cooldownMinutes": 10,
  "debug": false,
  "respectManualName": true
}
```
