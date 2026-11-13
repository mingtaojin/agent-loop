# 项目群交办与任务群验证

## 交付身份

PR25基于main `75e71405f7b12e121ba5b26642c8ac73d4bcc9e6`。
本分支通过merge保留PR17 `db85f353ad41771238b7c2069c18c03fbfaf3397` 的来源，最终head就是完整交付代码。
原PR17工作树与分支不用于本项开发，不再要求另应用组合补丁。

## PR17语义取舍

| 语义 | 最终行为 |
| --- | --- |
| 项目归属、配置与发现目录身份 | 保留。新正式Thread必须属于协调者或已委派成员。 |
| GitHub来源、评论、修订与catalog | 保留。只交协调者评估，不直接驱动Worker或回答原生请求。 |
| 接单记录与同Task晋升 | 保留。GitHub与历史请求保留身份、材料及已有回答。 |
| 未归属旧请求 | 协调者通过claim_intake引用本项目群实际用户决定，事务内原地认领，仍需显式dispatch。脱敏分页不暴露正文与材料路径。 |
| 首个本地项目协调群 | 由管理员显式projects登记初始化，发现目录不会自动为全部子目录建群。 |
| 历史Task、Thread、资源、暂停、失败与未知副作用 | 保留原地恢复。不会因移除入口删除或复制旧任务。 |
| CLI submit、answer及本机接单服务 | 按用户明确决定删除，不提供继续接单的兼容层。 |
| 私聊新请求、澄清回答及reply命令 | 按用户明确决定删除，receive直接忽略p2p。 |
| status --request-id | 保留旧CLI记录的只读查询，不接单。 |
| 内部project_action、project-client、workspace | 保留角色、项目、任务与原生权限边界。 |
| 原生审批callback和持久队列 | 保留。需要按钮时按需开群，普通问题交协调者。 |
| 每次派单自动任务群 | 由按需任务群替代。协调群继续保留。 |

## 可重复检查

先运行类型检查与构建：

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc
```

测试包含实际SQLite、真实CLI子进程与本地平台协议fixture。远端Feishu接口使用受控替身，不能作为真实群权限或部署验收。
完整套件使用项目约定的原子锁，并以 `--test-concurrency=1` 运行所有 `test/*.test.ts`。保持测试自身deadline和行为断言。

| 文件 | 保障 |
| --- | --- |
| test/submission.test.ts | CLI拒绝、帮助移除旧命令、旧回执只读、历史CLI材料和同Task恢复。 |
| test/platforms.test.ts | 实际socket事件私聊不接单、项目群保存与去重、SDK写边界。 |
| test/coordinator-intake.test.ts 与 test/project-catalog.test.ts | 项目责任、材料、同Task晋升及GitHub证据。 |
| test/project-runtime.test.ts | 无群委派、权限、原生审批、退役重建、冻结清单、未知结果恢复，以及启动时先核验资源再推进已保存Thread。 |
| test/intake-claim.test.ts | 空库显式初始化、无归属认领、双重认领互斥、事务回滚与重开、脱敏分页、catalog归属保护、接管期间旧handoff重核，以及迟到范围补充送达协调者。 |
| test/feishu-document-adapter.test.ts 与 test/feishu-document-progress.test.ts | 退役期间排队文档写入不得在等待结束后新dispatch，包括子节点读取后的删除。 |
| test/feishu-progress.test.ts | 卡片进度停止与新群重建。 |
| test/runtime.test.ts 与 test/workspace-selection.test.ts | 保存任务与目录答复恢复、附件、同Thread、原生请求及不确定输入。 |

`test/saved-intake.ts` 只用于恢复fixture，直接写测试数据库。生产代码不能通过私聊创建这些请求。claim_intake仅处理已经存在的合格记录。
`openDirectGroup` 让需要测群消息的fixture显式通过协调者开群。默认无群保障由独立的项目生命周期场景检查。

启动阶段先完成恢复，再启用输入推进和定时器。期间群消息与审批callback仍保存，不在资源核验前推进Thread。
内部 `acceptIntake` 接收正文和同一快照的version。提交时重核归属与快照，归属变化按正常接管处理；材料已更新时保留已选项目并重建正文，不占用完整材料的事件key。

## 验证边界

作者源码预检与行为测试不能替代独立verifier结论。每次源码更新都需要覆盖最终head的验证。
旧组合补丁与旧head通过记录保留为历史证据，不代表当前head通过。
本项没有部署、服务重启、真实飞书消息或群解散验收。清理工具只在fixture中执行。
