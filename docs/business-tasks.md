# 登记和组织业务任务

项目协调者通过 `project_action` 登记一项原始请求，再将多个 Worker 关联到同一业务任务。登记来源不代表用户批准实施。保留原始请求的范围、授权和待确认问题。

1. 查询已保存的原始来源和 `status` 的 `business_tasks` 部分。先检查是否已有相同工作。
2. 用原始输入 ID 登记业务任务。

   ```json
   {"action":"create_business_task","requestId":"register-dashboard","source":{"kind":"input","inputId":"saved-owner-message-id"}}
   ```

   返回值的 `businessTask.id` 是后续操作使用的业务任务身份。同一项目的同一原始来源重复登记会返回原业务任务，不会重写其来源或重开历史任务。

3. 从 `status` 返回的 `workerExecutionProfiles` 选定一个完整配置。派单时填写返回的 `businessTask.id`、工作说明和该配置。

   ```text
   {action:"dispatch",requestId:"dashboard-implement",businessTaskId:businessTask.id,
    prompt:"已确认的目标、范围、决定、验收和交付约定",execution:workerExecutionProfiles[0]}
   ```

   同一目标的验证 Worker 使用另一个 `requestId` 和相同 `businessTaskId`。相同 `requestId` 只用于完全相同内容的重试。

4. 要关联已有 Worker，调用 `assign_business_task`。

   ```text
   {action:"assign_business_task",requestId:"associate-existing-worker",
    businessTaskId:businessTask.id,taskId:"existing-worker-task-id"}
   ```

   关联保留原 Task、Thread、群、资源和原生请求。协调者不能加入 Worker 列表，Worker 不能同时属于两个业务任务。

5. 结束业务工作时，先查询最新业务版本，再单独记录业务结论。

   ```text
   {action:"set_business_task_lifecycle",requestId:"archive-dashboard",
    businessTaskId:businessTask.id,expectedVersion:businessTask.version,
    lifecycle:{kind:"historical",outcome:"delivered",summary:"已验收的业务成果"}}
   ```

   明确终止时使用 `outcome:"terminated"`。继续历史业务工作前，显式设置 `lifecycle:{kind:"active",summary:"继续工作的原因"}`。Worker 结束、Issue 关闭和新消息都不会改变业务生命周期。新派单要求业务任务处于活动状态，已接受派单的重试仍返回原 Worker。

## 其他来源选择

| 来源 | `source` |
| --- | --- |
| 项目内 Issue | `{kind:"issue",issueId:"GitHub node ID"}` |
| 归属本项目或已路由到本协调者的原始请求 | `{kind:"task-source",taskId:"original-task-id"}` |
| 协调者接收的原始用户输入或同项目 Worker 消息 | `{kind:"input",inputId:"saved-input-id"}` |
| 协调者编写的确切项目记录 | `{kind:"project-record",version:1,key:"goal-key"}` |

内部派单生成的 CLI 来源、提醒、恢复事件、原生审批和已丢弃输入不能作为原始目标来源。Worker 消息标记为协调者接收的目标，协调者记录标记为协调者编写的目标，两者都不自动成为用户决定。

飞书原始请求可以只有图片或文件。登记快照保留原始正文和按原顺序排列的附件描述，标题使用正文或附件种类、数量和文件名。标题不替代原始正文。旧快照缺少附件字段时表示当时未记录附件信息，读取、重试和生命周期更新不会补写该字段。

业务任务来自匹配的原始 intake 时，可在首次派单中显式填写 `intakeTaskId`。这会原地提升一次。后续 Worker 省略该字段，保留同一业务任务 ID。Issue 来源会自动赋予正确 Issue 成员关系；显式填写的 `issueId` 必须匹配。

旧 Worker 没有业务关系记录时，系统保持未知。标题、目录、前序 Worker 或相同 Issue 都不会触发自动迁移。Worker 查询 `business_tasks` 时只看到自己的关联和最小生命周期事实，不包含兄弟 Worker 或协调者原始材料。看板没有派单、归档或审批按钮。
