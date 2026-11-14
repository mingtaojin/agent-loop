import { intakeRouteSchema, presentTaskSource, type InputProvenance, type Task } from './domain.js';
import { ProjectLedger, type ProjectState } from './project.js';
import { Store, type Inbox } from './store.js';
import type { StoredExecutionEvent } from './execution-events.js';

export const visibleTextLimit = 32_768;

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
  resources: Task['resources'];
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

export class ProjectDashboardReader {
  readonly ledger: ProjectLedger;
  constructor(private readonly store: Store) { this.ledger = new ProjectLedger(store); }

  private route(taskId: string): { projectId: string; coordinatorTaskId: string } | null {
    const raw = this.store.meta(`project-intake-route:${taskId}`);
    return raw === null ? null : intakeRouteSchema.parse(JSON.parse(raw));
  }

  private projectForTask(taskId: string): { projectId: string; role: ProjectTaskCard['role'] } | null {
    const member = this.ledger.membership(taskId);
    if (member) return { projectId: member.projectId, role: member.role };
    const route = this.route(taskId);
    return route ? { projectId: route.projectId, role: 'intake' } : null;
  }

  private reportsForTask(taskId: string): DashboardReport[] {
    const membership = this.ledger.membership(taskId);
    const coordinatorTaskId = membership ? this.ledger.project(membership.projectId)?.coordinatorTaskId : this.route(taskId)?.coordinatorTaskId;
    if (!coordinatorTaskId) return [];
    return this.store.inputs(coordinatorTaskId).flatMap(input => input.provenance.kind === 'agent' && input.provenance.taskId === taskId
      ? [reportFromInput(input)].filter((report): report is DashboardReport => report !== null) : []);
  }

  private card(task: Task, projectId: string, role: ProjectTaskCard['role'], issueId: string | null = null): ProjectTaskCard {
    const events = coalesce(this.allEvents(task.id));
    const latestActivity = events.at(-1) ?? null;
    const reports = this.reportsForTask(task.id);
    const waiting = task.requests.map(request => `${request.kind}: ${boundedDashboardText(request.prompt)}`);
    const source = presentTaskSource(task.source, 200);
    const repository = task.source.kind === 'github' ? task.source.issue.repository : task.resources.find(resource => resource.kind !== 'project')?.repository.name ?? null;
    return {
      id: task.id, projectId, role, title: source.title, sourceLabel: source.label, sourceKind: task.source.kind, sourceUrl: source.url, repository,
      issueId: issueId ?? (task.source.kind === 'github' ? task.source.issue.id : null),
      status: task.status, executionStatus: task.executionStatus, currentTurn: task.turnId ?? latestActivity?.turnId ?? null,
      threadId: task.threadId, turnId: task.turnId, chatId: task.chatId, resources: task.resources,
      latestActivity, waitingReason: waiting[0] ?? (task.reason ? boundedDashboardText(task.reason) : null) ?? (task.recovery.lastError ? boundedDashboardText(task.recovery.lastError) : null), requests: task.requests.map(request => ({ kind: request.kind, prompt: boundedDashboardText(request.prompt) })),
      recovery: task.recovery, createdAt: task.createdAt, updatedAt: task.updatedAt, latestReport: reports.at(-1) ?? null,
    };
  }

  projects(): ProjectDashboard[] {
    const tasks = this.store.tasks();
    const cards = new Map<string, ProjectTaskCard[]>();
    const states = new Map<string, ProjectState>();
    for (const task of tasks) {
      const ownership = this.projectForTask(task.id);
      if (!ownership) continue;
      const state = this.ledger.project(ownership.projectId);
      if (!state) continue;
      states.set(state.id, state);
      const issueId = state.members.find(member => member.taskId === task.id)?.issueId ?? null;
      const list = cards.get(state.id) ?? [];
      list.push(this.card(task, state.id, ownership.role, issueId)); cards.set(state.id, list);
    }
    return [...states.values()].sort((a, b) => a.name.localeCompare(b.name)).map(state => ({
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

  taskDetail(taskId: string): DashboardTaskDetail | null {
    const task = this.store.tasks().find(candidate => candidate.id === taskId);
    if (!task) return null;
    const ownership = this.projectForTask(taskId);
    const project = ownership ? this.ledger.project(ownership.projectId) : null;
    const reports = this.reportsForTask(taskId);
    return {
      task: ownership && project ? this.card(task, project.id, ownership.role, project.members.find(member => member.taskId === taskId)?.issueId ?? null) : null,
      projectId: ownership?.projectId ?? null,
      inputs: this.store.inputs(taskId), outputs: this.store.outputs(taskId), events: coalesce(this.allEvents(taskId)), reports,
      diagnostics: this.store.diagnostics().filter(row => row.scope === taskId || row.scope.endsWith(':' + taskId)),
    };
  }
}
