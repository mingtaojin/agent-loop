# 任务范围记录与协调恢复验证

## 验证目标

本改动按任务提供记录，并修复稳定指令重载、重复完整历史检查和单请求超时扩散。协调者的唤醒遵循 main 的 PR #28，只处理明确事件，不生成定时监督。规格见[任务范围记录与协调执行恢复](../../.scratch/task-scoped-context/spec.md)。实现保持原 Task、Thread、资源、审批和未知输入身份。

## 整合前的候选证据

基线 cbd597ee9fa1c990f76466033076214d4dc95f03 的类型检查、构建和 534 项测试通过。实现者在 89834f81be2820efcdea2da3215d9f5a014e7eeb 完成类型检查、构建及 555 项完整测试，零失败、取消和跳过。

行为检查使用实际临时 SQLite、AgentLoop 和本地协议子进程。回归用例先在旧实现重现以下行为。

- A 的专属记录改变 B 的指令，且原 record 返回泄露 A 的记录正文。
- 动态项目回调为校验活跃 Turn 读取完整历史。
- 所有 Worker 均无可推进工作时仍生成监督输入。
- A 的读取或恢复超时使 B 及原生审批失效，缺失 A 使公共恢复失败。

旧行为的失败摘要与具体命令见[实现者验证记录](../../.scratch/task-scoped-context/execution/owner-results.md)。原始失败日志与完整通过日志保留在实施工作树，不作为源码提交。

首次独立验收在 2bed8d64 额外复现了一个遗漏。唯一成员 idle 且本轮 completed、无重试和 pending 输入、仅有 uncertain 输入时，仍生成一个监督提醒。该候选被判为 FAIL，没有运行后续真实模型探针或合并。不可把该轮完整测试通过视为最终验收。

历史候选修复在 5d1f880c 收紧可执行输入判断。相同外部编译产物脚本在旧候选失败、修复后通过，未知输入的状态与内容不变。新增 delivering-only、uncertain-only 及真实工作正向对照。实现者在修复后通过 112 项相关测试、类型检查、构建和 560 项完整测试。这些通过结论只适用于当时的候选。PR #28 后的整合删除整个 timer 路径，不能复用这些通过结论作为整合版验收。

## 可复跑检查

```sh
npm run check
npm run build
node --import tsx --test test/project.test.ts test/project-runtime.test.ts test/project-catalog.test.ts
node --import tsx --test test/project-codex.test.ts test/codex.test.ts test/codex-isolation.test.ts test/runtime.test.ts
npm test
```

场景覆盖同名记录隔离、明确 verifier 转交、范围授权、过滤后分页、无范围历史记录和旧回执重试。执行检查覆盖回调先于启动响应、失效 Turn 和 epoch、未知输入核对、原生审批、Task 暂停、历史自动输入的严格退役、迟到恢复响应和逐 Thread 恢复。

合并前由未参与实现的验证者检查固定提交。独立结论与具体提交写入 PR，不将旧单元结论当作整个 PR 的验收。

## 证据边界

协议检查证明请求路径与状态处理，不代表生产响应时间。首次现场 Codex 内部阻塞的原因仍未证明。现有 Thread 历史不会清除，记录筛选不构成共享文件系统的访问隔离。结果未知的恢复仍保留不确定性。

本次 Git 交付不部署或重启服务，不迁移真实数据库，不向真实飞书群发送测试消息。实际服务启用与真实用户响应时间需要部署后的独立核对。

## 原生探针的 intake 断言修正

85040d8 的独立原生探针在模型执行前失败。收集阶段实际保存 1 个协调者 execution 和 3 个合法 intake，旧脚本却要求总 Task 数为 1。cbd597e 和 PR #28 均保留这一旧断言。该失败不表示模型配额、认证或 Runtime 回归，证据保留在 `/tmp/agent-loop-final-acceptance-round2-20261114` 及当轮 `live-1794588948304-c9ef7ce5` 目录。

修正后的脚本要求同一组 4 个 Task/source 身份全程保留。派发前仅协调者可执行，101、102、104 为 pending/unbound intake。派发后仅 Issue 101 可以成为 Worker，102、104 保持 unbound、无 Thread/Turn 的 intake；路由完成后允许其从 pending 进入等待委派的 idle。完成和重启按这两个执行任务判断 idle，同时独立核对剩余 intake 未启动。原生工具、角色、marker、来源、只读、无重复副作用及重启证据断言保持。

实现者仅运行本地测试，不运行实际模型探针。整合后的固定提交仍由独立验证者进行编译产物与实际模型验收。

## 整合后的实现者检查

合入 2e7be2e 的事件模型并修正探针后，类型检查与构建通过。项目、catalog 和 probe 回归共 128 项通过，适配器、Runtime、service 与工作目录选择测试共 210 项通过，完整测试 602 项通过，零失败、取消和跳过。命令及本地日志路径见实现者验证记录。

此次还逐字核对 PR #28 的新增事件测试、`retireObsoleteInputs` 和 `src/store.ts`，确认保留上游实现。独立验证仍须针对整合后的固定提交重新执行，不能引用先前候选的通过结论。
