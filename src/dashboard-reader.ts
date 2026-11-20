import { LiveExecution, type ExecutionObservation } from './live-execution.js';
import { readTaskCloseout } from './task-closeout.js';
import { intakeRouteSchema, presentTaskSource, type InputProvenance, type ReportEscalation, type ReportRouting, type ReportSource, type Task, type TaskResource } from './domain.js';
import { ProjectLedger, type ProjectState } from './project.js';
import { Store, type Inbox } from './store.js';
import type { VisibleExecution } from './execution-events.js';
import { z } from 'zod';

export const visibleTextLimit = 32_768;

export type DashboardResource =
  | { kind: 'project'; project: Extract<TaskResource, { kind: 'project' }>['project']; workspace: string }
  | { repository: string; workspace: string };

export function dashboardResource(resource: TaskResource): DashboardResource {
  return resource.kind === 'project'
    ? { kind: resource.kind, project: resource.project, workspace: resource.workspace }
    : { repository: resource.repository.name, workspace: resource.workspace };
}

export function dashboardResources(resources: TaskResource[]): DashboardResource[] {
  return resources.map(dashboardResource);
}

export function boundedDashboardText(value: string): string {
  return value.length <= visibleTextLimit ? value : value.slice(0, visibleTextLimit) + '\n…';
}

export interface DashboardReport {
  kind: 'result' | 'question' | 'update';
  text: string;
  createdAt: number;
  routing?: ReportRouting;
  escalation?: ReportEscalation;
  sources?: ReportSource[];
  currentStep?: string;
  nextStep?: string;
  blockers?: string | string[];
  evidence?: string | string[];
}

export interface DashboardExecutionEvent {
  key: string;
  seq: number;
  taskId: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  kind: Exclude<VisibleExecution['kind'], 'tool_output'>;
  type: DashboardEventType;
  label: string;
  text: string;
  createdAt: number | null;
}

export const dashboardEventTypes = ['INPUT', 'PHASE', 'NARRATIVE', 'TOOL_CALL', 'WAITING', 'BLOCKER', 'OUTPUT', 'EVIDENCE', 'RETRY'] as const;
export type DashboardEventType = typeof dashboardEventTypes[number];

export interface DashboardTimelineEntry {
  id: string;
  seq: number;
  taskId: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  type: DashboardEventType;
  label: string;
  text: string;
  createdAt: number | null;
  phase: string | null;
}

export type DashboardWorkSummary =
  | { kind: 'event'; event: DashboardExecutionEvent }
  | { kind: 'report'; report: DashboardReport }
  | { kind: 'waiting'; text: string; createdAt: null }
  | { kind: 'no-record' };

export interface ProjectTaskCard {
  id: string;
  projectId: string | null;
  role: 'coordinator' | 'worker' | 'intake' | null;
  title: string;
  sourceLabel: string;
  sourceKind: Task['source']['kind'];
  sourceUrl: string | null;
  repository: string | null;
  issueId: string | null;
  status: Task['status'];
  executionStatus: Task['executionStatus'];
  reason: string | null;
  lifecycle: ReturnType<typeof readTaskCloseout>['lifecycle'];
  workSummary: DashboardWorkSummary;
  threadId: string | null;
  turnId: string | null;
  chatId: string | null;
  resources: DashboardResource[];
  currentTurn: string | null;
  latestActivity: DashboardExecutionEvent | null;
  waitingReason: string | null;
  requests: { kind: string; prompt: string }[];
  recovery: Task['recovery'];
  createdAt: number;
  updatedAt: number;
  latestReport: DashboardReport | null;
  completion: ReturnType<typeof readTaskCloseout>['lifecycle'];
  completionHistory: ReturnType<typeof readTaskCloseout>['completionHistory'];
  cleanup: { operationId: string; kind: string; scopeId: string; state: string; reason: string | null; directoryRemoved: boolean; branchRemoved: boolean }[];
}

export interface ProjectDashboard {
  id: string;
  name: string;
  directory: string;
  coordinatorTaskId: string;
  members: ProjectState['members'];
  tasks: ProjectTaskCard[];
}

export interface DashboardTaskDetail {
  threadId: string | null;
  task: ProjectTaskCard | null;
  projectId: string | null;
  inputs: ReturnType<Store['inputs']>;
  outputs: ReturnType<Store['outputs']>;
  cursor: string;
  history: ExecutionObservation['history'];
  events: DashboardExecutionEvent[];
  timeline: DashboardTimelineEntry[];
  reports: DashboardReport[];
  diagnostics: ReturnType<Store['diagnostics']>;
}

function reportFromInput(input: Inbox): DashboardReport | null {
  const provenance = input.provenance;
  if (provenance.kind !== 'agent' || !provenance.eventId.startsWith('report:') || !['result', 'question', 'update'].includes(provenance.category)) return null;
  const report = {
    kind: provenance.category as DashboardReport['kind'],
    text: boundedDashboardText(input.message.text),
    ...(provenance.routing === undefined ? {} : { routing: provenance.routing }),
    ...(provenance.escalation === undefined ? {} : { escalation: provenance.escalation }),
    ...(provenance.sources === undefined ? {} : { sources: provenance.sources }),
    createdAt: input.message.createdAt,
    ...(provenance.currentStep === undefined ? {} : { currentStep: boundedDashboardText(provenance.currentStep) }),
    ...(provenance.nextStep === undefined ? {} : { nextStep: boundedDashboardText(provenance.nextStep) }),
    ...(provenance.blockers === undefined ? {} : { blockers: typeof provenance.blockers === 'string' ? boundedDashboardText(provenance.blockers) : provenance.blockers.map(boundedDashboardText) }),
    ...(provenance.evidence === undefined ? {} : { evidence: typeof provenance.evidence === 'string' ? boundedDashboardText(provenance.evidence) : provenance.evidence.map(boundedDashboardText) }),
  } satisfies DashboardReport;
  return report;
}

function eventType(event: Pick<VisibleExecution, 'kind' | 'label' | 'text'>): DashboardEventType {
  if (event.kind === 'agent_delta') return 'NARRATIVE';
  if (event.kind === 'agent_message') return event.label === '最终回答' ? 'OUTPUT' : 'NARRATIVE';
  if (event.kind === 'tool_start' || event.kind === 'tool_end') return 'TOOL_CALL';
  if (event.kind === 'error') return event.label.includes('重试') ? 'RETRY' : 'BLOCKER';
  if (event.kind === 'turn_status' && /wait|pending|idle|等待|阻塞/i.test(event.text)) return 'WAITING';
  return 'PHASE';
}

function dashboardEvent(event: VisibleExecution): DashboardExecutionEvent | null {
  if (event.kind === 'tool_output') return null;
  let text = event.text;
  if (event.kind === 'tool_start' || event.kind === 'tool_end') {
    if (event.label.startsWith('命令 · ')) text = text.split('\n', 1)[0] ?? '';
    else if (event.label.startsWith('文件变更 · ')) text = text.split('\n', 1)[0] ?? '';
    else text = '';
  }
  return { ...event, type: eventType(event), text: boundedDashboardText(text) } as DashboardExecutionEvent;
}

type DashboardOwnership = { projectId: string; role: NonNullable<ProjectTaskCard['role']> };
interface DashboardContext {
  tasks: Task[];
  states: Map<string, ProjectState>;
  ownership: Map<string, DashboardOwnership>;
  reportsByTask: Map<string, DashboardReport[]>;
}
const membershipMetadataSchema = z.strictObject({ projectId: z.string(), role: z.enum(['coordinator', 'worker']) });

export class ProjectDashboardReader {
  readonly ledger: ProjectLedger;
  constructor(private readonly store: Store, private readonly execution = new LiveExecution()) { this.ledger = new ProjectLedger(store); }

  private route(taskId: string): { projectId: string; coordinatorTaskId: string } | null {
    const raw = this.store.meta(`project-intake-route:${taskId}`);
    return raw === null ? null : intakeRouteSchema.parse(JSON.parse(raw));
  }

  private membershipMetadata(taskId: string): z.infer<typeof membershipMetadataSchema> | null {
    const raw = this.store.meta(`project:${JSON.stringify(['member', taskId])}`);
    return raw === null ? null : membershipMetadataSchema.parse(JSON.parse(raw));
  }

  private context(tasks: Task[]): DashboardContext {
    const states = new Map<string, ProjectState>();
    const ownership = new Map<string, DashboardOwnership>();
    const coordinatorInputs = new Map<string, Inbox[]>();
    for (const task of tasks) {
      const member = this.membershipMetadata(task.id);
      const route = member ? null : this.route(task.id);
      const owned = member ? { projectId: member.projectId, role: member.role } as DashboardOwnership
        : route ? { projectId: route.projectId, role: 'intake' as const } : null;
      if (!owned) continue;
      ownership.set(task.id, owned);
      if (!states.has(owned.projectId)) {
        const state = this.ledger.project(owned.projectId);
        if (state) states.set(owned.projectId, state);
      }
    }
    for (const [taskId, owned] of ownership) {
      if (owned.role === 'intake') continue;
      const state = states.get(owned.projectId);
      const member = state?.members.find(candidate => candidate.taskId === taskId);
      if (!member || member.role !== owned.role) throw new Error('Inconsistent project membership');
    }
    for (const state of states.values()) coordinatorInputs.set(state.coordinatorTaskId, this.store.inputs(state.coordinatorTaskId));
    for (const route of tasks.filter(task => ownership.get(task.id)?.role === 'intake')) {
      const routeState = this.route(route.id);
      if (routeState && !coordinatorInputs.has(routeState.coordinatorTaskId)) coordinatorInputs.set(routeState.coordinatorTaskId, this.store.inputs(routeState.coordinatorTaskId));
    }
    const reportsByTask = new Map<string, DashboardReport[]>();
    for (const inputs of coordinatorInputs.values()) for (const input of inputs) {
      if (input.provenance.kind !== 'agent') continue;
      const report = reportFromInput(input);
      if (!report) continue;
      const list = reportsByTask.get(input.provenance.taskId) ?? [];
      list.push(report); reportsByTask.set(input.provenance.taskId, list);
    }
    for (const reports of reportsByTask.values()) reports.sort((a, b) => a.createdAt - b.createdAt);
    return { tasks, states, ownership, reportsByTask };
  }

  private reportsForTask(taskId: string, context: DashboardContext): DashboardReport[] {
    const ownership = context.ownership.get(taskId);
    const state = ownership ? context.states.get(ownership.projectId) : null;
    if (!state && ownership?.role !== 'intake') return [];
    return context.reportsByTask.get(taskId) ?? [];
  }

  private card(task: Task, context: DashboardContext, issueId: string | null = null): ProjectTaskCard {
    const ownership = context.ownership.get(task.id);
    const latestActivity = this.execution.latestPublished(task.id, task.threadId);
    const visibleActivity = latestActivity ? dashboardEvent(latestActivity) : null;
    const reports = this.reportsForTask(task.id, context);
    const waiting = task.requests.map(request => `${request.kind}: ${boundedDashboardText(request.prompt)}`);
    const waitingReason = waiting[0] ?? (task.reason ? boundedDashboardText(task.reason) : null) ?? (task.recovery.lastError ? boundedDashboardText(task.recovery.lastError) : null);
    const latestReport = reports.at(-1) ?? null;
    const workSummary: DashboardWorkSummary = visibleActivity ? { kind: 'event', event: visibleActivity }
      : latestReport ? { kind: 'report', report: latestReport }
      : waitingReason ? { kind: 'waiting', text: waitingReason, createdAt: null } : { kind: 'no-record' };
    const source = presentTaskSource(task.source, 200);
    const repository = task.source.kind === 'github' ? task.source.issue.repository : task.resources.find(resource => resource.kind !== 'project')?.repository.name ?? null;
    const closeout = readTaskCloseout(this.store, task.id);
    return {
      completion: closeout.lifecycle,
      completionHistory: closeout.completionHistory,
      cleanup: closeout.operations.flatMap(operation => operation.targets.map(target => ({ operationId: operation.id, kind: operation.kind, scopeId: target.scope.id, state: target.state, reason: target.reason, directoryRemoved: target.directoryRemoved, branchRemoved: target.branchRemoved }))),
      id: task.id, projectId: ownership?.projectId ?? null, role: ownership?.role ?? null, title: source.title, sourceLabel: source.label, sourceKind: task.source.kind, sourceUrl: source.url, repository,
      issueId: issueId ?? (task.source.kind === 'github' ? task.source.issue.id : null),
      status: task.status, executionStatus: task.executionStatus, currentTurn: task.turnId,
      reason: task.reason ? boundedDashboardText(task.reason) : null, lifecycle: closeout.lifecycle, workSummary,
      threadId: task.threadId, turnId: task.turnId, chatId: task.chatId, resources: dashboardResources(task.resources),
      latestActivity: visibleActivity, waitingReason, requests: task.requests.map(request => ({ kind: request.kind, prompt: boundedDashboardText(request.prompt) })),
      recovery: task.recovery, createdAt: task.createdAt, updatedAt: task.updatedAt, latestReport,
    };
  }

  overview(tasks = this.store.tasks()): { tasks: ProjectTaskCard[]; projects: ProjectDashboard[] } {
    const context = this.context(tasks);
    const projected = tasks.map(task => {
      const ownership = context.ownership.get(task.id);
      const state = ownership ? context.states.get(ownership.projectId) : null;
      return this.card(task, context, state?.members.find(member => member.taskId === task.id)?.issueId ?? null);
    });
    const projects = [...context.states.values()].sort((a, b) => a.name.localeCompare(b.name)).map(state => ({
      id: state.id, name: state.name, directory: state.directory, coordinatorTaskId: state.coordinatorTaskId,
      members: state.members, tasks: projected.filter(task => task.projectId === state.id).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
    }));
    return { tasks: projected, projects };
  }

  projects(tasks = this.store.tasks()): ProjectDashboard[] { return this.overview(tasks).projects; }

  project(projectId: string): ProjectDashboard | null { return this.projects().find(project => project.id === projectId) ?? null; }

  timeline(taskId: string, events: VisibleExecution[] = [], limit = 500): DashboardTimelineEntry[] {
    const task = this.store.tasks().find(candidate => candidate.id === taskId);
    if (!task) return [];
    const detailEvents: DashboardTimelineEntry[] = events.flatMap(raw => {
      const event = dashboardEvent(raw);
      return event ? [{ ...event, id: 'event:' + event.key, phase: null }] : [];
    });
    const inputs = this.store.inputs(taskId).map((input, index): DashboardTimelineEntry => ({
      id: 'input:' + input.id, seq: -(index + 1), taskId, threadId: null, turnId: null, itemId: null,
      type: 'INPUT', label: input.origin === 'user' ? '用户输入' : '任务输入', text: boundedDashboardText(input.message.text), createdAt: input.message.createdAt, phase: null,
    }));
    const reports = this.reportsForTask(taskId, this.context(this.store.tasks())).flatMap((report, index): DashboardTimelineEntry[] => {
      const type: DashboardEventType = report.kind === 'question' ? 'WAITING' : report.kind === 'result' ? 'OUTPUT' : report.evidence ? 'EVIDENCE' : 'NARRATIVE';
      const evidence = report.evidence === undefined ? [] : [typeof report.evidence === 'string' ? report.evidence : report.evidence.join('\n')];
      return [{
        id: 'report:' + taskId + ':' + index, seq: -(inputs.length + index + 1), taskId, threadId: null, turnId: null, itemId: null,
        type, label: 'Worker ' + report.kind, text: boundedDashboardText(report.text), createdAt: report.createdAt, phase: report.currentStep ?? null,
      }, ...evidence.map((text, evidenceIndex) => ({
        id: 'report-evidence:' + taskId + ':' + index + ':' + evidenceIndex, seq: -(inputs.length + index + evidenceIndex + 2), taskId, threadId: null, turnId: null, itemId: null,
        type: 'EVIDENCE' as const, label: '证据', text: boundedDashboardText(text), createdAt: report.createdAt, phase: report.currentStep ?? null,
      }))];
    });
    const waiting = task.requests.map((request, index): DashboardTimelineEntry => ({
      id: 'waiting:' + taskId + ':' + index, seq: -(inputs.length + reports.length + index + 1), taskId, threadId: null, turnId: task.turnId, itemId: null,
      type: request.kind === 'question' ? 'WAITING' : 'BLOCKER', label: request.kind === 'question' ? '等待回答' : '等待审批', text: boundedDashboardText(request.prompt), createdAt: task.updatedAt, phase: null,
    }));
    return [...inputs, ...reports, ...waiting, ...detailEvents]
      .sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity) || a.seq - b.seq)
      .slice(-limit);
  }

  async taskDetail(taskId: string, tasks = this.store.tasks()): Promise<DashboardTaskDetail | null> {
    const task = tasks.find(candidate => candidate.id === taskId);
    if (!task) return null;
    const observation: ExecutionObservation = task.threadId ? await this.execution.read(taskId, task.threadId) : { cursor: this.execution.cursor, canonicalTurnIds: [], history: { kind: 'available' }, entries: [] };
    const current = this.store.tasks().find(candidate => candidate.id === taskId);
    if (!current) return null;
    if (current.threadId !== task.threadId) return this.taskDetail(taskId);
    const context = this.context(tasks);
    const ownership = context.ownership.get(taskId);
    const project = ownership ? context.states.get(ownership.projectId) : null;
    const reports = this.reportsForTask(taskId, context);
    return {
      task: this.card(task, context, project?.members.find(member => member.taskId === taskId)?.issueId ?? null),
      threadId: task.threadId, projectId: ownership?.projectId ?? null,
      inputs: this.store.inputs(taskId), outputs: this.store.outputs(taskId), cursor: observation.cursor, history: observation.history, events: observation.entries.flatMap(event => { const visible = dashboardEvent(event); return visible ? [visible] : []; }), timeline: this.timeline(taskId, observation.entries), reports,
      diagnostics: this.store.diagnostics().filter(row => row.scope === taskId || row.scope.endsWith(':' + taskId)),
    };
  }
}
