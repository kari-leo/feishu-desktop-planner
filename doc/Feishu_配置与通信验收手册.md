# 飞书端配置与通信验收手册

操作手册 \| 已选路线：企业自建应用 + 用户 OAuth + WebSocket 长连接

目标为完成飞书资源、权限、OAuth 长期授权和事件订阅配置，并使用已完成的本地程序进行授权验收。

## 01 准备多维表格与共享日历

已有 Base 文件与共享日历，直接复用；不重复创建。确认 Base 内包含两张独立数据表，并且自己拥有管理权限。

| **资源**               | **检查项**                                                                                 |
|------------------------|--------------------------------------------------------------------------------------------|
| 任务安排表（Schedule） | 任务名称、开始日期、截止日期、状态；按需增加进度、优先级、备注。建立日历视图、甘特图视图。 |
| 每日待办表（Todo）     | 事项名称、计划日期、完成状态；按需增加排序、优先级、备注。建立今日筛选视图。               |
| 共享日历               | 独立任务计划日历；本人为所有者或拥有编辑权限。不与普通日历混用。                           |

## 02 创建企业自建应用

进入 https://open.feishu.cn/app → 创建企业自建应用 → 命名 Desktop Planner；选择与 Base、日历相同的组织。

进入「凭证与基础信息」记录 App ID、App Secret。启用机器人仅在所用接口或文档应用授权确有要求时执行；不配置聊天能力。App Secret 禁止公开或提交代码仓库。

## 03 配置 API 权限并发布

| **权限/授权**                     | **身份**                         | **目的**                        |
|-----------------------------------|----------------------------------|---------------------------------|
| bitable:app                       | 应用；事件按后台要求补充用户权限 | Base 记录读写与事件权限         |
| docs:event:subscribe              | 应用；按接口要求补充             | 云文档资源订阅                  |
| calendar:calendar                 | 用户                             | 共享日历及日程读写、订阅        |
| offline_access                    | 用户                             | 获取刷新凭证 `refresh_token`    |
| contact:user.employee_id:readonly | 仅按需开通用户权限               | 只有接口确实要求 user_id 时需要 |

在「开发配置 → 权限管理 → 开通权限」的用户身份权限页签搜索并开通 `calendar:calendar` 和 `offline_access`。其余权限按 API 文档和事件详情核对身份与用途。[申请 API 权限](https://open.feishu.cn/document/ukTMukTMukTM/uQjN3QjL0YzN04CN2cDN?lang=zh-CN)

### 配置 OAuth 长期授权

1. 在同一自建应用的「开发配置 → 安全设置 → 重定向 URL」新增 `http://127.0.0.1:8765/oauth/callback`。如果本地设置了 `FEISHU_OAUTH_REDIRECT`，填写程序实际使用的地址，确保协议、主机、端口和路径完全一致。当前程序使用带端口的 `127.0.0.1` HTTP 地址。继续使用 API 调试台时，保留已有的 `https://open.feishu.cn/api-explorer/loading` 条目。[获取 user_access_token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3)
2. 在「安全设置」开启「刷新 `user_access_token`」开关。若页面未显示此开关，按飞书官方说明，该能力默认开启。[刷新 user_access_token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3)
3. 在「应用发布 → 版本管理与发布」创建版本并申请线上发布，确认可用范围包含实际用于授权的飞书账号，按企业规则完成管理员审批（如需）。发布后检查应用已生效，且 `calendar:calendar` 和 `offline_access` 均已开通。新增权限、修改刷新设置或新增事件后，发布相应的新版本。[发布与审核自建应用](https://open.feishu.cn/document/best-practices/intro-to-custom-app-review?lang=zh-CN)

## 04–05 资源授权与接口调试

### 04 配置资源访问权限

Base：打开文件 → 右上角「…」或协作者设置 → 添加文档应用 → 选择 Desktop Planner → 授予管理权限（事件订阅需要）；如有高级权限，检查两个表及字段均可访问。

共享日历：无需将机器人加入日历。打开[查询日历列表](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/calendar-v4/calendar/list)，点击「尝试一下」进入对应 API 调试台（[API 调试台首页](https://open.feishu.cn/api-explorer)）。API 调试台选择 user_access_token → 获取 Token → 使用创建日历的账号授权。若权限有新增，重新获取 Token。

### 05 获取资源 ID

| **配置参数**                      | **获取方式**                                                               |
|-----------------------------------|----------------------------------------------------------------------------|
| FEISHU_APP_ID / FEISHU_APP_SECRET | 应用凭证页；Secret 安全保存                                                |
| FEISHU_BASE_APP_TOKEN             | Base URL 中 /base/ 后的标识；若为 wiki URL，先通过[获取知识空间节点信息](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/get_node)查询节点 obj_token           |
| FEISHU_SCHEDULE_TABLE_ID          | 任务安排表 URL 的 table= 参数                                              |
| FEISHU_TODO_TABLE_ID              | 每日待办表 URL 的 table= 参数                                              |
| FEISHU_CALENDAR_ID                | GET /open-apis/calendar/v4/calendars；按名称找到共享日历，复制 calendar_id |

打开[查询日历列表](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/calendar-v4/calendar/list) → 「尝试一下」。核对请求为 `GET /open-apis/calendar/v4/calendars`，不要选查询主日历信息。使用 user_access_token；page_size 可设 50，page_token 和 sync_token 首次留空，不填 user_id。若有分页继续查询，直至 has_more=false。检查目标日历有编辑权限。

### 接口调试台：逐项验证读写

以下链接均指向对应的飞书官方接口文档，打开后点击「尝试一下」进入该接口的 API 调试台。也可在 [API 调试台首页](https://open.feishu.cn/api-explorer) 按页面名称搜索，并核对请求方法与路径。Base 使用 `tenant_access_token`，日历使用 `user_access_token`。

| 资源 | 接口页面名称（点击进入） | API 路径（统一前缀 `/open-apis`） |
|---|---|---|
| Base | [列出数据表](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table/list) | `GET /bitable/v1/apps/:app_token/tables` |
| Base | [列出字段](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-field/list) | `GET /bitable/v1/apps/:app_token/tables/:table_id/fields` |
| Base | [查询记录（检索记录）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-record/search) | `POST /bitable/v1/apps/:app_token/tables/:table_id/records/search` |
| Base | [新增记录](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create) | `POST /bitable/v1/apps/:app_token/tables/:table_id/records` |
| Base | [更新记录](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/update) | `PUT /bitable/v1/apps/:app_token/tables/:table_id/records/:record_id` |
| Base | [删除记录](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/delete) | `DELETE /bitable/v1/apps/:app_token/tables/:table_id/records/:record_id` |
| 日历 | [查询日历列表](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/calendar-v4/calendar/list) | `GET /calendar/v4/calendars` |
| 日历 | [获取日程列表](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/list) | `GET /calendar/v4/calendars/:calendar_id/events` |
| 日历 | [创建日程](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/create) | `POST /calendar/v4/calendars/:calendar_id/events` |
| 日历 | [更新日程](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/patch) | `PATCH /calendar/v4/calendars/:calendar_id/events/:event_id` |
| 日历 | [删除日程](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/delete) | `DELETE /calendar/v4/calendars/:calendar_id/events/:event_id` |

只操作测试记录或测试日程：新增 → 查询 → 修改 → 删除，检查客户端与 API 结果一致。字段名、日期值格式以真实字段及接口文档为准。

### OAuth 长期授权验收

1. 完成第 03 节并将应用凭证和本节资源 ID 填入本地配置。验收期间保持同一应用的后台同步进程关闭。在项目目录运行 `npm run planner -- authorize`。程序默认请求 `calendar:calendar offline_access`。若设置了 `FEISHU_OAUTH_SCOPES`，确认值中同时包含这两项，以空格分隔。
2. 在程序打开的系统浏览器中，使用同一组织下有权编辑目标共享日历的飞书账号登录，核对应用为 Desktop Planner，并同意日历访问和离线访问权限。浏览器回到本地地址后，确认终端显示「飞书授权已加密保存」，再运行 `npm run planner -- doctor`。期望 `ok` 为 `true`，且 `calendar.type` 为 `shared`、`calendar.role` 为 `writer` 或 `owner`。
3. 等本次 `user_access_token` 到期后，在 `refresh_token` 到期前再次运行 `npm run planner -- doctor`。若共享日历检查成功且无需浏览器授权，即可确认本地程序能在重启后自动刷新并继续访问日历。以飞书返回的 `expires_in` 和 `refresh_token_expires_in` 为准。每次刷新会换发新的 `refresh_token`，旧值立即失效，由程序保存新值。刷新凭证过期、被撤销，或距上次用户授权已满 365 天时，重新运行 `npm run planner -- authorize`。[刷新 user_access_token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3)

| 现象 | 飞书端检查 |
|---|---|
| 授权页报 `20029` | 核对当前 App ID 下登记的重定向 URL 与程序实际发送的 `redirect_uri`。[20029 排查指南](https://open.feishu.cn/document/faq/trouble-shooting/how-to-resolve-the-authorization-page-20029-error) |
| 授权或刷新报 `20010` | 检查应用是否发布，以及浏览器登录账号是否在应用可用范围内。 |
| 终端提示用户凭证不完整 | 检查 `offline_access` 已开通、程序请求中包含该 scope，且用户已同意。修正后重新授权。 |
| 刷新报 `20074` | 检查「安全设置」中的刷新开关，并确认对应版本已经发布。 |

验收记录仅保存时间、检查结果和错误码。API 调试台的接口结果用于第 05 节读写验证，长期授权以本地程序的首次授权和刷新结果为准。

## 06 建立本地 WebSocket 长连接

此处代码仅用于连通性及事件接收测试，不实现业务同步。Windows PowerShell 执行：

```powershell
mkdir feishu-desktop-planner
cd feishu-desktop-planner
npm init -y
npm install @larksuiteoapi/node-sdk dotenv
```

在目录内创建 .env（真实凭证自行填写）及 .gitignore：

```text
# .env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
# .gitignore 中分别写入 .env 和 node_modules/
```

创建 ws-test.cjs：

```javascript
require('dotenv').config();
const Lark = require('@larksuiteoapi/node-sdk');
const ws = new Lark.WSClient({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  loggerLevel: Lark.LoggerLevel.info,
});
const dispatcher = new Lark.EventDispatcher({}).register({
  'drive.file.bitable_record_changed_v1': async (data) => {
    console.log('BITABLE', JSON.stringify(data));
  },
  'calendar.calendar.event.changed_v4': async (data) => {
    console.log('CALENDAR', JSON.stringify(data));
  },
});
ws.start({ eventDispatcher: dispatcher });
```

运行 node ws-test.cjs，确认 SDK 报告连接成功。保持进程运行。然后到开发者后台「事件与回调 → 事件配置 → 订阅方式」，选择「使用长连接接收事件」并保存。

配置要点：长连接以应用凭证鉴权，主动出站访问飞书；不需要公网回调 URL。OAuth 本地重定向与事件接收相互独立。测试日志可能包含业务数据，仅在本机查看。

### 验收标准

□ SDK 建连成功 □ 后台长连接设置保存成功 □ 进程保持运行 □ 凭证未提交仓库

## 07–08 事件订阅与双向通信验收

### 07 配置应用级事件与资源级订阅

在「事件与回调 → 添加事件」选择多维表格记录变更（应用身份）和日程变更（用户身份）。字段变更可选。发布版本。若日程文档要求先建立资源订阅，先执行下表日程订阅再添加事件；以后台校验为准。

<table>
<colgroup>
<col style="width: 23%" />
<col style="width: 76%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>目标</strong></th>
<th><strong>事件标识 / 资源订阅</strong></th>
</tr>
</thead>
<tbody>
<tr class="odd">
<td>Base（同一 Base 只需订阅一次）</td>
<td>drive.file.bitable_record_changed_v1<br />
POST /open-apis/drive/v1/files/:file_token/subscribe?file_type=bitable<br />
使用 tenant_access_token；file_token 为 Base App Token。<br />
打开 <a href="https://open.feishu.cn/document/server-docs/docs/drive-v1/event/subscribe">订阅云文档事件</a> → 「尝试一下」。</td>
</tr>
<tr class="even">
<td>共享日历</td>
<td>calendar.calendar.event.changed_v4<br />
POST /open-apis/calendar/v4/calendars/:calendar_id/events/subscription<br />
使用 user_access_token；calendar_id 为目标共享日历。<br />
打开 <a href="https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/subscription">订阅日程变更事件</a> → 「尝试一下」。</td>
</tr>
</tbody>
</table>

订阅接口返回 code=0 后，检查应用事件已生效。若应用身份无法订阅 Base，先检查应用管理权限及事件要求；必要时改用用户身份订阅并补齐 OAuth scope。若某事件不支持长连接，在开发阶段采用轮询兜底。

### 08 验证双向通信（不要求自动同步）

| **测试操作**          | **预期结果**                                                                 |
|-----------------------|------------------------------------------------------------------------------|
| API → Base / Calendar | 使用 [05 接口调试台：逐项验证读写](#接口调试台逐项验证读写) 中各接口，对测试记录和测试日程完成新增、读取、修改、删除，飞书客户端一致。             |
| 客户端 → Base 事件    | 两张表分别新增、编辑、删除；终端收到记录变更，能够区分 table_id、record_id。 |
| 客户端 → 日程事件     | 共享日历新增、修改、删除；终端收到日程变更，可据 calendar_id 再查询日程。    |
| 重启连接              | 关闭并重启测试进程，确认仍能接收新事件。                                     |

验收记录：保存 API 成功响应、事件类型与测试时间（脱敏）。[99991679 排查指南](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-resolve-error-99991679)：核对缺失 scope、重新授权；99992360：检查接口及 ID 类型，勿提交 ou_xxx 示例值，参考[如何获取 User ID](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-obtain-user-id)。

## 官方参考与待验证事项

API 调试台：[首页](https://open.feishu.cn/api-explorer) · [API 调试台使用指南](https://open.feishu.cn/document/tools-and-sdks/api-explorer-guide)

日历同步：https://open.feishu.cn/document/calendar-event-sync/calendar-sync

日程订阅：https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/subscription

云文档订阅：https://open.feishu.cn/document/server-docs/docs/drive-v1/event/subscribe

Node SDK：https://github.com/larksuite/node-sdk

## 09 运行 M1 同步服务

使用 Windows 和 Node.js 24.12 或更新版本。在项目目录执行：

```powershell
npm ci
npm test
npm run typecheck
```

沿用上文的资源配置。首次使用可在系统浏览器中授权，也可导入本应用的首次 OAuth 回调 JSON。

```powershell
npm run planner -- authorize
# 已有首次回调时，改用下面的导入命令
npm run planner -- import-token "data/首次回调.json"
```

导入会保留原始授权时间和有效期。App Secret 及 OAuth 凭证保存在 Windows 当前用户的 DPAPI 加密文件中。源 JSON 仍包含敏感凭证。程序会在需要时自动刷新，凭证失效后可再次执行 `authorize`。默认回调地址为 `http://127.0.0.1:8765/oauth/callback`，须与开发者后台配置一致。

```powershell
npm run planner -- doctor  # 只读检查字段、日历类型和权限
npm run planner -- once    # 执行一轮同步并退出
npm run planner -- run     # 长连接接收变更，默认每五分钟对账
npm run planner -- status  # 读取本地缓存、待执行操作和冲突计数
```

`once` 和 `run` 会协调已配置资源中的数据。停用任何会为同一任务创建日程的飞书自动化后，再对正式资源启动同步。首次同步会处理符合排期条件的既有任务。关闭进程期间的数据变化会在下次启动时补偿。

默认字段映射沿用已联调的两张表。自定义列名可通过 `FEISHU_SCHEDULE_FIELDS` 和 `FEISHU_TODO_FIELDS` 设置 JSON 对象。Schedule 键为 `title`、`start`、`end`、`status`，可选 `notes`、`eventId`、`calendarId`。Todo 键为 `title`、`date`、`done`，可选 `order`（数字列）、`notes`。其他可选设置包括 `FEISHU_TIMEZONE`、`FEISHU_POLL_SECONDS`、`FEISHU_WEBSOCKET=0`、`FEISHU_CANCELLED_STATES`（逗号分隔）和 `FEISHU_DATA_DIR`。

现有排期表使用「日程ID」和「日历ID」存放映射。飞书日历在联调中未返回 `source`，因此同步服务在日程备注末尾附加一个不含任务内容的映射标记。它用于在本地映射缺失时找回日程，回写任务详情时会剥离。飞书 API 写入全天日程时使用包含当天的截止日，读取时返回次日边界。

### 本次验收记录

2026 年 11 月 25 日在已配置的两张表和共享日历上用临时记录验证了任务与日程的双向改期、删除日程后清空排期、删除任务后移除映射日程，以及独立待办的创建、勾选和删除。已收到 Base 记录和日历日程的 WebSocket 通知，临时记录清理后复查为零。

已导入首轮 OAuth 回调并验证真实授权可用于查询目标共享日历。回调的 state、PKCE 校验以及刷新令牌轮换由自动化测试覆盖。本次联调使用有效的既有访问凭证。

## 10 Windows 桌面版

### 安装与连接

运行 Windows x64 安装包，在设置中选择「导入 .env」，再点「浏览器授权」。App Secret 由主进程读取并交给 Windows DPAPI 加密。前端只显示配置状态。安装版在当前 Windows 用户的应用数据目录保存布局、缓存、队列和加密凭证。

本机从源码运行可使用现有项目目录内的 .env 和 data。安装到另一台电脑时，在该电脑导入连接配置并重新授权。

```powershell
npm ci
npm run desktop       # 启动开发版，使用项目内的现有配置
npm run pack:win      # 构建 Windows x64 NSIS 安装包
npm test
npm run typecheck
npm run test:desktop  # 隔离配置与模拟数据，不连接真实飞书
```

安装程序输出到 dist。首次执行 Electron 开发测试或打包时，会下载所需的 Windows 运行时和构建工具。安装包自带运行时；构建默认没有代码签名证书。

### 挂件操作

- 排期日历支持月历、按日或按周的甘特时间线、未排期列表及搜索。拖选日期范围新建任务，拖动任务条改期，拖动任务条边缘调整起止日期。
- 今日待办列出所有未完成事项，包括逾期、未来和未设日期的待办。新建时可在输入栏设置优先级。优先级按飞书选项顺序缩进，未设置优先级的待办左对齐。默认开启缩进，可在「设置 → 挂件外观」关闭并保存。列表按用户调整的前后顺序排列，拖动把手或使用方向键可跨日期和优先级排序。勾选或飞书同步完成后，事项淡出列表；在飞书表格取消完成可将事项恢复到挂件。首次排序时若未配置排序权重列，应用会尝试在待办表创建「排序权重」数字列。缺少建列权限时可由表管理员创建该列，或在设置中映射现有数字列。
- 应用打开后进入浏览模式。挂件底部可打开设置、手动刷新，日程和待办可以直接操作。挂件的位置和大小在浏览模式下锁定。
- 在「设置 → 挂件外观」选择「调整布局」，或在托盘选择「调整挂件布局」，可拖动布局栏和窗口边缘。点「完成」回到浏览模式。两个挂件分别保存布局。
- 「挂件外观」可选择雾青、暖砂或夜航。配色即时应用到所有窗口，重启后继续使用上次选择。
- Windows 挂件采用无边框浮动窗口。WorkerW 原生桌面嵌入的稳定性仍需在目标设备验证。
- 离线编辑先入本地 SQLite 队列。联网、长连接恢复或电脑唤醒后补偿同步。排期列表与日历映射之间出现同字段冲突时按 Base 值收敛并计数。

排期进度、优先级、分类和备注显示实际配置中可用的字段。排期表当前缺少可写的进度或优先级列时，对应表单项会在配置有效映射后显示。

### 桌面版验收记录

Windows 打包程序的窗口验证覆盖月历、按周甘特、今日待办、设置、拖动排期、待办勾选与排序命令、布局保存及浏览与编辑模式。同步测试覆盖离线改期后重启恢复、独立待办排序写回、日历去重和 OAuth 回调。

真实飞书验收使用临时数据，核对了桌面队列创建任务和对应日程、改期、删除，以及独立待办创建、勾选和删除。三处资源的临时数据清理后复查为零。
