# Feishu Desktop Planner

把飞书多维表格的排期同步成共享日历，并在 Windows 桌面常驻一个待办面板。

- **排期 → 日历**：读取多维表格排期表，按字段映射创建/更新共享日历日程
- **待办面板**：桌面端展示当天待办，勾选即回写多维表格
- **双向同步**：轮询 + WebSocket 长连接，本地 SQLite 记录映射关系，避免重复建日程
- **凭据安全**：App Secret 仅用于首次授权，之后用户 token 加密存放在 `data/*.dpapi`

## 环境要求

- Node.js **>= 24.12**
- Windows（桌面端与 NSIS 打包）
- 一个飞书自建应用（多维表格读权限 + 日历写权限）

## 快速开始

```bash
git clone https://github.com/kari-leo/feishu-desktop-planner.git
cd feishu-desktop-planner
npm install

Copy-Item .env.example .env   # 然后填入真实值
npm run planner               # 跑一次同步
```

`.env` 里必填的 6 项：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_BASE_APP_TOKEN`、`FEISHU_SCHEDULE_TABLE_ID`、`FEISHU_TODO_TABLE_ID`、`FEISHU_CALENDAR_ID`。
其余可选变量（时区、轮询间隔、字段映射、OAuth 回调等）见 `.env.example` 的注释。

首次运行会走一次 OAuth 授权，回调地址默认 `http://127.0.0.1:8765/oauth/callback`，需与应用后台「重定向 URL」一致。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run planner` | 命令行执行一次同步 |
| `npm run desktop` | 构建并启动桌面端（Electron） |
| `npm test` | 运行单元测试（`node --test`） |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run build:desktop` | 只构建 `build/desktop/` 产物 |
| `npm run test:desktop` | 构建后跑桌面端自检脚本 |
| `npm run pack:win` | 打包 Windows 安装包（NSIS，输出到 `dist/`） |

## 目录结构

```
src/
  cli.mts            命令行入口（单次同步）
  config.mts         环境变量解析与校验
  feishu/            飞书 API、OAuth、WebSocket 事件
  sync/              同步引擎与调度
  storage/           SQLite 存储、流程锁、凭据保险箱
  desktop/           Electron 主进程、渲染进程与界面
doc/                 需求与验收手册
scripts/             构建与自检脚本
test/                单元测试
```

## 数据与隐私

以下内容不会进仓库（`.gitignore` 已覆盖）：`.env`、`data/`（SQLite 库与 `*.dpapi` 加密凭据）、`build/`、`dist/`、`node_modules/`、`*.log`。

## 许可

ISC © Windborne
