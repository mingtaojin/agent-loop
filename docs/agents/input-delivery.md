# 终止已由后续指令接替的未知投递

`supersede_input` 只终止一条旧输入的后续投递。原消息、出处、顺序、`uncertain` 状态和错误保持不变。独立审计记录说明哪条已保存指令接替了它，不证明旧输入已经送达或确定失败。

仅在用户明确批准处置具体输入后使用。项目协调者判断授权的业务含义；Runtime 验证调用身份、授权来源及技术前提。引用用户消息不会绕过原生工具审批，也不能用于重放未知副作用。

## 检查前提

- 调用者是该项目当前协调者，目标是同项目的 Worker 或 verifier。
- 目标任务已通过 `control pause` 显式暂停，原 Thread ID 与请求完全相同。自动恢复、任务请求和原生审批均没有待决项。
- 原生 Thread 已确认处于 idle 或 completed，且没有待决原生请求。若历史证明旧输入已接纳，按正常历史核对处理，不能人工终止为未送达。
- 旧输入是 `uncertain` 的普通用户消息，属于正式任务路径，并未关联原生问题。initial、目录选择、审批和 delivering 状态不适用。
- 接替输入已保存于同任务，顺序在旧输入之后，仍为 pending 或 held。它来自配置用户，或来自当前项目协调者的 instruction。Runtime 不删除、去重或重排其他消息。
- 授权引用是协调者自己 inbox 中已 delivered 的配置用户消息。Agent 转述、来源事件和未投递用户消息不满足该来源校验。

## 提交处置

保留一个稳定的 requestId。协调者通过 `project_action` 调用下列结构。使用真实 ID 替换占位符，每次只处理一条输入。

```json
{
  "action": "supersede_input",
  "requestId": "<stable-lowercase-uuid>",
  "taskId": "<original-task-id>",
  "threadId": "<original-thread-id>",
  "inputId": "<uncertain-input-id>",
  "successorInputId": "<later-saved-effective-input-id>",
  "authorizationInputId": "<delivered-user-authorization-in-coordinator-inbox>",
  "reason": "用户已确认后续有效指令接替，旧消息不再投递。",
  "evidence": "原失败回执、原生完整历史核查及用户批准来源的可复查位置。"
}
```

若旧 Thread 的动态工具 schema 不支持新 action，使用已部署版本的 `project-client.js` 和协调者自身的任务能力文件提交同一 JSON。采用 Runtime 注入的客户端命令，不读取、复制或使用其他任务的能力内容。不要使用旧部署目录中的客户端，它可能尚不认识该 action。

调用在 Runtime 唯一 Store writer 和目标任务串行队列内执行。保存前再次核对原生静止状态。Runtime 自行填写项目、调用 Task、时间、观察 Turn、原错误及原输入摘要，调用者不能伪造这些字段。

相同请求重试返回同一审计结果。若已写入审计但项目回执未保存，重试仍从已保存审计恢复，不再次执行操作。不同内容复用 requestId，或以另一操作覆盖同一输入，都会被拒绝。

## 核对后恢复

处置成功后目标仍暂停，不会在该调用中发起新 Turn。用项目 status、CLI status 或 dashboard 输入 API 核对 disposition，同时检查原输入仍为 uncertain、原错误仍在、后续输入均保留。

核对当前有效授权后，再通过原有 `control resume` 恢复同 Task。Runtime 在原 Owner 的指令中提示先核对现有工作和副作用；后续同文输入照常保留。重复指令不表示可以重复回退提交、重复部署或重复执行其他业务效果。

没有处置记录的 unknown 继续阻塞。审批和出站通知的 unknown 不受此入口影响。原始输入结果不会因人工处置变为 delivered 或 failed，恢复到旧版本也不会重放该旧输入。

## 启用和回滚

先对准确候选版本完成隔离测试和独立验证，再取得启用确认。按 [服务操作说明](operations.md) 切换构建入口并重启唯一 Runtime，核对进程、心跳、Thread 和资源。CLI 本身不提供外部数据库写入入口。

操作前核实目标进程实际归属的 launchd Label、定义路径和入口。机器上可能运行多个 checkout，不能直接沿用通用说明中另一个实例的服务标签。

如果运行版本含尚未进入 main 的其他功能，先在独立候选中集成本修复并测试，不能直接用 main 的构建替换它。重启会影响全部活跃执行，必须先核对当时的任务状态；不要把隔离子进程测试当作生产重启验证。

回滚时恢复原构建入口，保留现有数据库和全部审计。旧版本忽略新的 meta 审计键，会重新在原 uncertain 输入处阻塞，保持不重放。已经处理过的后续指令和业务效果不会因代码回滚而撤销。不要恢复旧数据库快照覆盖新消息，也不要删除审计来尝试反向处置。重新启用修复后核对既有审计和当前业务状态，再继续同 Task。
