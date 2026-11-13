Status: ready-for-agent

# 任务专属资源与统一收尾

本规格综合当前会话已经确认的决定。产品问题和主测试边界均已确认。本次发布只整理规格，不实施业务代码、不执行删除、不部署。

实施更新（2026-11-14）：用户随后授权实现。本地实现已覆盖新产物目录、独立 closeout 账本、协调者完成与批次收尾、身份和进程占用保护、重启机械恢复及关联新 Task。类型检查、构建与完整测试 605/605 通过；19 项 Runtime 收尾测试使用真实 SQLite、文件、Git 和子进程，模型与飞书为受控替身。可使用 `npm run verify:closeout` 重跑。工具契约见 [任务收尾文档](../../docs/task-closeout.md)。尚未在真实业务实例执行清理或部署。下文保留规格发布时的范围和讨论记录。

## Problem Statement

AI 开发过程中会产生临时脚本、构建产物、日志、截图、视频、验收报告和临时工作树。这些文件分散在工程目录和系统临时目录中，任务结束后缺乏统一存放约定与明确负责人，是否删除依赖执行代理的临场判断。

用户希望任务结束能够释放该任务占用的空间。验收证据、已经完成交付的本地副本，以及已经交付、被替代或明确放弃的未合并代码，都无需默认长期保留。同时，清理不能影响项目正式成果、用户原始资料或其他工作正在使用的资源。

当前已有任务数据目录、工程资源关联、项目动作入口、SQLite 持久化和工作树释放能力。但一轮执行结束只表示运行空闲，缺少正式任务结束与全部专属资源收尾的契约；现有工作树释放也会拒绝未提交或未被基线保全的代码。

## Solution

每个 Task 获得专属产物目录，临时文件、构建产物和证据默认存放于该目录。必须放在目录之外的任务专属资源，登记实际位置、所属任务和释放方式。

项目协调者依据任务约定确认工作已完成或已明确终止后，发起任务收尾。Runtime 检查资源归属与实际使用情况，执行删除并保存清理回执。正常收尾不逐项要求用户再次确认。证据和未合并状态不再单独构成保留理由，唯一交付物必须先完成约定交付。

数据库保留任务内容、最终结果摘要、提交或交付地址和清理回执。正式结束后的追加工作作为新需求，由协调者创建关联的新 Task 承接。旧任务保留查询记录，已经删除的文件不恢复。

本机制只管理启用后按新约定分配、登记的新资源，历史遗留资源不纳入。长期协调者在每次派单或核查工作结束后，清理本次产生且不再使用的临时文件，保留项目记录和仍在使用的资源。

## User Stories

1. As a user, I want each Task to have a dedicated artifact directory, so that temporary files from different tasks remain distinguishable.
2. As a Worker, I want my task instructions to provide the artifact directory, so that I can place generated files in the intended location.
3. As a Worker, I want supported tools and build commands to default to task-owned output locations, so that cleanup does not depend only on remembering a prompt.
4. As a Worker, I want to register task-owned resources outside the artifact directory, so that build outputs and temporary worktrees can also be released.
5. As a Project Coordinator, I want to inspect registered resources and their ownership, so that I can determine the actual closeout scope.
6. As a Project Coordinator, I want to distinguish Task Completion from an execution turn ending, so that an idle Worker does not trigger deletion.
7. As a user, I want paused, failed, and awaiting-review tasks to retain their working resources, so that interruption does not discard ongoing work.
8. As a Project Coordinator, I want to explicitly initiate Task Closeout after confirming completion or termination, so that cleanup follows the agreed work outcome.
9. As a user, I want routine closeout to proceed without asking me to approve every file, so that tasks can finish autonomously.
10. As a user, I want temporary scripts, extracted files, and intermediate data removed at closeout, so that completed tasks stop consuming disk space.
11. As a user, I want reproducible build outputs removed at closeout, so that obsolete binaries and build directories do not accumulate.
12. As a user, I want logs, screenshots, videos, and verification reports removed after their task is finished, so that evidence does not become a permanent local archive.
13. As a user, I want local copies of delivered files removed after delivery, so that successful delivery does not leave redundant artifacts.
14. As a user, I want the only copy of a deliverable protected until delivery is complete, so that cleanup cannot erase the requested result before I receive it.
15. As a Project Coordinator, I want superseded or explicitly abandoned uncommitted changes to be eligible for closeout, so that obsolete work does not remain indefinitely.
16. As a Project Coordinator, I want superseded or explicitly abandoned unmerged commits to be eligible for closeout, so that merge status alone does not block cleanup.
17. As a user, I want eligible temporary worktrees and their task-owned local branches removed, so that isolated development resources do not accumulate after work ends.
18. As a user, I want the original project directory and landed source or documentation preserved, so that task cleanup does not remove formal project results.
19. As a user, I want my original attachments and source materials preserved, so that task cleanup only discards task-generated resources.
20. As a Worker, I want resources used by another Task protected, so that another task's closeout cannot break my work.
21. As a Project Coordinator, I want resources still in use to remain pending for cleanup, so that deletion does not interrupt active processes or verification.
22. As a user, I want resource paths and symbolic links checked against actual ownership, so that a misleading path cannot cause deletion outside the permitted scope.
23. As a Project Coordinator, I want project and role restrictions enforced on closeout operations, so that one caller cannot delete another project's resources.
24. As a Project Coordinator, I want the final task summary and delivery references retained, so that I can explain the outcome after local artifacts are gone.
25. As a Project Coordinator, I want a Cleanup Receipt for each resource, so that I can distinguish completed deletion, protected resources, and remaining failures.
26. As a user, I want business completion and cleanup completion tracked separately, so that an incomplete cleanup is not presented as finished.
27. As a Project Coordinator, I want interrupted cleanup to survive a Runtime restart, so that cleanup does not depend on the current conversation remembering it.
28. As a Project Coordinator, I want an uncertain deletion reconciled against actual resource state, so that a lost acknowledgement does not cause an incorrect success or an unsafe replay.
29. As a Project Coordinator, I want identical cleanup requests to be idempotent, so that retries do not perform conflicting work.
30. As a Project Coordinator, I want reuse of a request identity with different content rejected, so that a retry cannot silently change its deletion scope.
31. As a user, I want old cleanup requests isolated from later tasks, so that continued development cannot be deleted by delayed closeout work.
32. As a user, I want additional work after Task Completion handled as a new Task, so that a finished task remains finished.
33. As a Project Coordinator, I want a new Task to reference the old summary and delivery result, so that follow-up work retains useful context without restoring discarded files.
34. As a user, I want historical result questions answered from retained records, so that a question does not automatically restart development or create a new execution task.
35. As a Project Coordinator, I want effective follow-up Issue feedback routed for my assessment, so that I can create the appropriate new Task without reactivating the completed one.
36. As a user, I want existing historical artifacts excluded from this rollout, so that enabling the mechanism does not start an unsolicited disk cleanup.
37. As a Project Coordinator, I want new resources distinguishable from historical resources, so that upgrades cannot accidentally enroll old worktrees for deletion.
38. As a Project Coordinator, I want my own temporary files cleaned after each completed dispatch or inspection, so that a long-lived coordinator Task does not accumulate artifacts forever.
39. As a Project Coordinator, I want active resources and durable project records preserved during my own cleanup, so that routine housekeeping does not erase coordination context.
40. As a user, I want cleanup recovery to operate on explicit recorded instructions, so that elapsed time and execution silence do not become inferred completion decisions.
41. As a user, I want task-group and deployed-service lifecycles to retain their existing authorization boundaries, so that file cleanup does not silently dissolve groups or stop services.
42. As a Project Coordinator, I want tests to verify actual filesystem and Git outcomes through the Runtime boundary, so that a reported cleanup success reflects observable behavior.

## Implementation Decisions

### Task 专属目录与资源归属

- D1：沿用 Task 身份和现有任务数据目录基础，为任务提供专属产物位置。任务指导、工具入口和可配置的构建输出尽量使用该位置，减少只依赖提示词的约束。
- 由任务与工程资源管理能力记录目录外资源。每个可清理资源有稳定身份、所属 Task、所属项目、实际位置、资源类型及释放方式。身份和归属必须可核对，路径名称、扩展名和 ignored 状态不能单独证明可删除。
- 共享项目目录、全局依赖缓存和原始仓库不会因为任务使用过它们而成为任务独占资源。登记不得扩大调用方已有权限。

### 正式结束与收尾入口

- D2：协调者判断约定目标已完成或已明确终止，并通过现有 `project_action` 边界提交正式结束与收尾指令。Worker 的普通回复、工作汇报和结果消息都不自动表示任务结束。
- D7：任务正式结束的业务结论、当前执行状态和清理完成情况分别保存。运行空闲、暂停、失败、等待验收和一轮回复结束都不自动授权删除。
- 项目动作输入包含目标任务或资源身份、稳定请求身份和明确处理范围。Runtime 从绑定的 Thread 确定实际调用方，沿用项目成员与角色检查，不接受参数中伪造调用者或跨项目操作。
- Runtime 核对活跃执行、待处理操作、资源使用及其他任务引用后才执行释放。实际会话仍在使用的目录必须先安全退出使用状态，不能直接删除当前工作目录。
- 任务结束与清理指令的持久记录应能共同恢复，避免任务已经结束但清理意图丢失。对外状态包含总体结果、逐资源结果、剩余问题及可重试信息。

### 删除范围与保护范围

- D3：清理包括临时脚本、解压文件、中间数据、可重建产物、日志、截图、视频和验收报告。已经完成约定交付的本地文件副本同时删除，唯一交付物须先完成交付。
- D4：已经交付、被替代或随明确终止而放弃的未合并代码、未提交改动、任务工作树和本地任务分支可以删除。不因未合并或未提交状态默认长期保留，也不要求所有任务产物设置保留期。
- 工作树管理能力按正式收尾的授权范围支持上述删除。现有通用工作树释放的保守检查不应被无条件放宽，尤其不能把正式收尾的弃置授权带入普通释放调用。释放工作树和删除任务本地分支都需核对实际结果。
- D6：项目原始目录、正式项目成果、用户原始资料、其他任务资源和仍在使用的资源受到保护。符号链接和路径变化不得让清理跨出已核对范围。
- 对尚在使用的资源保留待清理状态。不得为了收尾擅自停止其使用者、扩大删除范围或把保护失败写成删除成功。

### 清理回执与恢复

- D5：SQLite 持久化保留任务内容、结果摘要、提交或交付地址和清理回执。任务生成的大文件不默认长期保留，完整工具输出不作为新的长期文件归档要求。
- D8：清理意图与逐资源结果持久保存。失败或尚未满足条件的项目保持待清理，Runtime 重启后继续核对和处理，不依赖模型会话记忆。
- 相同请求身份及相同内容重试返回原结果或推进原操作；相同身份携带不同内容报冲突。删除已经发生但回执丢失时先核对现场，目标已不存在且身份匹配可以记为该次释放完成。
- 清理请求绑定已登记的任务和资源身份。并发创建的新任务、新资源以及替换后的路径不能继承旧请求的删除授权。
- 删除失败不能导致任务结果、交付引用或待清理记录消失。恢复工作只推进已有明确指令，不增加主动定时模型监督，也不从时间流逝推断业务完成。

### 后续需求与启用范围

- D9：正式结束后的追加工作作为新需求，由协调者创建关联的新 Task 承接。新任务引用旧任务摘要、交付地址和相关背景，独立分配任务资源，必要时重新取证和构建。
- 已结束 Task 保留可查询记录。新增用户消息或关联 Issue 的有效反馈先交协调者判断，不自动重新启用原 Task；仅查询历史结果时不自动创建执行任务。
- D10：本次不扫描、补登记或回收历史任务遗留文件、构建产物和工作树。仅管理启用后按新约定分配、登记的新资源；现有任务的历史资源不因升级进入清理范围。
- D11：长期协调者每次派单或核查工作结束后，清理本次产生且不再使用的临时脚本、日志和下载副本，保留仍在使用的资源与轻量项目记录。协调者自身的这类清理不会结束整个项目协调 Task。

### 与现有契约同步

- 调整领域数据模型、SQLite 持久化、项目动作协议、Runtime 调度与恢复、工程资源释放以及协调者和 Worker 指导，使正式结束和收尾的含义一致。
- 更新既有规格与角色指导中默认保留验收证据及未保存成果的要求。任务结束前继续沿用同一 Task 的讨论、调查、开发和验收上下文，正式结束后由新 Task 承接后续工作。
- 保留现有项目成员检查、原生审批、群管理及部署授权边界。资源登记和收尾不授予删除远端资源、删除远端分支、解散任务群或停止运行服务的新权限。

## Testing Decisions

### 已确认的主测试边界

- 用户已确认，以现有 `project_action` Runtime 集成入口为主测试边界，验证任务创建、资源登记、正式结束、收尾、状态查询及重启恢复的完整行为。
- 测试使用真实临时文件、真实 SQLite 和真实临时 Git 仓库及工作树。模型和飞书使用受控替身，避免在业务仓库和真实任务群中执行破坏性测试。
- 测试从对外动作与恢复入口驱动系统，通过实际文件是否存在、保留文件内容、Git 工作树和分支状态、查询结果及清理回执判断结果。不以内部方法调用次数、私有字段或删除函数被调用作为完成证据。
- 复用现有 Runtime 项目动作测试夹具，并在涉及文件或 Git 删除结果的场景接入真实工程资源提供者。现有夹具中的目录替身和删除回执故障注入可作为组织方式的参考，不能代替对真实工作树及分支的检查。

### 必须覆盖的行为

1. 新任务获得专属产物位置；目录外资源登记后同样可以被查询和收尾。
2. 一轮完成、普通最终回复、`report` 结果、空闲、暂停、失败及等待验收均不会触发正式结束或删除。
3. 协调者正式结束任务后，符合范围的临时文件、构建产物、证据和已交付文件副本实际消失，保留的摘要和交付引用仍可查询。
4. 唯一交付物尚未交付时保持可读，并返回具体未完成问题。
5. 明确可弃置的未提交、未跟踪、ignored 产物及未合并代码可以随正式收尾释放，任务本地分支也被核对；普通释放调用仍保持原有保护范围。
6. 原始项目、已落地源码和文档、用户原始资料、共享目录及其他任务引用的资源保持原内容不变。
7. 非协调者越权、跨项目目标、错误资源归属和符号链接越界被拒绝，受保护资源没有部分删除。
8. 正在使用的资源保持待清理，使用结束后可继续处理；不通过强制停止运行服务来满足清理条件。
9. 部分删除失败、删除后回执丢失和 Runtime 重启时，恢复能核对实际资源状态，重复请求不扩大范围或丢失剩余工作。
10. 相同请求重复投递安全收敛；相同请求身份携带不同内容报冲突。
11. 清理与新输入、新资源分配并发时，旧请求只处理原资源，无法删除新 Task 的工作成果。
12. 已结束任务的后续开发由关联的新 Task 承接；原 Task 不重新投入执行，历史结果查询不自动创建执行任务。
13. 机制启用、重启和空闲检查都不会扫描、补登记或清理历史遗留资源。
14. 长期协调者一次派单或核查结束后，仅释放本次不再使用的临时文件，保留项目记录、活跃资源及后续工作产生的文件。
15. 文件收尾不附带解散任务群、停止部署服务或删除远端分支，也不恢复主动定时模型监督。

### 既有测试参考与验证限制

- 复用项目 Runtime 集成测试中的委派幂等、角色检查、SQLite 重启恢复、并发更新以及删除后回执丢失场景。
- 复用工程资源释放测试中的真实 Git 工作树、未提交改动、ignored 产物、独有提交和原始仓库保护夹具。新增正式收尾契约的同时保留普通释放的安全回归覆盖。
- 必要时沿用已有项目工具协议测试，核对动态工具 schema 与权威输入模型一致，以及原生工具与本机项目客户端进入同一项目动作处理逻辑。业务验收仍集中在 Runtime 主边界，不为私有辅助函数新增一套测试接口。
- 本规格没有执行任何新测试。未来受控替身测试通过不代表真实模型、飞书交互、现有业务任务清理或正式实例部署已经验收。

## Out of Scope

- 扫描、识别、补登记、迁移或删除历史任务遗留资源。
- 为已经结束的 Task 增加重新启用或反复重开的工作批次；后续工作使用新的关联 Task。
- 给所有证据和产物增加默认长期归档、回收站或统一保留期。
- 清理全局依赖缓存、用户原始资料、共享项目目录或没有可靠任务归属的文件。
- 删除远端分支或远端资源，解散任务群，停止已部署服务，以及新增部署授权。
- 通过文件名、目录名、ignored 状态、静默时长或运行空闲自动推断资源可删除。
- 为任意 shell 命令增加全新的文件系统沙箱，或承诺拦截所有未登记的目录外写入。此次采用默认路径、工具约定和显式资源登记。
- 实现固定 PR、合并或业务验收状态机，恢复主动定时模型监督，或调整与任务收尾无关的项目行为。
- 本轮业务代码实现、测试执行、提交、服务切换、部署，以及处理当前工作区的其他修改和合并冲突。

## Further Notes

- 本规格发布到本项目本地 Markdown issue tracker，标记 `ready-for-agent`。该状态表示需求充分，不表示已经实施、通过测试或完成部署，不创建远端 Issue。
- [ADR 0016](../../docs/adr/0016-task-closeout-releases-owned-resources.md)记录产物保留与正式结束边界；项目术语沿用领域词汇表中的 Task、项目协调者、任务专属资源、任务结束、任务收尾和清理回执。
- 已确认 Q1：正式结束后的追加工作按新需求创建关联的新 Task。已确认 Q2：不纳入历史遗留资源。已确认 Q3：长期协调者按每次派单或核查工作清理自身临时产物。
- 既有工程资源释放会拒绝含改动或未被基线保全的工作树，且不会删除分支。旧协调者规格和角色指导默认保留证据，实施时需要按本规格有范围地调整，不能把新决定描述成当前已有行为。
- [事件触发协调规格](../event-driven-coordination/spec.md)与本功能分别管理模型唤醒和已有清理指令的机械恢复。清理恢复不能被解释为重新引入定时模型监督。
- 规格发布只完成需求综合和本地文档更新。原始讨论与逐项确认记录保留在下方 Comments 中。

## Comments

- 2026-11-14：用户要求任务目录统一存放临时文件、构建产物和证据，由协调者在任务结束后收尾。
- 2026-11-14：用户询问验收证据、交付文件及未合并代码是否也不必保留，并确认按包含这些清理范围的方案推进设计。
- 2026-11-14：用户调用 grill-with-docs，要求检查剩余待确认点。本轮记录已确认决定并调查现有契约，业务代码尚未实施。
- 2026-11-14：针对 Q1，用户提出“是不是可以当作一个新需求来处理，不用沿用原来task”。采用该选择，记入 D9，原 Task 正式结束后追加工作由关联的新 Task 承接。
- 2026-11-14：针对是否回收历史任务遗留文件和工作树的 Q2，用户回复“不需要”。Q2 已关闭，历史资源不纳入本次机制，记入 D10。
- 2026-11-14：针对长期协调者在每次派单或核查工作结束后清理自身临时文件的 Q3，用户回复“采用”。Q3 已关闭，记入 D11。全部设计问题已确认，规格标记 ready-for-agent；尚未实施业务代码或执行清理。
- 2026-11-14：用户调用 to-spec，要求将当前讨论综合为正式规格并发布到本地 tracker。本文件按指定模板整理，保留已确认决定与原 Comments。
- 2026-11-14：按 to-spec 核对主测试边界，用户回复“符合，采用该边界”。采用现有 project_action Runtime 集成入口，使用真实临时文件、SQLite 和 Git，模型与飞书使用受控替身。

- 2026-11-14：实施采用独立 SQLite 收尾账本。首轮本地 605 项测试通过后，独立验收和只读审查发现已清理资源、消息路由及身份与原生请求边界遗漏，继续修复并补充回归。最终结果由实施验收记录给出，首轮通过不作为最终候选结论。
