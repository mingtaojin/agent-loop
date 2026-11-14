# 在本机运行 Agent Loop

每个项目都通过自己的协调者接单，委派使用 poteto-mode 的 Worker，并接收问题和成果。配置、项目工具和会话恢复见[项目协调者](docs/project-coordinator.md)。

Agent Loop 保存项目和任务的持续上下文。用户在项目协调群交办新需求，GitHub Issue 作为协调者证据。CLI 和机器人私聊不再接单。协调者决定是否派发 Worker，正式执行复用持续 Thread。Worker 默认无群，需要直接交流或点击审批时按需建群。Agent 选择技能、实现和交付流程，Runtime 保存关系、材料、原生请求与恢复记录。

## 准备配置

安装 Node.js 24 或更高版本、Git 和支持 `codex app-server daemon` 的 Codex CLI。完成 Codex 登录后运行以下命令。

```sh
npm install
cp config/example.json config.json
```

编辑 `config.json`，将 `feishu.userOpenId` 改为应用下的所有者 Open ID。相对路径均以配置文件所在目录为基准。

正式任务共用本机 Codex daemon。Agent Loop 通过官方 `daemon version` 发现服务，只在服务未运行时调用 `daemon start`。连接失败会报告错误，断线后重新连接并核对原 Thread。Agent Loop 不停止、重启或更新 daemon，也不回退私有 App Server。

在 `execution.backends` 配置执行后端连接参数，在角色配置中填写 `backend`、`model` 和 `reasoningEffort`。当前提供 Codex 后端，未来可以增加其他执行后端。模型配置属于 Agent Loop 运行时，不修改后端的全局配置；配置文件变化由运行时 watcher 读取，下一次模型调用生效。

Agent Loop 不再使用模型选择目录。任务必须先归属到已配置项目；未归属 intake 和历史任务保持等待，不创建执行 Thread。项目协调者和 Worker 直接使用项目目录及统一的角色执行配置。

本地项目可使用 `repositories: []`，不需要 GitHub token。正式会话按角色读取 `prompts/coordinator.md` 或 `prompts/worker.md`，`engineering.promptPath` 不覆盖角色规则。角色指导、委派范围和环境信息通过 `developerInstructions` 与 `additionalContext` 传入正式 Thread；用户消息和 Issue 内容作为请求材料。`engineering.skillPath` 指向已安装的 poteto-mode，其他技能通过现有机制发现。加载与更新方式见[正式会话提示词](docs/prompts/task.md)。

在 `engineering.projectRoot` 中配置工程所在的父目录：

```json
"engineering": {
	"projectRoot": "../projects",
	"promptPath": "./prompts/task.md"
}
```

父目录的一级子目录各自作为可发现工程，例如 `opentest` 和 `agent-loop`。工程可以没有 Git 元数据，也可以包含多个仓库与资料。内部仓库、模块和版本目录不作为独立项目，由正式 Agent 按任务继续定位。新增工程无需逐个登记。根目录没有绑定某台机器的默认值，更换父目录只需修改配置。

`repositories` 继续定义 GitHub 采集来源。使用工程发现根目录时，条目只需仓库名与 `criteria`，无需填写本地 `path`、`baseBranch` 或 `workspace`。本地工程发现不依赖 Git remote，也不会自动采集这些工程的 GitHub Issue。飞书任务可使用 `repositories: []`，仍能发现本地工程。

`criteria.taskTypes` 默认仍为 `["bug"]`，可显式配置 `["bug", "feature"]` 或 `["feature"]` 来纳入 Feature。设置为 `null` 时不限制任务类型，仍应用状态、分配人和标签筛选。也可配置非空分类名称，如 `refactor`，并在 `nativeTypes` 或 `typeLabels` 中映射。仓库、分配人、标签和类型映射共同决定新来源的收集范围，不需要额外启动标签。

未配置工程发现根目录时，原有显式工程配置仍可使用。仓库的 `path` 必须为 Git 根目录，`baseBranch` 必须是本地已有引用，默认准备任务独立的 Git worktree。要将原有条目关联到完整项目目录，在仓库条目中增加：

```json
"workspace": {
	"kind": "project-directory",
	"path": "../projects/opentest"
}
```

使用根目录发现工程或旧条目的共享目录策略时，Runtime 校验已有项目目录。目录可以由多个任务共享，Agent 按目录中的项目说明使用子仓库和 worktree。服务不自动拉取、复制或重置原始工程。旧显式条目省略 `workspace` 或设置 `{"kind":"git-worktree"}` 时使用独立 Git 工作区。配置在服务启动时加载，修改配置后需重启服务。更换根目录不自动重绑已有任务的会话与工程资源。

## 项目归属与正式任务

新 Task 先保存原始任务与附件。项目协调者负责确认工程归属并通过 `claim_intake` 或 `dispatch` 派发 Worker；未归属 intake 和历史任务保持等待，不创建执行 Thread。确认归属后，协调者和 Worker 直接使用项目配置的目录，所有项目共用实例级角色执行配置。后续讨论、澄清、工程工作和恢复沿用正式 Thread。

凭证通过环境变量提供。默认名称为 `GITHUB_TOKEN`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`。配置仅保存变量名。程序加载当前目录的 `.env`，已有进程变量优先。可用 `--env-file` 指定其他文件。不要将真实凭证写入 JSON、prompt 或全局说明。

## 飞书接入

先在当前实例使用的飞书应用中启用机器人、长连接、消息接收和交互卡片回调，授权群创建、群信息、消息收发、历史读取和资源下载。`npm run pair:feishu -- --config config.json` 可在独立进程通过私聊口令绑定所有者。

按需要启用的能力继续配置。基础消息收发成功，只代表基础聊天可用。

| 需要的能力 | 配置与权限 | 接入说明 |
| --- | --- | --- |
| 基础聊天、任务群、最终答复及原生问题与审批 | 基础消息和群权限，进度默认关闭 | 本节及[检查与启动](#检查与启动) |
| 聊天中的执行进度卡片 | `feishu.progress.enabled: true`、`surface: "card"`，额外需要 `cardkit:card:write` | [飞书执行进度卡片](#飞书执行进度卡片) |
| 群顶部固定的“执行进度”Tab | `feishu.progress.enabled: true`、`surface: "document"`、当前企业的 HTTPS `documentBaseUrl`，额外需要文档、协作者和标签页权限 | [飞书固定进度页](#飞书固定进度页)及[完整接入与验收步骤](docs/feishu-setup.md) |

进度卡片与固定 Tab 是两种展示方式，同一实例同时只使用一种。不同实例使用不同 App ID 时，需要分别配置权限。首次启用顶部 Tab 时，按[确认应用、开通权限、重载配置、逐项验收](docs/feishu-setup.md)的顺序操作。

## 检查与启动

本机常驻执行服务由 launchd 管理，日常启动、停止和重启遵循[本机服务操作](docs/agents/operations.md)。以下 `run` 命令用于前台调试，运行前先停止 launchd 服务。

```sh
npm start -- doctor --config config.json
npm start -- collect --config config.json
npm start -- status --config config.json
npm start -- run --config config.json
```

`doctor` 检查本地配置和凭证是否存在，不验证远端权限。`collect` 保存来源与事件并建立所需的项目协调者，不派发 Worker。`status` 读取任务、输入、输出和诊断记录。`run` 启动常驻服务并处理已收集任务。`doctor` 通过不能代替[固定进度 Tab 的接入验收](docs/feishu-setup.md#验收新任务群)。

## 在项目群交办

在项目协调群发送需求及材料。协调者先核对已有工作，再决定是否委派 Worker。
Worker 默认无群，用户需要直接交流时向协调者提出。
原生审批自动打开任务群并在项目群通知，普通问题和最终成果交给协调者。

CLI submit、answer 及机器人私聊接单已移除。运维命令和内部协调工具继续保留。
旧 CLI 请求可只读查询，不会新建执行者：

```sh
npm start -- status --config config.json --request-id '<旧请求 UUID>'
```

## 本地调试网页

调试网页随 `run` 自动启动和停止：

```sh
npm start -- run --config config.json
```

打开启动事件 `started.dashboard.url` 中的地址，默认端口是 `8787`。`dashboard.host` 默认是 `0.0.0.0`，监听全部 IPv4 接口，启动事件的 `dashboard.networkUrls` 列出网络地址。看板是网络可访问的全局只读数据库视图，不提供登录或 token 鉴权。网页操作不会启动任务。`run` 仍需要执行服务的凭证。

网页端口绑定失败时，`run` 启动失败，不连接飞书。不同数据目录的服务实例需要配置不同端口。独立的 `dashboard` 命令已移除。

左侧显示全部项目任务，可按名称、任务 ID、角色和状态搜索筛选。选择任务后可查看逐段更新的模型文字、工具调用状态元数据、容量不足等执行错误，以及任务消息、结构化汇报、诊断、会话 ID 和工作目录。看板不保存或展示工具输出正文。执行服务心跳单独显示，网页连接成功不代表执行服务仍在运行。

实时事件由新版 `run` 进程写入相同数据目录的 SQLite。升级后重启执行服务一次即可开始记录，不需要重新创建任务。网页刷新或断线后回放已保存的事件；升级前的任务群消息可从“消息记录”查看，之前未记录的流式片段无法补回。调试记录与飞书通知独立，不改变任务唤醒、恢复、模型选择或审批规则。

飞书默认只转发 Agent 的最终答复。执行进度可通过固定文档标签页或消息卡片展示，同一时间只使用一种方式。原生问题与审批请求仍通过独立消息处理。

项目 Worker 默认没有任务群，正式问题、进展和成果通过显式 `report` 交给项目协调者，独立任务完成也须汇报。普通最终答复和任务群讨论留在原任务；用户要求同步时，Worker 直接提交有实际用户来源的讨论摘要。用户需要直接对话时，在项目群自然语言提出，由协调者打开指定任务群。原生审批会按需建群并在项目群通知。Runtime 不发送定时监督提醒，没有新事件时协调者持续等待。新群不补发历史消息。群被手动解散后任务继续运行；现有进度发布只面向有效群，不提供新的项目进度总览。批量清理见[任务群管理](docs/task-groups.md)。

调试台会保存可见模型文字、工具调用状态元数据和错误；不记录工具输出正文、原始协议配置、系统指导或私有推理内容。它是网络可访问的全局只读视图，不提供登录或 token 鉴权。

### 飞书固定进度页

首次接入请先完成[固定进度 Tab 配置与验收](docs/feishu-setup.md)，其中包含当前应用的确认方法、开放平台操作步骤、权限导入 JSON 和常见故障排查。

在群里的“执行进度”标签页查看当前任务的对话记录，包括用户输入、AI 过程说明和最终答复。记录按时间倒序排列，最新消息在上方，每条消息内部保持正常阅读顺序。记录跨轮次保留，隐藏工具调用和工具输出。默认展示最近 3000 行，超过上限时移除最早的展示内容，原始任务记录仍保存在本地。

有群任务复用绑定当前群的飞书云文档。文档内容每隔几秒合并更新，最终答复、原生问题和审批仍在聊天中处理。群失效后停止原文档投递；重建群使用独立文档，不向已失效群更新权限或标签页。

在 `config.json` 的现有 `feishu` 配置中加入：

```json
"progress": {
  "enabled": true,
  "surface": "document",
  "intervalMs": 3000,
  "maxLines": 3000,
  "documentBaseUrl": "https://example.feishu.cn"
}
```

`documentBaseUrl` 中的 `https://example.feishu.cn` 是占位值，替换为企业实际的 HTTPS 飞书文档域名，不带文档路径、端口、查询参数或片段。文档由飞书托管，不依赖运行 Agent Loop 的电脑能否被手机访问。文档模式不会在失败时改发进度卡片。

`maxLines` 是文档展示的逻辑行数上限，按文本中的换行计算，包含状态、角色标签和空行；屏幕自动折行不另计。已有文档在恢复后从本地保存的输入和 AI 执行事件重建历史。文档显示附件名称，附件原件保留在任务材料中。

机器人需要以下应用身份权限：

- `docx:document`，创建、读取和更新新版文档。
- `docs:permission.member:create`，将任务群添加为可阅读的协作者。
- `docs:permission.member:retrieve`，核对协作者，避免把创建标签页成功误认为群成员已经获得阅读权限。
- `im:chat.tabs:read` 和 `im:chat.tabs:write_only`，查找并添加固定入口。已有应用身份的 `im:chat` 权限时可覆盖这两项，`im:chat:read` 不能替代标签页读取权限。

群设置还需允许机器人管理标签页。仅授予当前任务群阅读权限，不修改公开分享设置。权限不足、网络故障和文档创建结果不明确会记录到诊断，不阻断任务或最终答复；未知的创建结果不会自动重建文档。配置修改后按 [服务操作说明](docs/agents/operations.md) 重启执行服务。群消息正常但没有 Tab，或出现 `99991672`、`212002` 时，按[固定进度 Tab 排障顺序](docs/feishu-setup.md#按症状排查)检查。

### 飞书执行进度卡片

需要将进度放在消息中时，可选择 `surface: "card"`。未填写 `surface` 的已有配置保留卡片行为。

在 `config.json` 的现有 `feishu` 配置中加入：

```json
"progress": {
  "enabled": true,
  "intervalMs": 1000
}
```

默认直接在飞书卡片中查看进度，不显示网页按钮。需要完整可见文字入口时，可另加 `dashboardUrl`，填写飞书客户端能访问的 HTTP 或 HTTPS 地址。网络地址能否访问取决于运行主机的网络和防火墙配置。看板不提供登录或 token 鉴权。配置修改后按 [服务操作说明](docs/agents/operations.md) 重启执行服务。

机器人需要 `cardkit:card:write` 权限及已有的消息发送权限。每轮执行发送一张进度卡片，后续合并更新同一张卡片。卡片展示执行状态、最近执行事件时间、模型文字和有长度限制的工具调用状态；完整可见文字保留在调试台。没有新事件时，最近执行事件时间保持原值。最终答复继续作为独立普通消息发送。

卡片身份和更新顺序持久化，服务恢复后继续更新原卡片。首次启用不补发已结束的历史轮次。进度投递失败记录到诊断，不触发任务重跑，也不阻断最终答复。飞书消息发送结果不明确时，先核对原群消息与已保存的卡片实体；找到原消息便继续更新，确认没有发送且仍在平台去重保证范围内才重试。无法完成核对时不会盲目补建卡片。

在项目协调群交办新工作或补充文字、图片和文件。协调者评估后决定是否派发 Worker。需要直接与某个 Worker 交流时，在项目群提出，由协调者打开其任务群。正式群内的普通文字继续原会话，包括旧命令文字，停止工作的意图由 Agent 理解。

CLI `submit`、`answer` 及机器人私聊接单已经移除。运维 `doctor`、`collect`、`status`、`run` 和内部项目、工作区工具保留。`status --request-id` 只读查询旧 CLI 请求，旧 Task、Thread、材料和资源继续保留。

正式执行中，输入追加到当前轮次。没有活跃轮次时，新输入在原 Thread 启动一轮。Issue 更新和评论先交给协调者判断，再按需转给 Worker。关闭、分配与标签变化不直接暂停既有任务。来源事件不会被当作原生问题的人工答案或权限批准。

原生问题可直接用文字回答。多个问题需要按提示中的问题 ID 提供完整 `answers` 对象。工具审批使用对应卡片的批准或拒绝按钮。按钮回调只表示操作已持久化接收；执行器确认、拒绝、过期或不确定结果另行记录。普通聊天不会批准工具。

## 保留材料和工程目录

截图与 UTF-8 日志保存在 `<dataDir>/attachments/<taskId>`，独立于工程 worktree。相同文件名不会覆盖。下载、大小、编码或格式失败会保留消息并报告，失败消息的文字不伪装成完整送达。后续普通消息可继续投递。确认未送达的附件可通过服务 API `retryAttachment(taskId, inputId)` 重试；结果未知的输入不能直接重发。首版没有群聊附件重试命令。

任务资料保存在 `<dataDir>/tasks/<taskId>`。接单记录中的原文、补充回答和附件保留到协调者派单后，再准备执行环境并创建正式 Thread。发现的项目直接使用已有项目目录，由 Worker 按项目约定创建独立工作树。旧独立 worktree 位于 `<dataDir>/workspaces/<taskId>--<resourceId>`，旧 `project-directory` 策略继续使用保存的完整项目目录。

正式任务可通过 `ensure_workspace` 的 `projectId` 参数申请额外发现的项目，原有 `repository` 参数继续支持显式仓库与保存的旧资源。同一 Task 可关联多个工程资源。已有资源优先按保存的身份与路径恢复，配置更新不迁移旧工作区。目录或分支不符时停止并保留现场。

当前原生 Codex 不能为旧 Thread 补加动态工具。Runtime 继续为旧 Thread 提供任务限定的本地 shell 客户端，仍调用相同的工作区管理器；新正式 Thread 使用动态工具和项目目录。旧 Thread 的能力文件位于 `<dataDir>/workspace-capabilities`，进程重启后替换。不要复制或手工调用其他任务的能力文件。目录准备不代表额外授权，实际读取与修改继续受 Codex sandbox 和原生审批限制。

## 重启和故障

本机常驻服务按[本机服务操作](docs/agents/operations.md)中的 launchd 命令重启。前台调试进程按 Ctrl+C 退出。保留数据目录、任务分支和 worktree。服务核对群、项目归属、资源、正式 Thread 和未确认输入，不建立第二个同任务执行者。等待项目归属和正式任务的正常等待均在重启后保留。服务关闭会中止己方活跃执行、解除己方 Thread 订阅并关闭连接，共享 Codex daemon 继续运行。

已确认的执行故障按 `recovery.maxAttempts` 和 `recovery.retryDelayMs` 有限恢复。项目归属不明确时保留 pending，不创建 Thread。没有正式执行总时长限制，静默本身不触发故障判定。达到恢复上限、目录不匹配或未知副作用会保留诊断。未知输入、审批和通知不盲目重放。

自动恢复停止后，所有者在原任务群发送的新消息会重新校验资源并沿原 Thread 继续，离线期间已保存的后续消息也会处理。新消息开启一轮有限恢复；同一条未投递消息不会反复重置恢复次数，来源更新也不会唤醒失败任务。

旧版因来源或群命令暂停的任务在升级后仍等待。所有者的新群消息可继续原 Thread。嵌入服务 API 的显式 `control(taskId, 'pause')` 是独立的操作员控制，保持暂停直到同 API 的 `resume`，不解释聊天文字。首版 CLI 不提供在线操作员控制或不确定结果的自动修复。

## 验证

```sh
npm run check
npm test
npm run build
```

自动化测试使用真实 SQLite、临时 Git 仓库、受控平台和协议子进程。可选真实 Codex 验证使用当前登录并产生模型调用，执行前阅读对应脚本。

- `npm run verify:codex` 验证普通答复、会话续接、动态工具与进程恢复。
- `npm run verify:inputs` 验证运行中追加、合成图片及临时 UTF-8 日志读取。
- `npm run verify:runtime` 验证实际 Runtime 的新旧 Thread、真实工作区布局和双仓库隔离，仅批准脚本列出的临时命令。平台使用本地替身。
- `npm run verify:feishu -- --listen` 会向真实验证群发送合成材料，需显式授权且与正式服务分开运行。它验证基础群消息和附件传输，不验证云文档、群阅读权限、固定 Tab 或文档内容更新；这些能力按[固定进度 Tab 验收步骤](docs/feishu-setup.md#验收新任务群)核对。

当前证据和未完成验收见 [实现状态](docs/implementation-status.md)。已批准的持续上下文规格位于 [.scratch/agent-runtime-context/spec.md](.scratch/agent-runtime-context/spec.md)。历史 ADR 和旧规格保留为决策记录。

## 验证共享 Codex 服务

运行 `npm run verify:shared-codex`，通过构建产物验证正式对话、动态工具和独立客户端继续执行。脚本仅使用临时目录和只读模型请求，记录 daemon socket 与进程身份，不停止、重启或更新真实 daemon。可用 `CODEX_VERIFY_EXECUTABLE` 和 `CODEX_VERIFY_OUTPUT` 指定入口与证据路径。

`npm test` 的本机多客户端协议 fixture 覆盖未运行时启动、启动失败、响应丢失和断线恢复。真实服务验证不通过停止正在使用的 daemon 注入故障。测试、真实服务验证、Git 合并和部署分别报告。
