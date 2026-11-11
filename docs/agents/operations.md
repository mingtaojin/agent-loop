# 使用 launchd 启停本机 Agent Loop

本机常驻执行服务和调试网页由同一个 `run` 进程提供，统一由 launchd 管理。后续启动、停止和重启均使用本文命令，避免另起独立后台进程争用同一数据目录。前台调试前先停止 launchd 服务。

服务定义位于 `~/Library/LaunchAgents/com.local.agent-loop.run.plist`，标签为 `com.local.agent-loop.run`。工作目录是 `/Users/developer/IdeaProjects/agent-loop`，应用配置是该目录中的 `config.json`。运行参数和环境变量保留在服务定义与应用配置中，凭证由应用读取本地 `.env`。

服务随当前用户登录加载。断开 SSH 不影响运行，进程退出后由 launchd 自动拉起。机器重启后，服务在该用户登录时启动。

## 查看状态

```sh
launchctl print "gui/$(id -u)/com.local.agent-loop.run" | rg 'state =|pid =|last exit code ='
```

核对 `state = running` 和 `pid`。再在调试网页核对执行服务心跳，心跳 PID 应与 launchd 的 PID 一致，时间应持续更新。历史退出码不能代替当前心跳。

## 修改配置后重启

修改 `config.json` 或应用代码后，执行：

```sh
launchctl kickstart -k "gui/$(id -u)/com.local.agent-loop.run"
```

重启后检查状态和执行服务心跳，并确认已有任务保留原 Thread 和工程资源。使用原数据目录恢复，保留任务分支和 worktree。

## 停止服务

```sh
launchctl bootout "gui/$(id -u)/com.local.agent-loop.run"
```

服务定义启用了 `KeepAlive`，单独结束执行进程会触发自动重启。计划停止服务时使用 `bootout` 卸载任务。

## 启动已停止的服务

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.local.agent-loop.run.plist"
```

已加载的服务使用重启命令。修改 plist 后，先停止服务，再重新加载该文件。

## 查看日志

标准输出和错误输出都追加到项目中的 `data/logs/runtime.log`。启动事件 `started` 包含 `dashboard.url`、`dashboard.listenAddress` 和 `dashboard.networkUrls`。默认网页地址为 `http://127.0.0.1:8787`。

```sh
tail -n 80 -f /Users/developer/IdeaProjects/agent-loop/data/logs/runtime.log
```

## 处理独立后台进程冲突

升级前启动的独立 `dashboard` 进程可能占用网页端口，导致新 `run` 报 `EADDRINUSE`。先核对监听进程的启动命令和工作目录，确认属于本项目的旧网页服务后，发送 `SIGTERM` 并等待退出。新版本只通过 `run` 启动网页。

若日志反复出现 `已有 Agent Loop 进程使用此数据目录`，核对 launchd PID 与执行服务心跳 PID。两者不一致时，可能仍有独立后台进程占用数据目录。

1. 使用 `bootout` 停止 launchd 的重试。
2. 核对心跳 PID 对应的启动命令和工作目录。
3. 向确认属于本项目的独立执行进程发送 `SIGTERM`，等待退出。
4. 使用 `bootstrap` 启动 launchd 服务，再核对状态和心跳。

`data/runtime.pid` 可能在进程重启后过期，以 launchd 状态和数据库中的 `runtime-heartbeat` 为准。
