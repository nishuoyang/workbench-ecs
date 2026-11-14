# 迁移记录

## 概要

| 项 | 迁移前 | 迁移后 |
|---|---|---|
| 项目根目录 | `E:\AiProject\插件\workbuddy-ecs-mcp` | `E:\AiProject\workbench-ecs` |
| 入口文件 | `<root>\server.mjs` | `<root>\src\server.mjs` |
| 配置文件 | 无（路径硬编码在 `~/.workbuddy/mcp.json`） | `config/mcp.example.json` + `package.json` |
| 依赖声明 | 无 | `package.json`（零运行时依赖，`engines.node >= 18`） |
| 验证手段 | 手工 printf 管道 | `npm test` → `scripts/smoke.mjs` |

迁移日期: 2026-11-14

## 变更清单

1. `server.mjs` → `src/server.mjs`，迁移当时内容逐字节未改动（迁移前后 sha256 一致:
   `7efe7c457f1a04506c40d2737f2a7f0cac380fae39bcded0fd6772e50af2d18d`）。
   代码内只引用 Node 内置模块（`child_process` / `crypto` / `fs` / `os` / `path` / `readline`），
   不读取任何相对路径文件，因此移动位置不影响运行逻辑。
   （该文件随后因连接器改名修改了 `SERVER_NAME` 与头注释，现行哈希见下文"连接器改名"节。）
2. 新增 `package.json`：声明 `type: module`、`main`/`bin` 指向 `src/server.mjs`、
   `engines.node >= 18`、`scripts.start` / `scripts.test`，显式空 `dependencies`。
3. 新增 `config/mcp.example.json`：连接器注册片段，`args` 已指向新入口路径。
4. 新增 `scripts/smoke.mjs`：替代原先的 printf 手工测试，跨平台校验 initialize + tools/list。
5. 新增 `.gitignore`、本文件；`README.md` 全部路径与目录结构按新位置重写。
6. `~/.workbuddy/mcp.json` 中 `workbench-ecs` 的 `args` 由旧路径改为
   `E:\AiProject\workbench-ecs\src\server.mjs`（其余字段不变）。
7. 旧目录 `E:\AiProject\插件\workbuddy-ecs-mcp` 已移除，不再作为有效来源。

## 连接器改名（2026-11-14，迁移同日）

连接器 ID 与文件夹名原本不一致：文件夹是 `workbench-ecs`，而 `mcp.json` 里的键名沿用历史名
`workbuddy-ecs`。连接器显示名、工具命名空间（`mcp__<id>__<tool>`）都取自这个键名，
与代码位置无关，因此改名需要三处同步：

| 位置 | 改动 |
|---|---|
| `~/.workbuddy/mcp.json` | `mcpServers` 键名 `workbuddy-ecs` → `workbench-ecs` |
| `src/server.mjs` | `SERVER_NAME` 常量 → `'workbench-ecs'`（initialize 自报名与 stderr 日志） |
| 项目文件 | `package.json` 的 `name`/`bin`、`config/mcp.example.json` 键名、README |

影响：

- 工具命名空间由 `mcp__workbuddy-ecs__*` 变为 `mcp__workbench-ecs__*`，引用旧名的地方需同步。
- `mcp-approvals.json` 里的批准记录按「配置哈希 + 服务器名」存储，键名一变即失效，
  需要在连接器管理页重新 Trust 一次。
- 工具清单与行为不变（仍是 8 个 `ecs_*`）。

改名后 `src/server.mjs` 的 sha256: `bcc481794a0711a0f552e838ab7f770bd708ddfe965d24237c42f6a08f899993`
（迁移当时的值不再适用；改动为 `SERVER_NAME` 常量、文件头注释、工具示例中的实例 ID 三处，逻辑未动）。

## 未迁移项（有意保留原位）

- `C:\Users\ASUS\.dsh\node_modules\dsh-workbench-ecs`：第三方 dsh 插件的 npm 安装产物，
  属于 dsh 自身依赖，不是本项目的 MCP 代码，仅作为移植来源在文档中引用。
- `~/.workbench/config.json`：阿里云 Workbench CLI 凭据文件，由 CLI 自行管理，不应纳入仓库。

## 迁移后验证

```
$ npm test
[smoke] 服务器: workbench-ecs v1.0.0
[smoke] 协议版本: 2025-06-18
[smoke] 工具数量: 8 -> ecs_list, ecs_find, ecs_exec, ecs_log, ecs_upload, ecs_download, ecs_diagnose, ecs_session
[smoke] PASS
```

连接器侧实测（2026-11-14，经客户端 MCP 通道）：`ecs_list(cn-shanghai)` 返回 1 台 Running 实例
`i-bp1xxxxxxxxxxxxxxxxx`；`ecs_exec` 执行 `hostname && uptime` 得 `exit_code=0`（177ms）；
`rm -rf` 被破坏性守卫 fail-closed 拒绝。

## 回滚方式

把 `src/server.mjs` 放回 `E:\AiProject\插件\workbuddy-ecs-mcp\server.mjs`，
并将 `~/.workbuddy/mcp.json` 中 `args` 改回旧路径即可。代码本身无状态、无本地数据。
若要连连接器 ID 一起回到旧名，还需把 `mcpServers` 键名改回 `workbuddy-ecs`、
`SERVER_NAME` 改回 `'workbuddy-ecs'`，并重新 Trust。
