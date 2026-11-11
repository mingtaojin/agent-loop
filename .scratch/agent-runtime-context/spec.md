# 持续上下文 Agent Runtime：首版规格

Status: ready-for-agent

## Problem Statement

用户希望围绕一件事情持续与 Agent 合作：开始可能只是讨论，后来才明确需要调查或实现；同一件事可能涉及多个代码仓库。用户需要在飞书中交流，随时补充文字、截图或日志，也希望 GitHub 上相关内容的变化能进入同一上下文，而不必手工搬运信息或重新解释背景。

当前 Agent Loop 以 GitHub Bug 为中心，把创建 Task、准备单仓库 worktree、启动修复和交付草稿 PR 绑定在一起。它还会根据群内命令或 Issue 收集条件的变化暂停工作。这样的模型不能自然承载没有明确目标的讨论、多仓库工作以及由 Agent 理解用户意图的持续合作。

用户需要一个轻量 Runtime，可靠保存任务上下文、传递输入、运行和恢复会话。具体如何澄清需求、调查问题、使用技能、修改代码和交付，应由 Agent 根据用户要求与已有授权决定。Runtime 不应逐渐变成另一套软件工程工作流。

## Solution

把 Task 定义为“一件事情的持续上下文”。用户可以从机器人私聊中明确新建 Task，提供一句话或材料即可；系统创建独立飞书任务群并关联持续的 Codex 会话，不要求先填写目标、仓库或验收条件。已有 GitHub 收集入口继续保留，纳入哪些 Issue 类型完全由配置决定。

每个 Task 对应一个独立任务群。用户在群里的消息始终进入原会话：有活跃执行时及时追加，没有活跃执行时启动新轮次。讨论回答后等待，没有新输入不自行续跑。用户明确交办工作后，由 Agent 持续推进，按需准备工程工作目录，并允许同一 Task 涉及多个仓库。

Runtime 转发 Agent 面向用户的进展和最终答复，提供绑定具体请求的原生工具批准或拒绝入口，并负责消息去重、持久化、历史补收及有限故障恢复。已关联 Issue 的更新与评论使用相同的追加和唤醒规则；Issue 关闭或不再符合原收集条件，不再由 Runtime 直接暂停任务。

Agent 决定工作流程、技能调用、问题澄清和交付形式。技术 Bug 默认自主定位、修复和验证；业务含义不明确或授权不足时，Agent 停下相关工作并询问。Runtime 不区分访谈阶段和开发阶段，不要求固定的 Freedom 复现确认步骤，也不要求最终成果必须是 PR。

首版聚焦飞书人工交办、GitHub Issue 收集与更新、Issue 评论和持续会话。暂不加入定时唤醒、PR／CI 自动事件接入，也不增加执行总时长硬限制。

## User Stories

1. As a user, I want a Task to represent the continuing context of one matter, so that discussion and later engineering work stay connected.
2. As a user, I want to create a Task before its goal is clear, so that I can explore an idea with the Agent.
3. As a user, I want to create a Task without first writing a GitHub Issue, so that informal requests can enter the system directly.
4. As a user, I want an explicit new-task entry in the bot's private chat, so that I can deliberately start a separate matter.
5. As a user, I want to provide an initial sentence or supporting material, so that task creation does not require a detailed form.
6. As a user, I want the initial input carried into the new Task, so that I do not have to repeat it in the task group.
7. As a user, I want each Task to have its own Feishu group, so that the destination of every reply is clear.
8. As a user, I want the shared application bot to serve all task groups, so that each Task does not require another bot identity.
9. As a user, I want group messages to remain in the group's Task, so that topic interpretation does not silently split or replace my context.
10. As a user, I want the same Codex conversation retained across turns, so that later work builds on earlier discussion.
11. As a user, I want creating a discussion Task to avoid preparing a repository worktree, so that an exploratory conversation does not start engineering work.
12. As a user, I want the Agent to prepare engineering workspaces when the work needs them, so that project access follows the actual request.
13. As a user, I want one Task to involve multiple repositories, so that a framework-and-plugin or frontend-and-backend change remains one matter.
14. As a user, I want task-owned changes isolated from unrelated local work, so that concurrent tasks preserve my existing files.
15. As a user, I want task and workspace associations retained after restart, so that recovery does not switch to unrelated code or lose ongoing work.
16. As a user, I want messages sent during execution appended promptly to that execution, so that I can correct or extend the request while work proceeds.
17. As a user, I want messages sent while the Agent is idle to start a turn in the original conversation, so that I can resume by simply speaking in the group.
18. As a user, I want the Agent to interpret all ordinary message content, including requests to stop, so that Runtime does not impose its own command semantics on my words.
19. As a user, I want a conversational answer to be followed by waiting, so that a discussion does not keep running without new input.
20. As a user, I want explicitly assigned work to progress continuously, so that I do not need to send a continuation message after every technical step.
21. As a user, I want a turn ending during input delivery to preserve that input in the same Task, so that a timing race does not lose my message.
22. As a user, I want duplicate message deliveries handled once, so that connection retries do not repeat my instructions.
23. As a user, I want to send original screenshots in the task group, so that the Agent can inspect visual evidence.
24. As a user, I want to send text log attachments, so that the Agent can inspect the underlying records.
25. As a user, I want attachments retained with their source messages outside engineering worktrees, so that evidence survives interruption and is not accidentally committed.
26. As a user, I want unsupported or failed attachments reported clearly, so that I know when the Agent has not received the complete evidence.
27. As a user, I want missed group messages recovered after a connection gap, so that temporary disconnection does not discard my feedback.
28. As a user, I want the Agent to choose its engineering skills and workflow, so that Runtime does not dictate how to solve the task.
29. As a user, I want technical Bugs diagnosed, fixed and verified autonomously within authorization, so that routine engineering does not require repeated confirmation.
30. As a user, I want unresolved business meaning clarified before dependent implementation, so that the Agent does not invent product behavior.
31. As a user, I want work requiring additional authorization to wait for that authorization, so that autonomous execution stays within my intent.
32. As a user, I want prior decisions and authorizations respected, so that I am not repeatedly asked the same questions.
33. As a user, I want clarification skills invoked by the Agent, so that Runtime does not manage an interview workflow.
34. As a user, I want delivery to follow my request and project conventions, so that an investigation, document, commit or PR can each be a valid outcome.
35. As a user, I want Runtime to preserve the Agent's result and evidence without inventing acceptance conclusions, so that transport status is not confused with business success.
36. As a user, I want the Task and group retained after a delivery, so that I can continue the same matter later.
37. As a user, I want the Agent's user-facing progress messages forwarded to the group, so that I can follow long-running work.
38. As a user, I want final answers forwarded faithfully, so that I can see the Agent's actual conclusions and limitations.
39. As a user, I want raw tool logs excluded from ordinary progress notifications by default, so that task groups remain readable.
40. As a user, I want GitHub collection rules to determine eligible Issue types, so that the Runtime is not restricted to Bugs by hardcoded behavior.
41. As a user, I want existing collection scope preserved unless its configuration changes, so that supporting other types does not unexpectedly start more work.
42. As a user, I want repository, assignee and label criteria to remain configurable, so that automated collection follows my chosen scope.
43. As a user, I want matching historical and newly discovered Issues collected without a mandatory extra launch label, so that explicit collection criteria are sufficient.
44. As a user, I want repeated collection to retain the original Task relationship, so that the same Issue does not create duplicate tasks or groups.
45. As a user, I want collection and execution to remain separate operations, so that saving a source is not reported as completed execution.
46. As a user, I want updates to an associated Issue delivered to its Task, so that the Agent receives corrected descriptions and changed source facts.
47. As a user, I want comments on the associated Issue delivered to its Task, so that relevant feedback does not remain isolated on GitHub.
48. As a user, I want source closure, assignment changes and label changes interpreted by the Agent, so that Runtime does not automatically stop an ongoing matter.
49. As a user, I want valid associated external events appended during execution and to wake an idle conversation, so that the Agent can react without my manual intervention.
50. As a user, I want external updates distinguished from my answers and approvals, so that an Issue change cannot silently satisfy a pending human decision.
51. As a user, I want repeated external events deduplicated, so that polling or delivery retries do not repeatedly wake the Agent for the same fact.
52. As a user, I want original source and message provenance retained, so that the Agent and I can trace incoming information.
53. As a user, I want native tool approval requests presented with explicit approve and reject actions, so that I can respond without copying request identifiers into chat.
54. As a user, I want each approval action bound to its actual pending request, so that approval cannot affect another task or operation.
55. As a user, I want duplicate and expired approval actions rejected, so that old controls cannot grant new permissions.
56. As a user, I want ordinary chat messages forwarded as conversation rather than interpreted as permission grants, so that message meaning and tool authorization remain distinct.
57. As a user, I want replies to native input requests to reach the waiting Agent reliably, so that a conversation does not appear responsive while remaining blocked internally.
58. As a user, I want Task, group, thread and message associations persisted, so that restarting the service does not require recreating the matter.
59. As a user, I want recovery to inspect existing execution before starting another, so that one Task never has two concurrent writers.
60. As a user, I want normal waiting preserved across restart, so that recovery alone does not manufacture a new reason to continue.
61. As a user, I want newly received inputs processed after recovery in the original Task, so that durable waiting does not hide new messages.
62. As a user, I want temporary execution failures retried a limited number of times after reconciliation, so that brief faults do not always require manual intervention.
63. As a user, I want exhausted recovery attempts reported with preserved diagnostic state, so that I can understand and address persistent failures.
64. As a user, I want unknown external side effects reconciled rather than blindly replayed, so that recovery does not duplicate submissions or operations.
65. As a user, I want an intentional stop respected, so that fault recovery does not restart work that was deliberately stopped.
66. As a user, I want long execution allowed without an elapsed-time hard stop, so that complex work can continue within one turn.
67. As a user, I want absence of progress messages alone to be insufficient evidence of failure, so that quiet but active work is not interrupted.
68. As a user, I want independent Tasks to progress concurrently without a global task-count cap, so that one Task waiting or failing does not block others.
69. As a user, I want runtime settings and credentials managed through configuration and protected environment inputs, so that project instructions do not contain operational secrets.
70. As a user, I want retained Task data migrated without losing existing conversations or workspaces, so that adopting the new model does not discard prior work.

## Implementation Decisions

1. **领域与职责。** Task 表示持续上下文，创建时不要求目标、仓库或验收条件。沿用一 Task 一群、持续 Codex Thread 的关联。Runtime 只处理输入、执行、等待、通知和恢复；不新增访谈、开发、验证或 PR 交付业务状态机。
2. **演进现有模块。** 复用现有 AgentLoop、Store、平台适配器、Codex 适配器与工作区能力。扩展现有接口以支持人工创建、Issue 评论、进展输出、审批操作和按需多仓库资源，不预设分布式调度服务或新的多 Agent 角色。
3. **任务数据。** 从必须具有 GitHub 来源、单仓库和单工作目录的模型，演进为可来自人工或 GitHub 的稳定 Task。保存任务群、Thread、输入与来源关联，并允许零个或多个工程资源关联。旧任务的群、Thread、分支、目录、来源快照和未处理消息需要保留并迁移。
4. **人工创建。** 飞书适配器增加机器人私聊中的明确新建入口，携带首条文字或材料创建 Task 和独立群。群内消息只路由至已绑定 Task，不通过语义分类自动拆分新任务。新建操作同样需要稳定身份与幂等处理。
5. **按需工作目录。** Task 初始化不强制调用工程 worktree 创建逻辑。会话可先使用独立的任务上下文目录，工程工作开始后再按需使用仓库目录。Agent 与工具负责选择仓库和组织工作，Runtime 提供并记录必要资源关联，不自动枚举或复制所有配置仓库。
6. **多仓库与授权。** 一项 Task 可以关联多个独立工程工作区，并保持同一会话。支持多仓库不等于获得额外修改权限；目录、项目说明及工具权限由实际执行环境约束。继续保护原始仓库中已暂存、未暂存和未跟踪的文件。
7. **输入契约。** 规范化的用户输入与已关联的有效外部事件保留来源、身份和证据。存在活跃轮次时追加；无活跃轮次时在原 Thread 启动新轮次。轮次结束与投递并发时重新核对投递状态，避免丢失或重复。
8. **消息含义。** 群内所有普通文字交给 Agent，包括停止指示及原先会被截获的工作控制命令。取消旧的基于消息文本进行暂停、恢复或业务状态转换的规则。服务退出、进程故障处理和明确审批操作仍是 Runtime 的执行管理职责。
9. **执行与等待。** 正常轮次结束不自动触发下一轮工程工作；新的有效输入才提供新的运行原因。新输入可以唤醒正在等待用户的 Task，但不能被当作尚缺的用户答复或授权。服务重启本身不唤醒正常等待；确认为故障中断的执行按恢复策略处理。
10. **结果协议。** 去掉最终报告必须选择待验收、必须提供 PR 等工程约束。保留可可靠辨识的执行结束、等待、错误、请求和用户可见结果信息；具体字段在适配器设计中确定。Runtime 不以模型结果或 Turn 完成替代业务验收，也不自行重写交付结论。
11. **工程指导。** 工程任务通过已安装的 poteto-mode 进入适当技能流程，澄清技能由 Agent 调用；不强迫普通讨论进入工程流程。移除旧 Bug 指导中固定的“实机复现后必须等待确认”门槛，改为已授权的技术工作自主推进、业务歧义或授权不足时澄清。既有用户决定与授权继续有效。
12. **收集与类型。** 移除只放行 Bug 的硬编码，纳入类型取决于收集配置。收集继续与执行分离，保留重复来源关联、历史积压收集及分类依据。配置未启用的类型不得因为本次改造自动纳入，不因类型不同在 Runtime 中写入固定处理流程。
13. **已有来源的变化。** 创建新 Task 时应用收集条件；已有来源不再匹配时，仍保存变化并将事实送入原 Task，不直接暂停、取消或要求重新满足条件才能继续。保留可追溯的创建时来源和筛选信息，不能将旧快照用于禁止新消息进入原会话。
14. **Issue 评论。** GitHub 适配器补充原 Issue 更新与评论读取、稳定事件身份和去重。新事实进入已关联 Task，不创建独立评论 Task。完整分页、恢复后的补收及投递结果核对复用现有可靠性模式；不将仅有重复抓取或无内容变化的观察变成新输入。
15. **进展与最终答复。** Codex 适配器向服务层提供 Agent 面向用户的进展和最终答复，通知器可靠转发到任务群。默认不逐条发送原始工具日志，不转发内部推理，不由 Runtime 判断工程阶段或生成业务总结。错误和未确认通知投递保持可诊断。
16. **原生审批。** 飞书增加绑定 Task、Thread 与实际原生请求的明确批准/拒绝操作。核对操作人、关联关系、请求有效性及重复操作，将结果返回相应请求；普通聊天内容不被自动转换成权限批准。沿用执行环境的权限机制，不自动扩大权限或批准请求。
17. **原生输入请求。** 普通聊天与原生问题回复的适配必须基于真实协议验证，避免已送达文字却无法解除原生输入等待。保留原消息与请求关联证据，不能把外部 Issue 事件映射成人工答案，也不为此引入访谈阶段状态机。
18. **持久化与执行所有权。** 继续使用本地 SQLite 保存任务关联、输入、输出和未确认操作。服务保持单实例所有权，同一 Task 同时最多一个活跃执行，不设全局任务并发数量上限；一个 Task 的等待或恢复失败不阻断其他 Task。
19. **故障恢复。** 对已确认的暂时性故障执行有限自动恢复，恢复前核对旧执行、输入投递和关联状态。达到配置的失败上限后保留现场并通知用户，不无限自动重试，不重放结果未知的业务操作，不把正常等待或用户主动停止视为故障。
20. **运行限制。** 不增加执行总时长硬上限。协议请求超时、故障重试计时和后台轮询可以继续存在，但不得借此固定周期结束正常 Turn。没有进展消息不能单独证明执行卡死。
21. **附件与配置。** 保留现有截图、UTF-8 日志、大小限制、下载失败反馈和原文件保留能力。允许人工讨论无需配置工程仓库或 Bug 模板即可创建 Task。凭证与运行参数继续由配置和环境提供，不写入全局说明、任务提示或新规格。
22. **技术证据边界。** 本机协议 Schema 支持创建 Thread 时省略工作目录以及后续轮次覆盖工作目录；本机飞书 SDK 提供卡片操作回调类型。这些事实支持方案可行性，但不证明会话目录切换、多仓库权限、项目说明加载、卡片回调或原生输入衔接已经通过真实验收。

## Testing Decisions

1. **主要测试边界。** 复用现有 AgentLoop 服务级入口作为主要自动化测试边界：向服务投递飞书与 GitHub 输入，驱动执行和恢复，观察用户收到的消息、Task/群/Thread 关联、实际工作目录和持久化结果。使用真实 SQLite 与临时 Git 仓库，只替换外部平台和执行器；不为每个内部函数新增独立测试接口。
2. **测试什么。** 测试可观察行为与不变量，而非私有方法调用次数、内部状态布局或固定字段排列。一次正常重构不应使验收测试失效；消息丢失、重复执行、串任务、错误批准、丢失上下文或破坏原文件必须使测试失败。
3. **已有测试依据。** 现有服务测试已覆盖收集、运行中追加、等待、附件、来源变化、重启和唯一执行；CLI 测试覆盖仅收集不启动外部执行；协议测试覆盖原 Thread 续接、过期请求、输入回执和中断；平台测试覆盖分页、来源事实、消息历史和资源下载；工作区测试覆盖真实 Git 隔离。优先扩展这些已有边界。
4. **新建与持续上下文。** 从明确人工新建入口发起一个没有目标或仓库的讨论，验证一 Task 一群一会话、初始材料保留、没有工程 worktree；讨论后等待，后续交办复用会话。明确创建另一 Task 时必须隔离上下文。
5. **多仓库。** 在同一 Task 内按需使用两个临时仓库，验证资源关联与原会话持续性，以及其他任务和原始工作区文件不被覆盖。重启后核对关联，不能自动把错误分支或目录重置成看似可用的状态。
6. **消息与输出。** 验证运行时追加、空闲时唤醒、轮次结束竞争、重复输入、断线补收、文字与附件完整投递。停止文字和旧工作控制命令作为普通消息进入 Agent。验证用户可见进展、最终答复和不含 PR 的正常结果；默认原始工具日志不刷屏。
7. **GitHub 输入。** 验证配置启用的非 Bug 类型能创建 Task、未启用类型不被额外纳入、旧配置范围不变。原 Issue 的内容、关闭、分配和标签变化及评论均进入原 Task；在执行时追加、空闲时唤醒，重复事件不重复执行。覆盖分页、补收与投递中断。
8. **更新旧行为测试。** 明确替换原来断言来源失配必暂停、等待时来源变化不唤醒、群内命令必被截获以及交付必须是草稿 PR 的测试。保留这些测试背后防止越权、丢失消息和串会话的不变量，不通过保留旧业务约束阻止新契约生效。
9. **审批与原生问题。** 验证真实请求关联、正确批准/拒绝、操作人核对、重复与过期操作。普通聊天不产生权限授予；外部事件不能冒充用户答复。原生阻塞与非阻塞输入需验证聊天确实到达可继续执行的原会话。
10. **恢复与限制。** 故障注入覆盖进程中断、临时连接失败、确认丢失和重复恢复。核对唯一执行与投递后有限恢复，超过配置上限产生可见错误；未知业务副作用不盲目重放，主动停止与正常等待不会被恢复机制唤醒。执行时长和静默本身不能成为终止依据。
11. **必要的协议测试。** 仅在服务级可控执行器不能证明协议正确性时，补充现有 Codex 与平台适配器契约测试；不使用可控执行器通过作为真实外部集成通过的依据。
12. **真实最小联调。** 在隔离测试目录和明确的测试会话中验证：飞书明确新建并收到独立任务群；Codex 讨论与工程目录使用保持原 Thread；运行中追加真实图片与文本日志；进展转发；真实卡片点击与过期处理；Issue 更新及评论进入原 Task；服务重启后关联保留。多仓库、项目说明加载、实际技能调用和原生输入请求需独立留存实际证据。
13. **验证报告。** 分别报告自动化测试、协议检查和真实联调的结果、限制及未完成项。历史上已有的 80 项测试通过仅作为旧实现基线，不能证明本规格的新能力已实现；硬件复现、业务修复或生产部署不属于 Runtime 测试通过的推论。

## Out of Scope

- 任务定时唤醒、Cron 发起新任务及 Agent 登记未来执行时间；普通轮询与故障重试计时不属于这项排除范围。
- 自动接入 PR 评论、PR 审查、合并状态或 CI 结果。用户在任务群发送相关链接或资料仍是正常输入。
- Runtime 管理 grill、设计、编码、验证等工程阶段，或复制 pstack 的执行流程。
- Runtime 判定业务规则、交付是否满足用户目标、何时合并或部署，或要求所有成果必须是 PR。
- 固定的实机复现后人工确认流程、专用于 Freedom 的调度状态机与资源协调规则。
- 执行总时长硬上限、定期强制切轮或无新输入时不断催促 Agent 继续工程工作。
- 通用多 Agent 平台、固定架构师/开发/测试角色、分布式队列、多实例调度或大型工作流引擎。
- 新的通知平台、复杂管理前端、自动拆分话题、共享任务群或每任务独立机器人身份。
- 自动删除 Task、会话、任务群或工程工作目录。
- 扩展压缩附件、其他日志编码等与当前需求无关的附件能力。
- 因扩大可配置类型而直接扩大实际收集范围、自动获得额外仓库权限，或自动批准原生工具请求。

## Further Notes

- 本规格综合本轮已确认的产品决策，不将 Freedom 上原始需求草案整体视为已接受要求。尤其是 Runtime 控制 grill、定时任务、PR/CI 接入和总运行预算，已按本轮讨论调整或排除。
- 本项目使用本地 Markdown tracker。此规格发布于现有功能目录，并应用 `ready-for-agent` 状态；本次发布不创建远端 Issue，也不修改应用运行时的 GitHub 收集配置。
- [领域术语表](../../GLOSSARY.md)、[持续上下文决策](../../docs/adr/0005-task-as-continuous-context.md)和[Agent 工作流职责决策](../../docs/adr/0006-agent-owns-workflow-and-message-intent.md)共同约束实现。
- [收集与执行分离决策](../../docs/adr/0002-separate-collection-from-execution.md)保留历史背景，其中旧来源暂停规则及固定 Bug 范围已有取代说明；[旧版规格](../agent-loop-v1/spec.md)保留为现有实现历史。冲突处以本规格及本轮明确决策为准。
- 原始讨论、Q1—Q10 答复及先前技术调查保存在[讨论存档](discussion.md)。本规格作为后续实施入口，讨论存档不再作为第二份活动规格维护。
- 验证边界按已讨论的可观察验收行为和现有服务级测试体系综合，不增加新的访谈或审批轮次。协议与 SDK 类型检查只是静态证据；真实联调结果必须另行记录，不能编造已通过的验收。
- 本次交付为规格发布，运行代码尚未按本规格修改。

## Comments

- 2026-11-05：根据已确认讨论使用 to-spec 发布正式规格，标记 ready-for-agent；保留讨论存档，未修改运行代码。
