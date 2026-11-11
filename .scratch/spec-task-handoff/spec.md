Status: ready-for-agent

# 通用 CLI 任务提交与 Agent 任务交接

## Problem Statement

用户在一个 Agent Loop 任务中经过多轮讨论，已经形成规格、工单和决定，希望另开一个任务开展开发。当前任务群消息始终续接原 Task，缺少可供原 Agent 调用的新任务提交入口。用户需要重复搬运材料，原 Agent 也无法直接把整理好的 prompt 交给一个独立任务。

## Solution

Runtime 提供通用 CLI 提交入口，接收调用方准备好的 prompt，创建独立 Task，并沿现有流程建立任务群、选择工程入口和创建正式 Thread。原 Agent 根据用户意图自行总结 prompt，调用 CLI，再向用户报告新任务。

提交能力适用于任意任务说明。Runtime 只负责通用接收、保存和执行，不解析规格或工单的业务含义，不代替 Agent 总结原对话。

## User Stories

1. As an Agent Loop 用户, I want 在原任务中要求新开开发任务, so that 我可以保留讨论上下文并独立开展开发。
2. As an 原任务 Agent, I want 通过 CLI 提交新任务 prompt, so that 我可以直接完成用户要求的任务交接。
3. As an 原任务 Agent, I want 自行决定 prompt 包含的背景和工作范围, so that 交接可以适应不同任务。
4. As an 原任务 Agent, I want 在 prompt 中引用已有规格和工单, so that 新任务能找到已确认的开发依据。
5. As an CLI 调用方, I want 从文件提供多行 prompt, so that 长任务说明无需复杂的命令行转义。
6. As an CLI 调用方, I want 从标准输入提供 prompt, so that 我可以与现有工具组合使用。
7. As an CLI 调用方, I want prompt 的文字、换行和 Unicode 内容完整保存, so that 限制条件和原始表达不会丢失。
8. As an CLI 调用方, I want 空白或格式无效的输入得到明确错误, so that 不会创建空任务。
9. As an CLI 调用方, I want 提交成功返回机器可读的任务身份与状态, so that Agent 可以报告或查询新任务。
10. As an CLI 调用方, I want 使用稳定请求身份重试提交, so that 回执丢失后不会重复创建任务。
11. As an CLI 调用方, I want 同一请求身份提交不同内容时收到冲突, so that 重试不会悄悄改变已受理任务。
12. As an 用户, I want 主动再次提交同样文字时仍可创建另一任务, so that 内容相同不等于同一次请求。
13. As an 用户, I want 新任务拥有独立任务群和正式 Thread, so that 新任务执行不会续接或覆盖原会话。
14. As an 新任务 Agent, I want 接收原 Agent 提交的完整 prompt 和统一任务指导, so that 我可以按交办范围开展工作。
15. As an 用户, I want 新任务复用现有工程选择和执行流程, so that CLI 来源与飞书、GitHub 来源具有一致的运行行为。
16. As an 用户, I want 新任务的答复、问题和审批沿用现有飞书通道, so that 我可以继续在新任务群协作。
17. As an CLI 调用方, I want 不依赖平台凭证提交任务, so that 凭证继续由常驻 Runtime 管理。
18. As an CLI 调用方, I want Runtime 未运行或正在停止时收到明确结果, so that 我不会把未受理请求当作成功。
19. As an 用户, I want 并发提交和服务重启后仍保留任务与输入身份, so that 不会出现重复群、重复 Thread 或丢失 prompt。
20. As an 维护者, I want 原有来源、历史任务和只读调试台继续正常工作, so that 新入口不会破坏既有任务。
21. As an 原任务 Agent, I want 在正式任务环境说明中发现可调用的 CLI, so that 我无需自行猜测命令和配置位置。

## Implementation Decisions

- 增加独立的 CLI 来源判别式，保存提交身份、prompt 和提交时间。CLI 输入不伪装成飞书所有者消息或 GitHub 事件。
- 原 Agent 负责交接 prompt 的全部内容选择。Runtime 不引入规格扫描、聊天摘要、文档复制或父子任务编排。
- 提交客户端将请求交给当前数据目录对应的常驻 Runtime。Runtime 保持该数据目录唯一写者，CLI 不启动第二个执行者。
- CLI 支持文件和标准输入，边界负责严格 UTF-8、非空和请求大小检查，保存时保留输入原文。
- 每次提交具有稳定请求身份。相同身份与相同内容返回原任务，不同内容产生冲突；主动新建使用不同身份。
- 新来源接入统一 Task 准备与执行流程。任务持久化与首条输入作为一次受理动作完成，执行由现有生命周期推进。
- CLI 返回的成功表示 Runtime 已受理并持久化任务，不表示开发完成或已验收。任务准备尚未完成时通过身份查询后续状态。
- 来源显示、任务标题、调试网页、进度文档和首轮投递完整支持新来源。历史来源与原会话身份保留。
- 新任务使用独立正式 Thread，收到提交的 prompt 和现有统一任务指导。来源材料不会自动扩大操作授权。
- 正式 Agent 的环境指导提供准确的 CLI 调用信息。命令、参数、配置位置和本机通信细节由实现统一确定。
- 提交通道仅供本机使用，并在边界验证调用身份和输入。启停、失败清理和重启遵循现有单实例所有权。
- 本次实现和验收使用隔离数据目录，不向现有生产任务群发送测试消息，也不重启现有常驻服务。

## Testing Decisions

- 主验证边界为实际 CLI 子进程调用隔离常驻 Runtime。任务状态和输入使用真实 SQLite，平台沿用现有飞书与 Codex 替身。
- 测试只断言外部行为，包括提交回执、任务数量、prompt 原文、独立群与 Thread、首轮输入和后续答复路由。
- 覆盖文件及标准输入、多行与 Unicode、空白及无效 UTF-8、稳定身份重试、冲突、并发、服务不可用和重启恢复。
- 复用现有 CLI 生命周期测试、持续会话 Runtime 测试与真实 SQLite 测试的模式。只在无法由主边界验证的协议拒绝行为补充局部测试。
- 对旧来源运行现有回归检查，确认历史任务解析、工程选择、输入投递、输出显示和只读 Dashboard 保持既有行为。
- 完成静态检查、构建和适当测试后，由独立验证者在隔离环境操作实际 CLI。隔离平台验收与真实飞书发布分别报告。

## Out of Scope

- Runtime 自动扫描或解析规格、工单，自动总结旧会话，或制定交接材料模板。
- 复制完整聊天历史、自动同步文档变更、文档版本快照和父子任务状态编排。
- 通过聊天关键词由 Runtime 截获并直接创建任务。交接意图由原 Agent 理解，再调用 CLI。
- 外网提交服务、额外 Dashboard 写入口、新的执行后端或分布式任务系统。
- 自动提交 Git、创建远端 Issue、发布 PR、合并或部署。
- 本次修改正式服务配置、重启正式常驻服务或向真实飞书群提交验收任务。

## Further Notes

用户已确认主要交接入口是在原任务中明确提出要求，并明确 Runtime 只需提供通用提交 CLI，由原 Agent 自行生成 prompt。交接材料的选择不再作为 Runtime 的产品分支逐项确认。

正式规格已发布到本项目的本地 Markdown tracker，使用 ready-for-agent 分诊状态。用户随后明确授权将规格交给 poteto-mode 开发。验证采用最高层 CLI 提交边界，本轮按已授权范围直接开展实现，不重复访谈。

此前讨论与已核对的源码事实保留在同功能目录的讨论存档中。既有 Agent 决定工作流程的架构决策继续适用。

## Comments

- 2026-11-11：根据已确认对话通过 to-spec 发布正式规格及实现工单，交由 poteto-mode 开发。完成设计与源码验证后记录实际结果。
- 2026-11-11：通用 CLI 提交与请求身份查询已实现。静态检查、构建、334 项完整测试和 13 项构建入口行为测试通过。独立 DeepSeek 验证者操作源码与构建后的实际 CLI，各通过 10 项隔离验收检查。验收使用真实 SQLite 和受控飞书、Codex 端口；正式服务未重启，未进行真实飞书发布验收。证据见 execution/acceptance-report.md。
