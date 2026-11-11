# 本地实时调试台

Status: ready-for-agent

## 工作项

- [x] Codex 实时事件投影与持久化，保留容量错误原文。
- [x] 独立只读 HTTP / SSE 服务，历史回放与断线续接。
- [x] 任务列表、搜索、状态、逐段输出、工具、消息、诊断与心跳。
- [x] 真实协议子进程、SQLite、HTTP / SSE 集成验证。
- [x] 浏览器交互、桌面与移动布局验证。
- [x] 最终类型检查、测试和构建。

## Comments

当前仓库没有 Git 元数据，不进行提交或推送。调试台不修改现有任务行为、模型选择、自动恢复或飞书通知规则。

2026-11-06：128 项测试通过，类型检查与构建通过。系统 WebKit 在桌面 1440px、窄屏 390px 验证实时片段、工具输出、容量错误、状态变化、过滤、最终消息去重、历史回放、任务隔离、非 HTML 文本及搜索；实际本机页面的空状态也通过验证。浏览器结果位于 ../verification/browser-results.json，复查命令为 python3 .scratch/debug-dashboard/verify-webkit.py。

2026-11-06：按用户要求支持 dashboard.host=0.0.0.0，实际配置已启用，129 项测试、类型检查与构建通过。任务执行服务和调试台以独立后台进程启动；日志位于 data/logs。失效的 opentest_1/OpenTest-Internal 配置已修正为远程与基准分支均匹配的 /Users/developer/IdeaProjects/opentest/OpenTest-Internal，保留仓库现有修改。
