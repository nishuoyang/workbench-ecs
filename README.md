# workbench-ecs

把 **dsh-workbench-ecs**（DeepSeek Harness 的阿里云 ECS 插件，v0.9.0）移植为 WorkBuddy 的 MCP 服务器。

- 本仓库路径: `E:\AiProject\workbench-ecs`（唯一有效来源）
- 移植来源: `C:\Users\ASUS\.dsh\node_modules\dsh-workbench-ecs`（github.com/nishuoyang/dsh-workbench-ecs）
- 运行方式: 零依赖 Node.js（≥18）MCP stdio 服务器，`src/server.mjs` 单文件
- 底层通道: 复用同一本机 **阿里云 Workbench CLI**（`~/.workbench/config.json` 凭据），实例经 Workbench 后端连接，**无需公网 IP / SSH 密钥**

## 目录结构

```
workbench-ecs/
├── src/
│   └── server.mjs          # MCP 服务器入口（唯一代码文件，零依赖）
├── scripts/
│   └── smoke.mjs           # 冒烟测试：initialize + tools/list 握手校验
├── config/
│   └── mcp.example.json    # 连接器配置片段（粘贴进 ~/.workbuddy/mcp.json）
├── docs/
│   └── MIGRATION.md        # 迁移记录（来源、变更、验证）
├── package.json            # 依赖声明（无运行时依赖）+ scripts
├── .gitignore
└── README.md
```

## 提供的工具（8 个）

| 工具 | 说明 |
|---|---|
| `ecs_list` | 列出指定地域的 ECS 实例 |
| `ecs_find` | 跨地域关键字检索（缺省扫全部 22 个公共地域） |
| `ecs_exec` | 远程执行命令/脚本（script 走 base64 直送零转义） |
| `ecs_log` | 按字节游标续读远端日志文件 |
| `ecs_upload` | 上传文件/目录（sha256 校验、瞬时失败重试、目录 tar 自动解包） |
| `ecs_download` | 下载远端文件到本机 |
| `ecs_diagnose` | 7 段预置只读体检（主机/负载/内存/磁盘/服务/进程/端口） |
| `ecs_session` | Workbench CLI 会话 list/close |

## 保留的原插件语义

- **破坏性命令守卫（fail-closed）**：`rm -rf`/`shutdown`/`dd`/`systemctl stop` 等默认拒绝，须显式 `allow_destructive: true`（会出现在 WorkBuddy 权限提示里）
- **read_only 护栏**：`read_only: true` 拒绝重定向/rm/docker 变更等 17 类写操作，并给出改写建议
- **远端超时结算**：`timed_out` 一律结算为 `exit_code=124`（不显示成"成功"）
- **上传 sha256 校验**：不一致即中止，坏包不落地
- **ANSI/进度帧清洗**、上传**仅瞬时网络失败**自动重试（指数退避）

## 未移植（后续可加）

`ecs_deploy` / `ecs_runbook` / `ecs_snapshot` 编排引擎、伪会话（cd/export 继承）、detach 长任务、批量实例、可视化设置面板（dsh 专属 UI）。

## 开发与运行

```bash
cd /e/AiProject/workbench-ecs

node src/server.mjs      # 前台直接起服务（stdio，通常由 WorkBuddy 拉起）
npm start                # 同上
npm test                 # 冒烟测试：握手 + 8 个工具清单校验
```

无需 `npm install`：运行时只用 Node 内置模块。`package.json` 中的 `engines.node >= 18` 是唯一的运行前提。

## 注册到 WorkBuddy

把 `config/mcp.example.json` 的片段合并进 `~/.workbuddy/mcp.json` 的 `mcpServers`：

```json
{
  "workbench-ecs": {
    "type": "stdio",
    "command": "node",
    "args": ["E:\\AiProject\\workbench-ecs\\src\\server.mjs"]
  }
}
```

然后在连接器管理页右上角"自定义连接器"里 **Trust** 该服务器。改动 `src/server.mjs` 后重启会话生效。

## 手动测试（协议层）

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node src/server.mjs
```

## 实测记录

- 2026-11-02（迁移前，旧路径）：`ecs_exec` 对 `i-bp1xxxxxxxxxxxxxxxxx`（示例生产机）执行 `hostname && uptime` → exit_code=0，118ms；破坏性守卫拒绝 `rm -rf`；read_only 拒绝 `echo hi > /tmp/f`。
- 2026-11-14（迁移后，本路径）：`npm test` 通过 —— `workbench-ecs v1.0.0`，协议 `2025-06-18`，8 个工具全部就位。
- 2026-11-14（改名后，经客户端 MCP 通道全量实测）：`ecs_list` 按 status 过滤正常；`ecs_find` 跨 22 地域检索（20 成功，ap-southeast-2 / ap-south-1 因本地 DNS 解析失败跳过并逐条报错）；`ecs_exec` 只读执行 83ms；`ecs_diagnose` 分段体检正常；`ecs_log` 读 400 字节并返回 `next_offset=400`；`ecs_upload` → `ecs_download` 往返 sha256 一致、内容无损；`ecs_session list` 无活动会话时返回 `null`。
