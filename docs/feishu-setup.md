# 配置并验收飞书固定进度 Tab

完成本指南后，新任务群顶部会有一个“执行进度”Tab。群成员可以打开其中的飞书云文档，并看到持续更新的任务对话。基础消息接入、聊天进度卡片和固定文档 Tab 的区别见 [README 飞书接入](../README.md#飞书接入)。

## 确认当前实例与飞书应用

1. 确认目标服务的工作目录、启动参数中的 `--config` 路径和 `--env-file` 路径。未指定 `--env-file` 时，程序读取工作目录的 `.env`。本机 launchd 实例的位置与检查方法见[服务操作说明](agents/operations.md)。
2. 在该配置中找到 `feishu.appIdEnv`，读取它所指环境变量的 App ID。默认变量名为 `FEISHU_APP_ID`，`appIdEnv` 本身填写变量名。进程已有环境变量优先于 `.env`。不要用另一个终端或另一个实例的环境代替服务实际环境。
3. 登录[飞书开放平台开发者后台](https://open.feishu.cn/app)，打开该 App ID 对应的应用，在“凭证与基础信息”中核对 App ID。后续权限操作均在这个应用中完成。另一实例的机器人能发文档，不代表当前应用也有权限。

在项目根目录使用以下只读命令查看磁盘配置与当前终端的 App ID。将配置路径、环境文件路径换成目标实例的路径。命令只输出 App ID 和相关配置，不输出 App Secret。

```sh
node --import tsx --input-type=module <<'NODE'
import { loadConfig } from './src/config.ts';
process.loadEnvFile('.env');
const config = await loadConfig('config.json');
console.log(JSON.stringify({
	appIdEnv: config.feishu.appIdEnv,
	appId: process.env[config.feishu.appIdEnv] ?? null,
	dataDir: config.dataDir,
	progress: config.feishu.progress,
}, null, 2));
NODE
```

此命令不读取运行中服务的内存配置。若凭证由服务管理器注入，需在服务定义中核对变量来源。不要将真实 App Secret 或访问令牌写入文档、JSON 配置或排障记录。

## 配置文档进度模式

将下列 `feishu` 对象合并到目标实例的配置文件，保留其他配置。所有占位值都需要替换。`userOpenId` 使用当前应用下已绑定的所有者 Open ID。

```json
{
	"feishu": {
		"appIdEnv": "FEISHU_APP_ID",
		"appSecretEnv": "FEISHU_APP_SECRET",
		"userOpenId": "REPLACE_WITH_YOUR_OPEN_ID",
		"progress": {
			"enabled": true,
			"surface": "document",
			"intervalMs": 3000,
			"maxLines": 3000,
			"documentBaseUrl": "https://example.feishu.cn"
		}
	}
}
```

`https://example.feishu.cn` 是文档域名占位值。打开本企业的一篇飞书文档，使用地址的 HTTPS 域名部分。不要填开放平台地址、本地调试网页地址或完整文档链接。域名不能带凭证、端口、路径、查询参数或片段。

只有 `enabled: true` 且 `surface: "document"` 才启用文档发布器。进度默认关闭，省略 `surface` 时默认为 `card`，不会创建顶部文档 Tab。文档模式失败时也不会自动切换到卡片。文档展示与行数限制见 [README 飞书固定进度页](../README.md#飞书固定进度页)。

## 在开放平台开通应用身份权限

保留基础消息和群权限，在当前应用的“权限管理”中补齐以下五项**应用身份权限**。它们由 `tenant_access_token` 使用，选择同名用户身份权限不能替代。

| 应用身份权限 | 用途 |
| --- | --- |
| `docx:document` | 创建、读取和更新新版云文档 |
| `docs:permission.member:create` | 将当前任务群添加为文档的阅读协作者 |
| `docs:permission.member:retrieve` | 回读协作者列表，核对当前任务群的阅读权限 |
| `im:chat.tabs:read` | 查找群内已有的文档 Tab，避免重复添加 |
| `im:chat.tabs:write_only` | 创建群顶部的“执行进度”Tab |

已有应用身份的 `im:chat` 可覆盖这两项标签页权限。`im:chat:read` 只允许查看群信息，不能替代 `im:chat.tabs:read`。使用其他更广权限时，逐个核对[拉取会话标签页](https://open.feishu.cn/document/server-docs/group/chat-tab/list_tabs)、[添加会话标签页](https://open.feishu.cn/document/server-docs/group/chat-tab/create)及相应文档接口页面列出的可选权限，不能凭权限名称推断覆盖关系。

按以下顺序配置：

1. 在已核对 App ID 的应用中打开“权限管理”，选择“应用身份权限”。
2. 按权限标识搜索并添加五项权限。也可使用“批量导入”，导入以下 JSON。`tenant` 表示应用身份权限，`user` 留空。本 JSON 只补充文档进度权限，不替代已有的基础消息权限。
3. 查看后台对每项权限的提示并完成开通。免审权限在确认开通后可能立即生效；需要发布或管理员审批的权限，按提示发布应用版本并等待审批完成。仅“已添加”不代表已授权。
4. 回读当前应用的实际授权状态。可在后台核对，也可使用下文的“查询租户授权状态”接口。五项权限或它们的覆盖权限均已授权后再继续。
5. 在目标任务群的设置中确认机器人可以管理标签页。应用已获标签页 API 权限，也仍需满足群内管理限制。

```json
{
	"scopes": {
		"tenant": [
			"docx:document",
			"docs:permission.member:create",
			"docs:permission.member:retrieve",
			"im:chat.tabs:read",
			"im:chat.tabs:write_only"
		],
		"user": []
	}
}
```

### 回读实际授权状态

在开放平台的 [API 调试台：查询租户授权状态](https://open.feishu.cn/api-explorer?project=application&resource=scope&apiName=list&version=v6)选择当前应用，使用应用身份调用 `GET /open-apis/application/v6/scopes`。在返回的 `data.scopes` 中逐项核对 `scope_name`、`grant_status` 和 `scope_type`，按接口页面的状态枚举确认所需的 `tenant` 权限已授权。接口说明见[查询租户授权状态](https://open.feishu.cn/document/application-v6/scope/list)。

若权限缺项，返回“权限管理”添加；若未授权，完成后台要求的发布或审批后再查。保存脱敏后的权限与状态即可，不保存令牌。不要将调试台切到其他应用或用户身份后得到的成功结果用于当前实例的验收。

2026-11-12 的接入记录中，这五项权限均标为免审，确认开通后立即生效，后台仍显示“当前修改均已发布”。这是该次租户的结果，其他环境以后台提示和实际授权回读为准。

## 重载配置并确认目标实例

1. 使用目标配置运行 `npm start -- doctor --config config.json`。若环境文件不同，追加 `--env-file /absolute/path/to/.env`。先修正配置解析错误或缺失凭证。
2. 确认服务定义中的工作目录和配置路径与刚修改的文件一致，按[服务操作说明的重启步骤](agents/operations.md#修改配置后重启)重启目标实例。不要另开一个 `run` 进程共用同一数据目录。
3. 重启后核对服务 PID、调试网页的执行服务心跳 PID 和持续更新的心跳时间。核对最新 `started` 日志的 `dataDir`、调试网页地址与目标实例一致。日志位置和状态命令见[服务操作说明](agents/operations.md)。
4. 再次运行本指南的配置查看命令，确认磁盘中的 `enabled`、`surface` 和 `documentBaseUrl`。随后用新任务群的实际文档和 Tab 完成验收。仅看到磁盘新配置或一个旧心跳，不能证明目标服务已加载新配置。

`doctor` 检查本地配置、目录和凭证存在性，不调用远端权限接口，也不创建文档或 Tab。它的 `ready: true` 不能代替权限回读或接入验收。`npm run verify:feishu -- --listen` 验证基础群消息和附件传输，会发送真实测试消息并另开连接；它不覆盖本文的文档进度验收，运行约束见 [README 验证](../README.md#验证)。

仅在开放平台补授权、没有修改本地配置时，运行中的文档发布器会重试明确失败的操作，通常无需重启。文档创建结果不明确时不会自动重建，处理方法见下文排障。

首次启用不会为已结束且尚无文档记录的历史轮次补建 Tab。验收使用新任务群；已有任务群可在下一轮有效对话时创建文档。已有文档的任务继续复用原文档。

## 验收新任务群

使用目标实例已绑定的所有者账号私聊对应机器人，发送一条无业务副作用的任务，例如“接入验收，请回复收到”。每条不同的非空私聊消息都会建立新任务；后续补充发到新建的任务群。

逐项记录结果，不要只记录“消息已发布”：

- [ ] 新任务群正常建立，并收到 Agent 的最终答复。这一项证明基础聊天链路可用。
- [ ] 当前任务有实际的飞书云文档，文档 URL 使用本企业域名，内容属于当前任务。记录 Task ID、群 ID 与文档 URL。
- [ ] 通过群成员账号打开文档确认可阅读。若群内有其他普通成员，也用该成员账号核对，不能只用应用开发者或已有单独文档授权的账号。文档协作者列表中应包含当前任务群及阅读权限，不需要开放公开分享。
- [ ] 群顶部出现名为“执行进度”的文档 Tab。打开 Tab 后核对其 URL 与当前任务文档一致，不能只按名称判断。
- [ ] 在同一任务群发送带唯一标记的补充，例如“接入验收第二条 20261112-01，请回复此标记”。等待合并更新后刷新原文档，确认新增用户输入与 AI 答复，且仍复用原文档和 Tab。记录更新前后可对照的标记和时间。

文档按时间倒序显示对话，隐藏工具调用及工具输出。不要用是否出现工具日志判断内容更新。更新会按 `intervalMs` 合并，网络和限流可能延迟发布，等待后结合下面的诊断排查。

若从“仅具备基础消息权限”的应用验收，先记录缺项、文档接口的拒权诊断和缺失的 Tab，再添加权限并回读授权状态。保持文档模式开启，观察原任务的明确拒权操作重试成功，最后另建一个新任务群完成全部检查。不要通过撤销正式应用的现有权限制造此场景。

## 按症状排查

### 先收集当前实例的配置与诊断

使用目标配置查看任务与最近诊断：

```sh
npm start -- status --config config.json
```

在输出的 `tasks` 中用 Task ID 和 `chatId` 找到目标任务，再查看 `diagnostics`。文档发布器的诊断 `scope` 为 `feishu-document-progress`，`message` 通常以 Task ID 开头，`created_at` 是记录时间。这里只返回全局最近 100 条诊断，补权限后也保留旧错误，需结合最新时间与实际文档结果判断。

还可通过目标实例已有调试网页的只读接口 `GET /api/snapshot` 查看相同诊断。当前网页按任务筛选的“诊断”区域可能漏掉文档发布器的固定 scope，显示“没有诊断异常”时仍需查 CLI 或此接口。

### 核对文档发布记录

`status` 和调试网页接口不返回文档 ID 或 Tab ID。需要定位卡在哪一步时，在本地用只读 SQLite 查看发布记录，将路径换成目标配置的 `dataDir`：

```sh
sqlite3 -readonly '/absolute/path/to/data/tasks.sqlite' \
	'SELECT task_id, payload FROM feishu_document_progress;'
```

按 `task_id` 选择目标记录，核对其中的 `chatId`。`delivery.kind` 依次为 `document`、`block`、`access`、`tab`、`ready`，分别表示等待创建文档、准备正文块、授予群权限、绑定 Tab、已完成这些步骤。文档创建后保存 `delivery.documentId` 和 `delivery.documentUrl`，Tab 绑定后保存 `delivery.tabId`。

`delivery.pending: true` 表示已保存发送意图，不能当作成功。明确拒权会退避重试；文档创建结果未知时，会停在 `document` 且 `pending: true`，重启也不会重复创建。此时保留原记录与创建失败时的诊断，核对远端是否已有文档并交由维护者处理。

`ready` 表示初始化步骤曾成功完成，发布器不会持续复查群权限或 Tab 是否被删除。正文已同步时还应满足 `delivery.write` 为 `null`，且 `delivery.content` 与记录的目标 `text` 一致；最终仍需由群成员实际打开文档并检查新内容。

### 对照症状定位缺项

按“目标应用与配置、实际授权、文档和群权限、Tab、内容更新”的顺序核对：

| 症状 | 排查与处理 |
| --- | --- |
| 群消息正常，但顶部没有“执行进度”Tab | 先确认 `feishu.progress.enabled: true`、`surface: "document"` 和正确的 HTTPS `documentBaseUrl`，再核对目标服务是否重载。`card` 模式只发聊天卡片。继续查文档诊断、五项权限及群设置是否允许机器人管理标签页。 |
| 文档或标签页接口返回 `99991672` | 这是权限不足的诊断。根据失败接口和响应中要求的权限，在当前 App ID 下添加应用身份权限，再回读实际授权。文档创建需 `docx:document`，标签页读取需 `im:chat.tabs:read` 或覆盖权限，不能用基础群信息读取成功作证明。 |
| 当前应用与正常实例的 App ID 不同 | 重新确认目标服务的 `appIdEnv`、环境文件和进程环境来源。分别进入各自应用配置权限，另一应用的已授权状态不能复用。若修改了目标实例的环境或配置，按服务操作说明重启后重新验收。 |
| 权限已添加，但接口仍拒权 | 检查是否误选用户身份权限，以及是否尚需发布版本或管理员审批。用当前应用的应用身份回读实际授权；没有出现在已授权范围内时，返回权限管理处理，不能仅凭已添加列表判定生效。 |
| “向管理员申请授权”接口返回 `212002` | 此接口表示可申请的未授权范围为空，不能据此证明所需能力已授权。先检查五项权限是否已加入当前应用配置，再查授权状态。本次接入在尚未添加权限时遇到此码，回到权限管理添加并按后台提示开通后才恢复。接口说明见[向管理员申请授权](https://open.feishu.cn/document/application-v6/scope/apply)。 |
| 文档或 Tab 已创建，但群成员不能阅读 | 检查 `docs:permission.member:create` 与 `docs:permission.member:retrieve`，并回读文档协作者列表，确认当前 `chatId` 作为 `openchat` 成员具有 `view` 阅读权限。核对 Tab 绑定的文档 URL，使用普通群成员账号实际打开。Tab 创建成功不能证明协作者授权成功。 |
| Tab 可打开，但内容没有继续更新 | 在同一任务群发送唯一标记，先确认本地调试台有新输入和 AI 答复，再等待文档更新。若本地记录已新增而文档未更新，查文档发布诊断及文档读写权限。只有心跳变化或最终消息发送成功都不能证明文档更新成功。 |

文档进度失败不阻断任务执行和最终答复。不要通过反复重发任务、删除任务记录或手工重建文档来掩盖拒权或结果不明确的问题。
