# 任务范围记录与协调恢复验证

## 验证目标

本改动按任务提供记录，并修复稳定指令重载、重复完整历史检查、无效监督唤醒和单请求超时扩散。规格见[任务范围记录与协调执行恢复](../../.scratch/task-scoped-context/spec.md)。实现保持原 Task、Thread、资源、审批和未知输入身份。

## 基线与实现者验证

基线 cbd597ee9fa1c990f76466033076214d4dc95f03 的类型检查、构建和 534 项测试通过。实现者在 89834f81be2820efcdea2da3215d9f5a014e7eeb 完成类型检查、构建及 555 项完整测试，零失败、取消和跳过。

行为检查使用实际临时 SQLite、AgentLoop 和本地协议子进程。回归用例先在旧实现重现以下行为。

- A 的专属记录改变 B 的指令，且原 record 返回泄露 A 的记录正文。
- 动态项目回调为校验活跃 Turn 读取完整历史。
- 所有 Worker 均无可推进工作时仍生成监督输入。
- A 的读取或恢复超时使 B 及原生审批失效，缺失 A 使公共恢复失败。

旧行为的失败摘要与具体命令见[实现者验证记录](../../.scratch/task-scoped-context/execution/owner-results.md)。原始失败日志与完整通过日志保留在实施工作树，不作为源码提交。

首次独立验收在 2bed8d64 额外复现了一个遗漏。唯一成员 idle 且本轮 completed、无重试和 pending 输入、仅有 uncertain 输入时，仍生成一个监督提醒。该候选被判为 FAIL，没有运行后续真实模型探针或合并。不可把该轮完整测试通过视为最终验收。

后续修复在 5d1f880c 收紧可执行输入判断。相同外部编译产物脚本在旧候选失败、修复后通过，未知输入的状态与内容不变。新增 delivering-only、uncertain-only 及真实工作正向对照。实现者在修复后通过 112 项相关测试、类型检查、构建和 560 项完整测试。最终提交仍须重新独立验收。

## 可复跑检查

```sh
npm run check
npm run build
node --import tsx --test test/project.test.ts test/project-runtime.test.ts
node --import tsx --test test/project-codex.test.ts test/codex.test.ts test/codex-isolation.test.ts test/runtime.test.ts
npm test
```

场景覆盖同名记录隔离、明确 verifier 转交、范围授权、过滤后分页、无范围历史记录和旧回执重试。执行检查覆盖回调先于启动响应、失效 Turn 和 epoch、未知输入核对、原生审批、监督状态与回执的原子回滚、旧暂停重试、迟到恢复响应和逐 Thread 恢复。

合并前由未参与实现的验证者检查固定提交。独立结论与具体提交写入 PR，不将旧单元结论当作整个 PR 的验收。

## 证据边界

协议检查证明请求路径与状态处理，不代表生产响应时间。首次现场 Codex 内部阻塞的原因仍未证明。现有 Thread 历史不会清除，记录筛选不构成共享文件系统的访问隔离。结果未知的恢复仍保留不确定性。

本次 Git 交付不部署或重启服务，不迁移真实数据库，不向真实飞书群发送测试消息。实际服务启用与真实用户响应时间需要部署后的独立核对。
