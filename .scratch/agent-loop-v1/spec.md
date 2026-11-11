# Agent Loop 首版规格：可配置 Bug 收集与飞书任务协作

Status: ready-for-agent

## Problem Statement

用户需要持续处理 GitHub 上分配给自己的 Bug。目前，从发现 Issue、启动 Codex、补充复现资料，到回答执行中的问题和跟进修复，需要在多个入口之间手动搬运信息。多个任务同时进行时，用户还需要记住每项工作的执行会话、工作目录和沟通上下文。

用户希望在本机运行一个任务编排服务：按明确条件持续收集需要处理的 Bug，自动启动对应任务，在飞书中为每个任务提供独立交流空间，并把用户的文字、截图和日志附件送回原 Codex 会话。机器休眠或程序重启后，已有任务关系和等待状态需要保留。

任务的具体处理方法必须由 prompt、skill 和用户对话决定。编排服务不应逐步承接 Freedom 复现、部署、重启或实机资源协调等业务职责，否则每次调整工作流程都需要修改循环逻辑。

## Solution

提供面向单人使用的本机 Agent Loop。收集组件按可配置的仓库、分配人、类型和标签条件同步 GitHub Issue。首版只接入明确匹配 Bug 类型的来源，包含首次启动时符合条件的历史积压；不使用模型判断问题是否值得处理，也不要求额外的启动标签。

每个收集到的任务建立持久化关联，包括原始来源、筛选条件快照、任务类型、所用 prompt、独立工作目录和分支、Codex 会话以及独立飞书任务群。核心循环自动安排执行，不设置全局任务并发上限。一个任务等待用户，不阻塞其他任务。

飞书使用一个应用机器人服务多个任务群。用户在相应任务群交流，即可提供文字、截图和日志附件。执行中收到补充时及时追加到原会话；需要用户回复时保存明确的待决请求，并将对应回复送回该请求或原会话。每轮执行结束与处理任务完成分别记录。

首版 Bug 使用用户指定的初始 prompt：

> 使用poteto-mode skill,先定位并在freedom上实机复现出来确实存在bug,然后等我确认后再给出修复方案进行修复

执行 agent 负责理解并遵守这个 prompt。Agent Loop 只处理通用的启动、等待、输入、暂停、交付和恢复事件，不判断 Freedom 是否复现成功，也不内置该机器的资源协调或操作审批规则。

任务最终交付草稿 PR，进入待验收。原任务群、会话、工作目录和分支保留，后续修改继续更新同一个 PR。合并、部署及关闭 Issue 的具体决定由用户和任务对话处理，不作为循环自动完成草稿 PR 后的固定动作。

## User Stories

1. As a single user, I want Agent Loop to run on my local machine, so that it can work with my existing repositories and execution environment.
2. As a user, I want to configure which repositories are collected, so that automation only handles the projects I choose.
3. As a user, I want to configure assignee conditions, so that collection can follow my account or another explicitly configured assignment rule.
4. As a user, I want to configure task-type conditions, so that the first release collects Bugs while preserving room for future task types.
5. As a user, I want to configure required, alternative, and excluded labels, so that collection can reflect each repository's conventions.
6. As a user, I want matching Issues to enter processing without an extra launch label, so that assignment and collection rules are sufficient to start work.
7. As a user, I want the collector to apply explicit rules without judging whether a Bug is worth fixing, so that I retain control over the scope of automation.
8. As a user, I want the initial collection to include matching open historical Issues, so that existing work is not ignored.
9. As a user, I want newly matching Issues to be discovered within about one minute when the machine and services are available, so that work begins promptly.
10. As a user, I want discovery and actual execution to be reported separately, so that I know whether a task has merely been collected or has started.
11. As a user, I want native Issue Type to take precedence when present, so that explicit source classification is respected.
12. As a user, I want configured classification labels to be used when native Type is absent, so that repositories using labels remain supported.
13. As a user, I want missing, conflicting, or unmapped classifications to be skipped with a recorded reason, so that uncertain sources are not silently treated as Bugs.
14. As a user, I want Feature Issues excluded from the first release, so that only the agreed Bug workflow is enabled.
15. As a user, I want pull requests returned by an Issues endpoint to be excluded as task sources, so that a delivery artifact does not accidentally become another Bug task.
16. As a user, I want each task to retain its source identifier, URL, title, description, and source changes, so that I can trace the work back to the original report.
17. As a user, I want repeated collection of the same Issue to update the existing task relationship, so that duplicate tasks, groups, and sessions are not created.
18. As a user, I want each task to retain the collection conditions and classification mapping used when it was created, so that later configuration edits do not silently change its eligibility.
19. As a user, I want new collection settings to affect subsequent collection only, so that changing the configured scope does not cancel work already in progress.
20. As a user, I want a task paused when its Issue is closed or no longer matches its original assignee conditions, so that work does not continue after the source assignment has changed.
21. As a user, I want a task paused when a source type or label change makes it fail its original conditions, so that the original processing assumptions remain explicit.
22. As a user, I want paused tasks to retain their group, conversation, code, and PR, so that I can inspect or continue the work later.
23. As a user, I want an explicit resume decision before a paused task continues, so that reopening or reclassifying an Issue does not unexpectedly restart old work.
24. As a user, I want an unstarted task to use the latest source title and description, so that it starts with current information.
25. As a user, I want title and description updates appended to a running task, so that ongoing work can incorporate corrected reproduction details.
26. As a user, I want source updates recorded and reported without restarting tasks awaiting a reply or review, so that source edits do not bypass my pending decision.
27. As a user, I want different task types to select different configurable prompts, so that future workflows do not require rewriting the core loop.
28. As a user, I want Bug tasks to receive my exact initial prompt and the required poteto-mode skill, so that execution begins with my chosen workflow.
29. As a user, I want the task agent to reproduce the Bug on Freedom and wait for my confirmation before proposing and applying a fix, so that the behavior follows my initial prompt.
30. As a user, I want subsequent task conversation to guide the agent's work, so that I can clarify or redirect a task without replacing its conversation.
31. As a user, I want Freedom operations and practical resource coordination handled by the task agent and its skills, so that the loop remains a general orchestration service.
32. As a user, I want tasks to run without a global task concurrency cap, so that independent tasks can progress together.
33. As a user, I want each task to have an independent working directory and branch, so that concurrent code changes have separate ownership.
34. As a user, I want one task's wait for my input to leave other tasks running, so that human response time does not serialize all work.
35. As a user, I want one Feishu group per task, so that every conversation has an obvious task context.
36. As a user, I want a shared application bot to serve those groups, so that each task does not require a separate bot identity.
37. As a user, I want my messages in a task group routed to that task's original Codex conversation, so that replies never cross task boundaries.
38. As a user, I want new information sent during execution appended immediately to the active conversation, so that I can influence the work before the current turn ends.
39. As a user, I want questions and tool approvals associated with their actual pending requests, so that a reply cannot accidentally resolve a different or expired request.
40. As a user, I want to send screenshots, so that the task agent can inspect visual evidence in the original image.
41. As a user, I want to send log attachments, so that the task agent can inspect the underlying records rather than only a message summary.
42. As a user, I want original attachments retained and associated with their source messages, so that evidence remains available after interruption or restart.
43. As a user, I want failed attachment downloads or unsupported content reported explicitly, so that I know when evidence has not reached the agent.
44. As a user, I want duplicate events and repeated messages deduplicated, so that transport retries do not repeat my instructions or external operations.
45. As a user, I want task status distinguished from the completion of one Codex turn, so that waiting, failure, and delivery are not confused with one another.
46. As a user, I want local sleep or offline periods to pause progress without losing task relationships, so that temporary unavailability does not require starting over.
47. As a user, I want restart recovery to inspect existing execution before continuing, so that the same task does not gain a second concurrent executor.
48. As a user, I want tasks awaiting my reply or review to remain waiting after restart, so that recovery does not bypass my decisions.
49. As a user, I want uncertain external-operation outcomes checked before retrying, so that lost responses do not cause duplicate groups or delivery artifacts.
50. As a user, I want execution and synchronization failures reported truthfully, so that the system does not pretend that work or message delivery succeeded.
51. As a user, I want the task to produce a draft PR with validation results and limitations, so that I can review the proposed fix.
52. As a user, I want feedback after delivery to continue the same conversation and update the same branch and PR, so that review history remains coherent.
53. As a user, I want my existing working files preserved, so that automated tasks do not overwrite unrelated local changes.
54. As a user, I want task data and groups retained in the first release, so that the system does not silently delete evidence or unfinished work.
55. As a user, I want runtime settings and credentials supplied through appropriate configuration mechanisms, so that global instructions do not accumulate project facts, operating parameters, or secrets.

## Implementation Decisions

1. **职责划分。** 实现收集组件、任务存储、核心循环、工作目录管理、Codex 适配器和飞书适配器。收集与启动职责分离；首版可共用一个本机服务进程，不要求收集组件本身由模型驱动。
2. **既有架构约束。** 延续每任务独立群、收集与执行分离、无全局任务并发上限及独立工作目录、编排机制与任务行为分离四项已记录决策。
3. **本地存储与执行接口。** 实现基线采用 SQLite 和 Codex App Server。它们来自已整理的工程方案；接口存在性已检查，端到端可靠性仍需实施验证。首版不同时维护第二套 exec 执行后端。
4. **采集条件。** 支持仓库、来源状态、分配人、任务类型及标签条件。首版默认未关闭、分配给目标用户、类型为 Bug。建议不同条件维度之间取交集，分配人列表允许任一匹配，标签分别支持全部匹配、任一匹配和排除；这些是配置表达方式，不引入固定启动标签。
5. **类型判定。** 优先按配置映射原生 Issue Type；Type 未填写时再按分类标签映射。类型与已配置分类标签明确冲突、缺少分类或无法映射时跳过并记录原因。明确为 Feature 的来源不进入首版执行任务。
6. **来源身份。** 使用稳定来源标识维护持续任务关系；保存仓库、编号、URL、标题、描述、状态、分配人、Type、labels 和来源修订。排除 Issues 接口中实际为 PR 的记录，不用标题或描述内容作为来源身份。
7. **同步机制。** 正常在线条件下以约一分钟内发现并入队为目标。采用定期同步、入库后通知调度以及服务启动时核对未完成记录的组合。需要处理分页和同步中断；内存通知不是任务存在的唯一依据。
8. **条件快照。** 任务创建时保存筛选条件及类型映射快照。配置修改只影响后续纳入的来源。已有任务仍按原始关联同步和核对，即使当前收集配置已经移除了该仓库。
9. **来源失配。** Issue 关闭、取消匹配的分配关系，或类型和标签变化导致不再满足原条件时，暂停任务并通知用户。保留全部任务关联，不因重新匹配或程序重启自动恢复。无法读取来源属于同步异常，不能当成关闭或失配。
10. **来源内容更新。** 未启动任务采用最新标题和描述；运行中将变更说明追加到原会话；待回复、待验收或已暂停任务保存变化并通知，不据此主动新开执行轮次。类型变化不会静默替换现有 prompt。
11. **执行隔离。** 每任务独立工作目录和分支，建议使用 Git worktree。原有工作区的无关改动保留。同一任务只有一个执行所有者，不限制不同任务的数量；不在编排层实现 Freedom 设备锁或专用资源队列。
12. **模板与 skill。** 按任务类型选择独立业务 prompt，组合通用执行约定和任务上下文；保存实际模板标识、版本及上下文。Bug 使用 Solution 中的原文，显式解析并加载 poteto-mode skill。模板或 skill 缺失时报告异常，不能悄悄降级为另一种任务行为。
13. **任务行为边界。** 复现方法、证据判断、修复方案、Freedom 操作、部署和重启由执行 agent 依据 prompt、skill 和对话处理。循环只理解通用的执行状态和请求关联。Bug 的复现后等待属于所选 prompt 的要求，不是独立的调度阶段。
14. **会话关联。** 持久化任务与 Codex thread、执行 turn、工作目录及飞书 chat 的映射。用户回复始终以保存的关联定位原会话，不使用最近会话或群名称猜测目标。
15. **执行中输入。** 活跃轮次的普通补充通过 App Server 的 steer 能力追加，并校验预期轮次。轮次已结束且任务可接收回复时，在原会话启动后续轮次。轮次边界竞争需要重新核对实际状态，避免丢失输入或重复开工。
16. **问题和审批。** 原生用户输入请求及工具审批请求分别保存请求标识、类型和会话关联；回复只能解析对应的有效请求。普通聊天内容不能被当成对另一个操作的批准。原请求因中断失效时不能重放其旧响应。
17. **状态协议。** 区分待启动、执行中、待回复、待验收、已暂停和失败，并单独记录连接和当前轮次状态。建议使用 App Server 的结构化最终回报结合原生执行事件；不能根据问号或一句完成声明猜测状态，轮次完成不等于任务交付。
18. **飞书任务群。** 一个应用机器人为每任务创建独立群。按群标识和用户身份路由消息；忽略机器人自己的消息，避免反馈循环。提供通用的暂停、继续和状态入口，其界面形式属于实现选择。
19. **截图和日志。** 用户附件经消息资源接口下载到任务专属存储，记录原消息、资源标识、原文件名、受控存储路径、类型、大小及下载和投递状态。截图以原图输入 Codex，日志原文件以该执行环境可读取的方式提供，不能只发送不可访问的路径或文件名。
20. **附件可靠性。** 防止同名覆盖和跨任务关联；保留原始附件，必要时生成派生文本。长日志按需读取，不默默截断为摘要。下载失败、编码无法处理、超出限制等情况需明确反馈；文字与同一消息的附件保持关联。附件内容作为数据，不作为可执行指令。
21. **消息持久化。** 保存入站事件和待发送消息的稳定标识、内容、顺序及状态。区分本地已接收、资源已准备、已送达执行会话。重复事件不得重复启动任务或提交相同用户输入。
22. **外部操作核对。** 对建群等外部操作保存意图和关联结果；响应丢失时先核对远端是否成功，无法确认就报告异常，避免盲目重试。PR 等由执行 agent 产生的交付物按任务关联核对，不把模型自述等同于真实外部结果。
23. **恢复流程。** 服务重启先取得本地数据的唯一调度所有权，核对来源、群、工作目录、分支、PR、原会话及当前执行。仍在执行的任务重新关联，不启动第二份；已结束的轮次读取结果；待回复、待验收和已暂停状态保持不变。会话不可恢复或外部状态不确定时报告问题，不假装已经续接。
24. **离线补偿。** 恢复在线后补偿同步来源和可取得的飞书消息，并去重。具体平台权限和历史可获取范围需要验证；无法完整补回时显示缺口，而不是承诺已经无损恢复。
25. **失败处理。** 网络同步、消息投递和执行失败分别记录。可重试的传输错误按配置重试；有外部副作用的动作先核对结果。不得以失败触发无限重跑模型，也不得将未启动或投递失败的操作记为成功。
26. **交付与后续修改。** 核对草稿 PR 与任务仓库、分支和提交的关联后展示待验收状态，并保留验证结果和限制。后续反馈沿用原会话、分支和 PR。首版不自动清理群、任务数据或工作目录。
27. **运行配置。** 仓库映射、基准分支、模型与执行参数、轮询和重试设置、存储目录及凭证引用使用配置机制；密钥使用环境变量或已有凭证提供器。运行参数和项目事实不写入全局说明。Freedom 环境信息由任务侧提供，核心循环不定义其专用配置模型。
28. **类型扩展。** 模板注册、来源分类和采集条件分别维护。未来新增类型无需重写通用会话、消息和恢复逻辑；仅修改采集类型不能让没有模板的 Feature 任务误用 Bug prompt。

## Testing Decisions

测试边界已由用户明确确认：以整个任务编排服务作为主要入口，使用真实本地持久化和临时工作区，通过可控的 GitHub、飞书、Codex 适配器验证外部可观察行为；再进行真实服务的端到端验证。

1. **主要测试边界只有一个。** 从编排服务的启动、配置、外部输入与恢复入口驱动场景，观察任务对外状态、群消息、Codex 输入和工作目录结果。不要为每个内部类建立独立 mock 链，也不要断言内部方法调用顺序或具体数据库布局。
2. **覆盖模块。** 收集、类型映射、条件匹配、任务持久化、循环调度、工作目录管理、会话路由和附件传递通过同一应用边界组合验证。外部适配器在边缘模拟平台响应和故障，本地数据库与临时 Git 仓库使用真实实现。
3. **现有测试先例。** 当前工程只有设计文档和术语表，没有运行代码、测试框架或既有测试边界可复用。因此提出上述单一应用边界，不声称已有可运行的先例或已通过的测试。
4. **稳定性原则。** 测试断言用户可观察行为，内部重构不应导致无意义失败。时间通过可控制的时钟或调度入口推进，避免依赖长时间真实等待；不要使用真实模型输出的随机性作为日常自动化测试前提。
5. **筛选场景。** 覆盖原生 Type、标签回退、分类矛盾、无分类、Feature、PR 混入，以及分配人、标签交集和排除规则。匹配来源创建任务，跳过来源留下原因且不创建群或会话。
6. **首次同步与去重。** 覆盖历史积压、多页结果、重复页面、同步中断及再次启动。同一来源只产生一项持续任务；部分读取失败不能被当成来源关闭。
7. **快照行为。** 同一来源在配置变化后，已有任务继续按原条件运行，新来源按新配置判断。另行修改来源类型、标签或分配状态使其失配，验证暂停、通知及资源保留；条件恢复与服务重启均不自动恢复。
8. **来源更新。** 分别在待启动、执行中、待回复、待验收和暂停状态改变标题或描述，验证最新内容、追加说明与不自动开工的约定。
9. **并行隔离。** 同时启动多个匹配任务，验证各自工作目录、分支、群和会话的独立性；一个等待输入时其他任务继续。重复调度同一任务不得产生第二个执行者，不引入全局任务数量启动门槛。
10. **模板约定。** 从执行适配器接收到的实际启动输入验证用户原文、任务上下文和 skill 关联。更换业务 prompt 不需要增加 Freedom 专用分支；用通用的等待请求验证恢复和回复行为，不要求编排测试访问 Freedom。
11. **会话及请求路由。** 在多个任务中交错发送回复，验证原 thread 关联、当前轮次 steer、已结束轮次续接、请求匹配及过期回复处理。覆盖消息刚到达时轮次结束的竞争，不能丢消息、重复发送或串任务。
12. **附件场景。** 覆盖单张和多张截图、日志、同名文件、同一消息图文组合、重复下载事件、下载中断及恢复。验证 Codex 实际收到可读取的图片和文件，错误在任务群中可见；不能以文件名出现代替附件内容可读。
13. **状态真实性。** 覆盖原生问题请求、审批请求、正常轮次结束、无合法最终回报、执行失败和交付。待回复、待验收及失败可被区分；没有真实 PR 关联时不能仅凭模型声明标记交付成功。
14. **重启与外部操作不确定性。** 在任务已保存未启动、群创建成功未写回、消息已发出未确认、当前轮次执行中、等待用户、草稿 PR 已存在等边界注入故障。重启后核对实际结果，保留关联；无法核对时报告异常而不是重复执行。
15. **真实集成验证。** 在明确配置的测试仓库和飞书应用上验证实际采集、独立建群、Codex 会话创建、执行中追加文字、截图和日志读取、待决请求回复、重启续接及同一 PR 后续修改。平台模拟器测试通过不等于这些链路已经通过。
16. **业务行为与循环分离。** 初始 prompt 是否让实际执行 agent 在 Freedom 复现后正确等待，是任务执行层的验收。核心循环测试证明等待和消息传递正确，不用专用 Freedom 状态机代替业务 prompt 验证；实际实机验收按任务上下文另行执行。

## Out of Scope

- 多用户产品、团队审批机制和分布式多节点调度。
- Feature 任务的实际收集与执行流程；首版仅预留类型映射和模板注册能力。
- 模型判断 Issue 的处理价值、优先级或是否值得修复。
- 为每个任务创建独立机器人身份，或将所有任务放入同一个共享任务群。
- 全局任务并发上限，以及由循环实现的 Freedom 实例锁、设备队列、部署和重启策略。
- 在循环中硬编码复现、方案审批、修复和实机验证等业务阶段。
- 自动合并 PR、部署或关闭 Issue 作为任务交付后的固定步骤。
- 自动删除任务群、附件、工作目录、会话或历史数据。
- 同时实现 App Server 和 exec 两套执行后端，或直接修改 Codex 内部存储来伪造会话恢复。
- 语音、视频等未提出的消息形式，以及任意文件格式的通用解析能力。
- 在本次规格编写期间执行真实 Freedom 操作、接入生产环境或运行自动修复任务。

## Further Notes

- 本规格汇总已经确认的需求；测试边界也已单独确认。规格编写时，本地工程只有设计材料，没有运行代码、构建配置或既有测试。规格生成不代表功能已经实现或验证通过。
- 当前已核实的本机 Codex 协议具备会话续接、执行中输入、结构化最终回报、图片输入和 skill 输入能力。飞书租户权限、真实附件传递、离线补偿和恢复保证仍需实测。
- 实施接入需要具体 GitHub 账号、仓库与本地路径映射、基准分支、飞书应用和用户标识，以及运行配置。Freedom 的具体访问与操作信息由任务侧 prompt、skill 或对话提供。
- 技术方案以单一应用测试边界为约束；详细代码接口、数据库 SQL、依赖版本及完整故障核对方式在代码设计和实现阶段确定，不把本规格当作已经完成全部技术设计。
- 本规格使用 `ready-for-agent` 分诊状态。该状态只属于本规格的发布流程，不是运行中的 Bug 收集条件，也不重新引入用户已经排除的启动标签。
- 项目 tracker 已确认为本地 Markdown，本规格已发布到该 tracker。未创建远端 issue；这符合当前项目配置，不再是发布阻塞。
