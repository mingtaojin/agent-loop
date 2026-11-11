export const dashboardHtml = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Loop · 调试台</title><link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head>
<body><div class="shell">
  <aside class="sidebar">
    <a class="brand" href="/"><span class="brand-mark">a<span>↗</span></span><span>agent loop<small>LOCAL OBSERVATORY</small></span></a>
    <div class="sidebar-heading"><span>任务</span><span id="task-count" class="count">0</span></div>
    <label class="search"><span>⌕</span><input id="search" aria-label="搜索任务" placeholder="搜索名称、任务 ID…"></label>
    <select id="status-filter" aria-label="筛选任务状态"><option value="">全部状态</option><option value="running">执行中</option><option value="idle">等待输入</option><option value="failed">执行失败</option><option value="paused">已暂停</option><option value="pending">待启动</option></select>
    <nav id="task-list" aria-label="任务列表"></nav>
    <div class="sidebar-footer"><div><span id="runtime-dot" class="dot"></span><strong id="runtime-status">读取服务状态…</strong></div><p id="runtime-detail">等待心跳</p><span class="footer-label">数据目录</span><code id="data-dir"></code></div>
  </aside>
  <main><header class="topbar"><div><span class="eyebrow">DEVELOPMENT</span><span class="topbar-title">运行观测</span></div><div class="connection"><span id="connection-dot" class="dot"></span><span id="connection-text" role="status">正在连接</span><span class="local-tag">调试 · 只读</span></div></header>
    <section class="overview"><div><h1>看见每一步执行<span>。</span></h1><p>模型输出、工具调用与执行异常，在同一个地方追踪。</p></div><div class="metrics"><div><strong id="metric-running">0</strong><span><i class="dot green"></i>执行中</span></div><div><strong id="metric-idle">0</strong><span><i class="dot"></i>等待输入</span></div><div><strong id="metric-failed">0</strong><span><i class="dot red"></i>执行失败</span></div></div></section>
    <div id="page-error" class="banner error" role="alert" hidden></div>
    <section id="empty" class="empty-state"><div class="empty-icon">↳</div><h2>等待第一个任务</h2><p>启动 Agent Loop 后，直接私聊飞书机器人发送 <code>文字、图文、截图或日志文件</code>，无需命令前缀。<br>每条不同的非空私聊消息各自创建独立任务群，后续在对应群继续。已有任务会自动出现在这里，无需刷新页面。</p><div class="empty-note">调试台已就绪 · 读取同一配置的数据目录</div></section>
    <section id="task-panel" hidden>
      <div class="task-heading"><div><div class="task-heading-line"><span id="source-kind" class="eyebrow"></span><span id="task-badge" class="badge"></span></div><h2 id="task-title"></h2><div class="task-identifiers"><code id="task-id"></code><span id="updated-at"></span></div></div><a id="source-link" class="source-link" target="_blank" rel="noreferrer" hidden>查看 Issue ↗</a></div>
      <div id="task-alert" class="banner" hidden></div>
      <details class="metadata"><summary>会话与工作目录 <span id="execution-status"></span></summary><dl id="metadata-list"></dl></details>
      <div class="console"><div class="console-toolbar"><div class="tabs" role="tablist" aria-label="记录视图"><button class="tab active" id="tab-live" role="tab" aria-selected="true">实时输出<span class="live-dot"></span></button><button class="tab" id="tab-history" role="tab" aria-selected="false">消息记录</button><button class="tab" id="tab-diagnostics" role="tab" aria-selected="false">诊断</button></div><div class="console-actions"><label><input type="checkbox" id="auto-scroll" checked> 跟随输出</label><button id="copy" class="quiet-button">复制记录</button></div></div>
        <div id="live-toolbar" class="live-toolbar"><div id="event-filters"><button data-filter="all" class="filter active">全部</button><button data-filter="agent" class="filter">模型</button><button data-filter="tool" class="filter">工具</button><button data-filter="error" class="filter">错误</button></div><span id="event-count">0 条事件</span></div>
        <div id="output" class="output" aria-label="实时执行输出" tabindex="0"></div><div id="history" class="output history" hidden></div><div id="diagnostics" class="output" hidden></div>
        <footer class="console-footer"><span id="stream-status">等待选择任务</span><span id="last-event">完整消息与逐段输出均会保留</span></footer>
      </div>
    </section>
  </main></div></body></html>`;

export const dashboardCss = String.raw`
:root{color-scheme:light;--bg:#f7f8fa;--surface:#fff;--line:#e6e9ed;--text:#202833;--muted:#7a8492;--green:#16846a;--blue:#456be8;--red:#d14c51;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;font-size:14px}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}button,input,select{font:inherit}button,a,input,select,summary{outline-offset:4px}button{cursor:pointer}button:disabled{cursor:default}a{color:inherit;text-decoration:none}[hidden]{display:none!important}.shell{display:flex;min-height:100vh}.sidebar{width:276px;flex-shrink:0;background:#fff;border-right:1px solid var(--line);height:100vh;position:sticky;top:0;display:flex;flex-direction:column;padding:28px 18px 18px}.brand{display:flex;gap:12px;align-items:center;padding:0 10px 36px;font-size:21px;font-weight:650;letter-spacing:-.7px}.brand small{display:block;letter-spacing:1.6px;font-size:8px;color:var(--muted);margin-top:5px;font-weight:600}.brand-mark{background:#24352f;color:#e4f6ba;width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:25px;position:relative}.brand-mark span{font-size:17px;position:absolute;right:3px;top:1px}.sidebar-heading{display:flex;justify-content:space-between;align-items:center;padding:0 11px 15px;font-weight:600}.count{font-family:var(--mono);font-size:11px;background:#f1f3f5;color:#7b8591;padding:3px 7px;border-radius:5px}.search{display:flex;align-items:center;gap:8px;background:#f7f8fa;border:1px solid var(--line);border-radius:7px;padding:8px 10px}.search>span{font-size:21px;line-height:1;color:var(--muted)}.search input{width:100%;border:0;background:none;outline:none;font-size:12px;min-width:0}select{margin:10px 0 18px;border:1px solid var(--line);border-radius:6px;padding:7px 8px;background:white;color:#677180;font-size:12px}#task-list{flex:1;overflow:auto;min-height:100px}.task-item{display:block;text-align:left;width:100%;border:1px solid transparent;background:none;border-radius:8px;padding:13px 11px;margin-bottom:5px;color:var(--text)}.task-item:hover{background:#f5f7fa}.task-item.selected{background:#edf3f0;border-color:#dae7e0}.task-item-top{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--muted);margin-bottom:8px}.task-item-title{display:block;font-weight:550;line-height:1.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.task-item-id{display:block;font-size:10px;color:#9ba3ad;font-family:var(--mono);margin-top:7px}.sidebar-empty{color:var(--muted);font-size:12px;text-align:center;padding:25px 5px;line-height:1.8}.sidebar-footer{border-top:1px solid var(--line);padding:18px 10px 0;font-size:11px}.sidebar-footer>div{display:flex;gap:8px;align-items:center}.sidebar-footer strong{font-weight:500}.sidebar-footer p{color:var(--muted);margin:7px 0 19px;padding-left:15px;line-height:1.7}.footer-label{display:block;font-size:10px;color:#9ba3ad;margin-bottom:6px}.sidebar-footer code{display:block;word-break:break-all;font-size:10px;line-height:1.7;color:var(--muted)}main{flex:1;min-width:0;padding:0 42px 36px;max-width:1800px}.topbar{height:77px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line)}.eyebrow{font-size:10px;font-weight:650;letter-spacing:1.4px;color:var(--muted)}.topbar-title{font-size:12px;color:#5d6876;margin-left:20px}.connection{display:flex;align-items:center;gap:7px;font-size:11px;color:#687382}.local-tag{font-size:10px;background:#edf0f3;border:1px solid #e2e6eb;border-radius:5px;padding:5px 8px;margin-left:12px;color:#6a7684}.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#a7b0bc;flex-shrink:0}.dot.green{background:var(--green);box-shadow:0 0 0 3px #16846a0d}.dot.red{background:var(--red)}.dot.amber{background:#ca922b}.overview{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:35px 0 32px}h1{font-size:26px;letter-spacing:-.8px;margin:0;font-weight:600}h1 span{color:var(--green)}.overview p{font-size:12px;color:var(--muted);margin:12px 0 0}.metrics{display:flex;gap:34px}.metrics>div{display:flex;flex-direction:column;gap:8px;min-width:55px}.metrics strong{font-size:27px;font-weight:500;font-variant-numeric:tabular-nums}.metrics span{font-size:10px;color:var(--muted);white-space:nowrap;display:flex;align-items:center;gap:7px}.task-heading{display:flex;justify-content:space-between;gap:20px;align-items:center;border-top:1px solid var(--line);padding:24px 0 18px}.task-heading-line{display:flex;gap:12px;align-items:center}h2{font-size:20px;font-weight:600;margin:12px 0;line-height:1.5}.badge{font-size:10px;color:var(--green);background:#e8f3ee;padding:4px 7px;border-radius:4px;white-space:nowrap}.badge.failed{color:var(--red);background:#fceced}.badge.idle,.badge.pending{background:#edf0f4;color:#6b7685}.badge.paused{color:#9c741f;background:#faf1dd}.task-identifiers{display:flex;gap:16px;color:#98a1ac;align-items:center;font-size:10px}.task-identifiers code{font-family:var(--mono)}.source-link{border:1px solid var(--line);border-radius:6px;padding:8px 11px;font-size:11px;white-space:nowrap;background:#fff}.metadata{font-size:11px;color:var(--muted);margin:0 0 20px}.metadata summary{cursor:pointer;line-height:1.8}.metadata summary span{margin-left:15px;font-family:var(--mono);font-size:10px;color:#9aa4b0}.metadata dl{display:grid;grid-template-columns:80px 1fr;gap:10px;padding:16px;background:white;border:1px solid var(--line);border-radius:6px}.metadata dt{color:#9ba3ae}.metadata dd{margin:0;word-break:break-all;font:11px/1.6 var(--mono)}.console{background:#fff;border:1px solid #dde2e8;border-radius:10px;overflow:hidden;box-shadow:0 3px 14px #1d2b3c03}.console-toolbar{height:57px;display:flex;justify-content:space-between;gap:10px;align-items:center;border-bottom:1px solid var(--line);padding:0 20px}.tabs{display:flex;align-items:stretch;gap:24px;height:100%}.tab{background:none;border:0;border-bottom:2px solid transparent;padding:0 1px;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:8px}.tab.active{color:#2b3c36;font-weight:600;border-color:#2e755d}.live-dot{display:inline-block;width:5px;height:5px;background:var(--green);border-radius:50%}.console-actions{display:flex;align-items:center;gap:16px;font-size:10px;color:var(--muted);white-space:nowrap}.console-actions label{display:flex;align-items:center;gap:3px;cursor:pointer}.console-actions input{accent-color:var(--green);width:12px;height:12px}.quiet-button{font-size:10px;background:none;border:1px solid var(--line);border-radius:5px;color:#667383;padding:6px 8px}.live-toolbar{display:flex;justify-content:space-between;align-items:center;background:#fcfcfd;padding:10px 19px;border-bottom:1px solid #f0f2f5;font-size:10px;color:#9ba3ae}#event-filters{display:flex;gap:5px}.filter{border:0;background:none;font-size:10px;color:#83909e;padding:5px 10px;border-radius:4px}.filter.active{background:#ebeff3;color:#485869}.output{height:clamp(320px,49vh,720px);overflow:auto;padding:20px 24px;scroll-behavior:auto}.output:focus-visible{outline:2px solid #8eb5a3;outline-offset:-3px}.event{margin-bottom:20px;padding-left:17px;border-left:2px solid #e7ece9}.event[data-group=tool]{border-color:#dce5f8}.event[data-group=error]{border-color:#e7a0a3;background:#fff6f6;padding:12px 14px;border-radius:0 5px 5px 0}.event[data-group=system]{border-color:#e2e5ea}.event-header{display:flex;align-items:center;gap:10px;font-size:10px;color:#8a96a2;margin-bottom:9px}.event-label{color:#47816b;font-weight:600}.event[data-group=tool] .event-label{color:#5c76ae}.event[data-group=error] .event-label{color:#c95b62}.event[data-group=system] .event-label{color:#8993a0}.event-header time{font-family:var(--mono);font-size:9px}.event-header code{font-size:9px;color:#b0b8c2}.event pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.9 var(--mono);color:#374554}.event[data-group=agent] pre{font-family:inherit;font-size:13px;line-height:1.95}.event[data-group=system] pre{font-size:10px;color:#8a95a2}.console-footer{height:35px;border-top:1px solid var(--line);background:#fcfcfd;display:flex;justify-content:space-between;align-items:center;padding:0 19px;gap:15px;font:9px var(--mono);color:#97a2af}.banner{border:1px solid #ead9ad;background:#fffaf0;color:#956e28;border-radius:6px;padding:12px 15px;font-size:12px;line-height:1.8;margin-bottom:16px;white-space:pre-wrap;word-break:break-word}.banner.error{color:#b34d55;border-color:#efd6d8;background:#fff5f6}.empty-state{min-height:460px;display:flex;align-items:center;justify-content:center;flex-direction:column;border:1px dashed #dce1e6;border-radius:10px;background:#ffffff80;text-align:center}.empty-icon{font:36px var(--mono);color:#8ba397;background:#edf2ef;border:1px solid #e0e9e3;width:64px;height:64px;border-radius:17px;display:grid;place-items:center;margin-bottom:8px}.empty-state h2{font-size:17px}.empty-state p{color:var(--muted);font-size:12px;line-height:2}.empty-state code{font-family:var(--mono);background:#edf1ef;padding:3px 5px;color:#4e7664;font-size:11px}.empty-note{margin-top:22px;font-size:10px;color:#a3adb7}.feed-empty{padding:70px 15px;text-align:center;color:var(--muted);font-size:12px;line-height:2}.feed-empty strong{display:block;color:#647382;font-weight:500;margin-bottom:5px}.history-message{border-bottom:1px solid #edf0f3;padding:14px 0}.history-message:first-child{padding-top:0}.history-message pre{white-space:pre-wrap;word-break:break-word;font:12px/1.9 var(--mono);margin:8px 0}.history-message small{color:var(--muted);font-size:10px}.history-label{font-size:11px;font-weight:600;color:#5d7669}.diagnostic{padding:12px 0;border-bottom:1px solid var(--line);font:11px/1.8 var(--mono);white-space:pre-wrap;word-break:break-word;color:#9a5d63}.diagnostic time{display:block;color:var(--muted);font-size:10px;margin-bottom:5px}@media(min-width:1600px){main{padding-left:60px;padding-right:60px}.output{height:55vh}}@media(max-width:1050px){main{padding:0 24px 25px}.sidebar{width:236px}.metrics{gap:18px}.topbar-title{display:none}.console-actions{gap:8px}.tabs{gap:17px}.task-identifiers{flex-wrap:wrap;gap:6px}.console-toolbar{padding:0 14px}}@media(max-width:760px){.shell{display:block}.sidebar{position:relative;width:100%;height:auto;padding:17px}.brand{padding:0 0 18px}.sidebar-heading{padding-left:0}.sidebar-footer{display:none}#task-list{display:flex;overflow-x:auto;min-height:0;max-height:140px;gap:7px}.task-item{min-width:200px;max-width:240px}.search{margin-bottom:10px}select{margin:0 0 10px;width:100%}main{padding:0 16px 24px}.topbar{height:58px}.overview{padding:23px 0;align-items:flex-start;flex-direction:column}h1{font-size:23px}.metrics{gap:45px}.metrics strong{font-size:23px}.task-heading{padding-top:18px}h2{font-size:17px}.console-toolbar{height:auto;min-height:56px;flex-wrap:wrap;padding:0 12px 10px}.tabs{height:48px}.console-actions{width:100%;justify-content:space-between}.console-footer{font-size:8px}.console-footer>span:last-child{max-width:50%;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}.output{padding:16px;height:52vh}.local-tag{margin-left:4px}.connection{font-size:10px}}
`;

export const dashboardScript = String.raw`
'use strict';
const $ = id => document.getElementById(id);
const labels = { pending: '待启动', running: '执行中', idle: '等待输入', paused: '已暂停', failed: '执行失败' };
let snapshot = null, selectedId = null, stream = null, filter = 'all', eventCount = 0, lastSeq = 0, historySignature = '', polling = false;
const cards = new Map();
const time = value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
function statusDot(status) { return 'dot' + (status === 'running' ? ' green' : status === 'failed' ? ' red' : status === 'paused' ? ' amber' : ''); }
function connection(ok, text) { $('connection-dot').className = 'dot' + (ok ? ' green' : ' amber'); $('connection-text').textContent = text; }
function showError(message) { $('page-error').hidden = !message; $('page-error').textContent = message; }
function emptyFeed(target, title, text) { const box = node('div', 'feed-empty'); box.append(node('strong', '', title), node('span', '', text)); target.replaceChildren(box); }
function taskList() {
  const tasks = snapshot.tasks, query = $('search').value.toLowerCase(), status = $('status-filter').value;
  $('task-count').textContent = tasks.length;
  for (const name of ['running', 'idle', 'failed']) $('metric-' + name).textContent = tasks.filter(task => task.status === name).length;
  const visible = tasks.filter(task => (!status || task.status === status) && (task.title + task.id).toLowerCase().includes(query)).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.updatedAt - a.updatedAt);
  const fragment = document.createDocumentFragment();
  for (const task of visible) {
    const button = node('button', 'task-item' + (task.id === selectedId ? ' selected' : ''));
    button.dataset.taskId = task.id;
    const top = node('span', 'task-item-top'); top.append(node('i', statusDot(task.status)), node('span', '', labels[task.status]), node('span', '', ' / ' + task.sourceLabel));
    button.append(top, node('span', 'task-item-title', task.title), node('span', 'task-item-id', task.id.slice(0, 8)));
    button.addEventListener('click', () => selectTask(task.id)); fragment.append(button);
  }
  if (!visible.length) fragment.append(node('div', 'sidebar-empty', tasks.length ? '没有匹配的任务' : '还没有任务\n新任务会自动出现在这里'));
  $('task-list').replaceChildren(fragment);
}
function renderRuntime() {
  const runtime = snapshot.runtime, age = runtime ? snapshot.now - runtime.lastSeenAt : null;
  const alive = runtime && runtime.status === 'running' && age < Math.max(15000, runtime.intervalMs * 3);
  $('runtime-dot').className = 'dot' + (alive ? ' green' : '');
  $('runtime-status').textContent = alive ? '服务心跳正常' : runtime && runtime.status === 'running' ? '服务心跳已过期' : '服务未运行';
  $('runtime-detail').textContent = runtime ? 'PID ' + runtime.pid + ' · 最后心跳 ' + time(runtime.lastSeenAt) : '启动 run 后显示执行服务心跳';
  $('data-dir').textContent = snapshot.dataDir;
}
function renderTask() {
  const task = snapshot.tasks.find(item => item.id === selectedId);
  $('empty').hidden = !!task; $('task-panel').hidden = !task;
  if (!task) return;
  $('source-kind').textContent = task.sourceKind === 'cli' ? 'CLI SUBMISSION' : task.sourceKind === 'github' ? 'GITHUB ISSUE' : 'FEISHU CONVERSATION';
  $('task-badge').className = 'badge ' + task.status; $('task-badge').textContent = labels[task.status];
  $('task-title').textContent = task.title; $('task-id').textContent = task.id;
  $('updated-at').textContent = '状态更新 ' + time(task.updatedAt);
  $('source-link').hidden = !task.sourceUrl;
  if (task.sourceUrl && /^https?:\/\//.test(task.sourceUrl)) $('source-link').href = task.sourceUrl;
  else $('source-link').removeAttribute('href');
  $('execution-status').textContent = task.executionStatus;
  const metadata = document.createDocumentFragment();
  for (const pair of [['Thread', task.threadId], ['Turn', task.turnId], ['任务群', task.chatId], ['恢复次数', String(task.recovery.attempts)], ...task.resources.map(resource => [resource.kind === 'project' ? resource.project.name : resource.repository, resource.workspace])]) {
    metadata.append(node('dt', '', pair[0]), node('dd', '', pair[1] || '尚未关联'));
  }
  $('metadata-list').replaceChildren(metadata);
  const alerts = [];
  if (task.workspaceSelection && task.workspaceSelection.kind === 'waiting') alerts.push('等待目录确认：' + task.workspaceSelection.question);
  if (task.reason) alerts.push(task.reason);
  for (const request of task.requests) alerts.push((request.kind === 'question' ? '等待回答：' : '等待工具审批：') + request.prompt);
  if (task.recovery.nextAttemptAt) alerts.push('等待自动恢复 · ' + time(task.recovery.nextAttemptAt));
  if (task.status === 'idle') alerts.push('本轮执行已结束，正在等待新输入；任务上下文继续保留。');
  $('task-alert').hidden = !alerts.length; $('task-alert').textContent = alerts.join('\n');
  $('task-alert').className = 'banner' + (task.status === 'failed' ? ' error' : '');
  renderDiagnostics();
}
function renderDiagnostics() {
  const rows = snapshot.diagnostics.filter(row => row.scope === selectedId || row.scope.endsWith(':' + selectedId) || ['collection', 'tick', 'feishu'].includes(row.scope));
  if (!rows.length) { emptyFeed($('diagnostics'), '没有诊断异常', '执行故障与投递异常会在这里显示。'); return; }
  const fragment = document.createDocumentFragment();
  for (const row of rows) { const el = node('div', 'diagnostic'); el.append(node('time', '', time(row.created_at) + ' · ' + row.scope), node('span', '', row.message)); fragment.append(el); }
  $('diagnostics').replaceChildren(fragment);
}
function addEvent(event) {
  if (event.taskId !== selectedId || event.seq <= lastSeq) return;
  lastSeq = event.seq; eventCount++;
  if (!cards.size) $('output').replaceChildren();
  const group = event.kind.startsWith('agent_') ? 'agent' : event.kind.startsWith('tool_') ? 'tool' : event.kind === 'error' ? 'error' : 'system';
  const key = event.itemId ? event.turnId + ':' + event.itemId : 'event:' + event.seq;
  let card = cards.get(key);
  if (!card) {
    const el = node('article', 'event'); el.dataset.group = group;
    const head = node('div', 'event-header'), label = node('span', 'event-label', event.label), stamp = node('time', '', time(event.createdAt)), body = node('pre');
    head.append(label, stamp, node('code', '', event.turnId || ''));
    el.append(head, body); card = { el, label, body, text: '', complete: false }; cards.set(key, card); $('output').append(el);
  }
  if (event.kind === 'agent_delta' || event.kind === 'tool_output') {
    if (!card.complete) card.text += event.text;
  } else {
    card.text = event.text; card.label.textContent = event.label;
    card.complete = event.kind === 'agent_message' || event.kind === 'tool_end';
  }
  card.body.textContent = card.text;
  card.el.hidden = filter !== 'all' && filter !== card.el.dataset.group;
  $('event-count').textContent = eventCount + ' 条事件';
  $('last-event').textContent = '最后事件 ' + time(event.createdAt);
  if ($('auto-scroll').checked) $('output').scrollTop = $('output').scrollHeight;
}
async function history(taskId) {
  try {
    const response = await fetch('/api/tasks/' + encodeURIComponent(taskId));
    if (!response.ok) throw new Error('读取消息记录失败');
    const data = await response.json(); if (selectedId !== taskId) return;
    const signature = JSON.stringify(data); if (signature === historySignature) return; historySignature = signature;
    const fragment = document.createDocumentFragment();
    for (const input of data.inputs) {
      const el = node('article', 'history-message'); el.append(node('div', 'history-label', (input.route === 'workspace-selection' ? '目录答复 / 任务补充' : input.origin === 'user' ? '用户输入' : '任务输入') + ' · ' + input.status), node('small', '', time(input.createdAt)), node('pre', '', input.text));
      if (input.attachments.length) el.append(node('small', '', '附件：' + input.attachments.map(item => item.name).join('、')));
      if (input.error) el.append(node('pre', '', input.error)); fragment.append(el);
    }
    for (const output of data.outputs) {
      const el = node('article', 'history-message'); el.append(node('div', 'history-label', '发往任务群 · ' + output.status), node('pre', '', output.text));
      if (output.error) el.append(node('pre', '', output.error)); fragment.append(el);
    }
    if (!fragment.childNodes.length) emptyFeed($('history'), '还没有消息', '消息投递记录会保留在这里。'); else $('history').replaceChildren(fragment);
  } catch (error) { if (selectedId === taskId) emptyFeed($('history'), '消息记录暂不可用', error.message); }
}
function selectTask(id) {
  if (selectedId === id) return;
  if (stream) stream.close();
  selectedId = id; lastSeq = 0; eventCount = 0; cards.clear(); historySignature = '';
  $('event-count').textContent = '0 条事件'; $('last-event').textContent = '完整消息与逐段输出均会保留';
  emptyFeed($('output'), '等待执行输出', '实时事件在新版执行服务启动后开始记录；历史消息可在「消息记录」查看。');
  taskList(); renderTask(); history(id);
  stream = new EventSource('/api/events?taskId=' + encodeURIComponent(id));
  stream.onopen = () => { connection(true, '实时连接已建立'); $('stream-status').textContent = 'LIVE · 接收执行事件'; };
  stream.onerror = () => { connection(false, '连接中断，正在重连'); $('stream-status').textContent = 'RECONNECTING · 自动续接'; };
  stream.addEventListener('execution', message => { try { addEvent(JSON.parse(message.data)); } catch (error) { showError('事件读取失败：' + error.message); } });
  stream.addEventListener('stream-error', message => showError(JSON.parse(message.data).error));
}
async function refresh() {
  if (polling) return; polling = true;
  try {
    const response = await fetch('/api/snapshot'); if (!response.ok) throw new Error('读取任务失败 · HTTP ' + response.status);
    snapshot = await response.json(); showError(''); renderRuntime();
    if (selectedId && !snapshot.tasks.some(task => task.id === selectedId)) { if (stream) stream.close(); stream = null; selectedId = null; }
    if (!selectedId && snapshot.tasks.length) selectTask(snapshot.tasks.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0].id);
    else { taskList(); renderTask(); }
    if (!selectedId) connection(true, '调试台已连接');
    if (selectedId && !$('history').hidden) history(selectedId);
  } catch (error) { connection(false, '连接失败'); showError(error.message); }
  finally { polling = false; }
}
$('search').addEventListener('input', () => snapshot && taskList());
$('status-filter').addEventListener('change', () => snapshot && taskList());
for (const name of ['live', 'history', 'diagnostics']) $('tab-' + name).addEventListener('click', () => {
  for (const view of ['live', 'history', 'diagnostics']) {
    $('tab-' + view).classList.toggle('active', view === name); $('tab-' + view).setAttribute('aria-selected', String(view === name));
    $(view === 'live' ? 'output' : view).hidden = view !== name;
  }
  $('live-toolbar').hidden = name !== 'live'; if (name === 'history' && selectedId) history(selectedId);
});
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => {
  filter = button.dataset.filter;
  for (const option of document.querySelectorAll('[data-filter]')) option.classList.toggle('active', option === button);
  for (const card of cards.values()) card.el.hidden = filter !== 'all' && filter !== card.el.dataset.group;
});
$('copy').addEventListener('click', async () => {
  const target = !$('history').hidden ? $('history') : !$('diagnostics').hidden ? $('diagnostics') : $('output');
  try { await navigator.clipboard.writeText(target.innerText); $('copy').textContent = '已复制'; } catch { $('copy').textContent = '复制失败'; }
  window.setTimeout(() => { $('copy').textContent = '复制记录'; }, 1500);
});
window.addEventListener('beforeunload', () => stream && stream.close());
refresh(); window.setInterval(refresh, 1000);
`;
