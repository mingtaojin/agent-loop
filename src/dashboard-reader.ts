import { intakeRouteSchema, presentTaskSource, type InputProvenance, type Task, type TaskResource } from './domain.js';
import { ProjectLedger, type ProjectState } from './project.js';
import { Store, type Inbox } from './store.js';
import type { StoredExecutionEvent } from './execution-events.js';
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
  currentStep?: string;
  nextStep?: string;
  blockers?: string | string[];
  evidence?: string | string[];
}

export interface DashboardExecutionEvent {
  seq: number;
  taskId: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  kind: Exclude<StoredExecutionEvent['kind'], 'tool_output'>;
  label: string;
  text: string;
  createdAt: number;
}

export interface ProjectTaskCard {
  id: string;
  projectId: string;
  role: 'coordinator' | 'worker' | 'intake';
  title: string;
  sourceLabel: string;
  sourceKind: Task['source']['kind'];
  sourceUrl: string | null;
  repository: string | null;
  issueId: string | null;
  status: Task['status'];
  executionStatus: Task['executionStatus'];
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
  task: ProjectTaskCard | null;
  projectId: string | null;
  inputs: ReturnType<Store['inputs']>;
  outputs: ReturnType<Store['outputs']>;
  events: DashboardExecutionEvent[];
  reports: DashboardReport[];
  diagnostics: ReturnType<Store['diagnostics']>;
}

function reportFromInput(input: Inbox): DashboardReport | null {
  const provenance = input.provenance;
  if (provenance.kind !== 'agent' || !provenance.eventId.startsWith('report:') || !['result', 'question', 'update'].includes(provenance.category)) return null;
  const report = {
    kind: provenance.category as DashboardReport['kind'],
    text: boundedDashboardText(input.message.text),
    createdAt: input.message.createdAt,
    ...(provenance.currentStep === undefined ? {} : { currentStep: boundedDashboardText(provenance.currentStep) }),
    ...(provenance.nextStep === undefined ? {} : { nextStep: boundedDashboardText(provenance.nextStep) }),
    ...(provenance.blockers === undefined ? {} : { blockers: typeof provenance.blockers === 'string' ? boundedDashboardText(provenance.blockers) : provenance.blockers.map(boundedDashboardText) }),
    ...(provenance.evidence === undefined ? {} : { evidence: typeof provenance.evidence === 'string' ? boundedDashboardText(provenance.evidence) : provenance.evidence.map(boundedDashboardText) }),
  } satisfies DashboardReport;
  return report;
}

function dashboardEvent(event: StoredExecutionEvent): DashboardExecutionEvent | null {
  if (event.kind === 'tool_output') return null;
  let text = event.text;
  if (event.kind === 'tool_start' || event.kind === 'tool_end') {
    if (event.label.startsWith('命令 · ')) text = text.split('\n', 1)[0] ?? '';
    else if (event.label.startsWith('文件变更 · ')) text = text.split('\n', 1)[0] ?? '';
    else text = '';
  }
  return { ...event, text: boundedDashboardText(text) } as DashboardExecutionEvent;
}

function coalesce(events: StoredExecutionEvent[]): DashboardExecutionEvent[] {
  const result: DashboardExecutionEvent[] = [];
  for (const raw of events) {
    const event = dashboardEvent(raw);
    if (!event) continue;
    const previous = result.at(-1);
    if (previous && previous.kind === 'agent_delta' && event.kind === 'agent_delta'
      && previous.threadId === event.threadId && previous.turnId === event.turnId && previous.itemId === event.itemId) {
      previous.text = boundedDashboardText(previous.text.replace(/\n…$/, '') + event.text);
      previous.seq = event.seq;
      previous.createdAt = event.createdAt;
      continue;
    }
    result.push(event);
  }
  return result;
}

type DashboardOwnership = { projectId: string; role: ProjectTaskCard['role'] };
interface DashboardContext {
  tasks: Task[];
  states: Map<string, ProjectState>;
  ownership: Map<string, DashboardOwnership>;
  reportsByTask: Map<string, DashboardReport[]>;
  latestActivity: Map<string, StoredExecutionEvent>;
}
const membershipMetadataSchema = z.strictObject({ projectId: z.string(), role: z.enum(['coordinator', 'worker']) });

export class ProjectDashboardReader {
  readonly ledger: ProjectLedger;
  constructor(private readonly store: Store) { this.ledger = new ProjectLedger(store); }

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
    return { tasks, states, ownership, reportsByTask, latestActivity: this.store.latestVisibleExecutionEvents(tasks.map(task => task.id)) };
  }

  private reportsForTask(taskId: string, context: DashboardContext): DashboardReport[] {
    const ownership = context.ownership.get(taskId);
    const state = ownership ? context.states.get(ownership.projectId) : null;
    if (!state && ownership?.role !== 'intake') return [];
    return context.reportsByTask.get(taskId) ?? [];
  }

  private card(task: Task, projectId: string, role: ProjectTaskCard['role'], context: DashboardContext, issueId: string | null = null): ProjectTaskCard {
    const latestActivity = context.latestActivity.get(task.id) ?? null;
    const visibleActivity = latestActivity ? dashboardEvent(latestActivity) : null;
    const reports = this.reportsForTask(task.id, context);
    const waiting = task.requests.map(request => `${request.kind}: ${boundedDashboardText(request.prompt)}`);
    const source = presentTaskSource(task.source, 200);
    const repository = task.source.kind === 'github' ? task.source.issue.repository : task.resources.find(resource => resource.kind !== 'project')?.repository.name ?? null;
    return {
      id: task.id, projectId, role, title: source.title, sourceLabel: source.label, sourceKind: task.source.kind, sourceUrl: source.url, repository,
      issueId: issueId ?? (task.source.kind === 'github' ? task.source.issue.id : null),
      status: task.status, executionStatus: task.executionStatus, currentTurn: task.turnId ?? visibleActivity?.turnId ?? null,
      threadId: task.threadId, turnId: task.turnId, chatId: task.chatId, resources: dashboardResources(task.resources),
      latestActivity: visibleActivity, waitingReason: waiting[0] ?? (task.reason ? boundedDashboardText(task.reason) : null) ?? (task.recovery.lastError ? boundedDashboardText(task.recovery.lastError) : null), requests: task.requests.map(request => ({ kind: request.kind, prompt: boundedDashboardText(request.prompt) })),
      recovery: task.recovery, createdAt: task.createdAt, updatedAt: task.updatedAt, latestReport: reports.at(-1) ?? null,
    };
  }

  projects(tasks = this.store.tasks()): ProjectDashboard[] {
    const context = this.context(tasks);
    const cards = new Map<string, ProjectTaskCard[]>();
    for (const task of tasks) {
      const ownership = context.ownership.get(task.id);
      if (!ownership) continue;
      const state = context.states.get(ownership.projectId);
      if (!state) continue;
      const issueId = state.members.find(member => member.taskId === task.id)?.issueId ?? null;
      const list = cards.get(state.id) ?? [];
      list.push(this.card(task, state.id, ownership.role, context, issueId)); cards.set(state.id, list);
    }
    return [...context.states.values()].sort((a, b) => a.name.localeCompare(b.name)).map(state => ({
      id: state.id, name: state.name, directory: state.directory, coordinatorTaskId: state.coordinatorTaskId,
      members: state.members, tasks: (cards.get(state.id) ?? []).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
    }));
  }

  project(projectId: string): ProjectDashboard | null { return this.projects().find(project => project.id === projectId) ?? null; }

  private allEvents(taskId: string): StoredExecutionEvent[] {
    const events: StoredExecutionEvent[] = [];
    let after = 0;
    while (true) {
      const batch = this.store.visibleExecutionEvents(taskId, after);
      if (!batch.length) return events;
      events.push(...batch);
      after = batch.at(-1)!.seq;
      if (batch.length < 500) return events;
    }
  }

  events(taskId: string, after = 0, limit = 500): { cursor: number; events: DashboardExecutionEvent[] } {
    const raw = this.store.visibleExecutionEvents(taskId, after, limit);
    const cursor = raw.at(-1)?.seq ?? after;
    const events = raw.flatMap(event => {
      const visible = dashboardEvent(event);
      return visible ? [visible] : [];
    });
    return { cursor, events };
  }

  taskDetail(taskId: string, tasks = this.store.tasks()): DashboardTaskDetail | null {
    const task = tasks.find(candidate => candidate.id === taskId);
    if (!task) return null;
    const context = this.context(tasks);
    const ownership = context.ownership.get(taskId);
    const project = ownership ? context.states.get(ownership.projectId) : null;
    const reports = this.reportsForTask(taskId, context);
    return {
      task: ownership && project ? this.card(task, project.id, ownership.role, context, project.members.find(member => member.taskId === taskId)?.issueId ?? null) : null,
      projectId: ownership?.projectId ?? null,
      inputs: this.store.inputs(taskId), outputs: this.store.outputs(taskId), events: coalesce(this.allEvents(taskId)), reports,
      diagnostics: this.store.diagnostics().filter(row => row.scope === taskId || row.scope.endsWith(':' + taskId)),
    };
  }
}
