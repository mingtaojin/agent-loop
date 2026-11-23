import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { businessTaskIdSchema } from '../src/business-task.js';
import type { BusinessTaskCard, BusinessWorkerRow } from '../src/dashboard-reader.js';
import { dashboardScript } from '../src/dashboard-page.js';

class Element {
  childNodes: Element[] = [];
  textContent = '';
  className = '';
  value = '';
  hidden = false;
  dataset: Record<string, string> = {};
  listeners = new Map<string, () => void>();
  classList = { add: (name: string) => { this.className += ' ' + name; } };
  constructor(readonly tagName = '') {}
  append(...children: Element[]) { this.childNodes.push(...children); }
  replaceChildren(...children: Element[]) { this.childNodes = children; }
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
  querySelector(tagName: string): Element | undefined { return this.childNodes.find(child => child.tagName === tagName); }
  descendants(): Element[] { return this.childNodes.flatMap(child => [child, ...child.descendants()]); }
}

function worker(id: string, title: string, status: BusinessWorkerRow['status']): BusinessWorkerRow {
  return { id, title, status, role: 'worker', executionStatus: status === 'running' ? 'running' : 'idle',
    formalCompletion: 'open', summary: { kind: 'no-record', source: '无可用记录', text: '', at: null }, updatedAt: 0 };
}

function business(id: string, title: string, projectName: string, workers: BusinessWorkerRow[]): BusinessTaskCard {
  return { id: businessTaskIdSchema.parse(id), title, projectId: id + '-project', version: 1,
    source: { kind: 'coordinator-goal', coordinatorTaskId: 'coordinator', version: 1, key: id, text: title, createdAt: 0 },
    lifecycle: { kind: 'active', summary: title, at: 0, authorTaskId: 'coordinator' },
    owner: { taskId: 'coordinator', title: 'Coordinator' }, project: { id: id + '-project', name: projectName, directory: '/test' }, workers,
    counts: { taskStatus: { pending: 0, running: workers.filter(value => value.status === 'running').length, idle: workers.filter(value => value.status === 'idle').length, paused: 0, failed: 0 },
      executionStatus: { unbound: 0, idle: workers.filter(value => value.executionStatus === 'idle').length, running: workers.filter(value => value.executionStatus === 'running').length, completed: 0, interrupted: 0, failed: 0, unknown: 0 },
      formalCompletion: { open: workers.length, delivered: 0, terminated: 0 } } };
}

async function browser() {
  const elements = new Map<string, Element>();
  const element = (id: string) => { let value = elements.get(id); if (!value) { value = new Element(); elements.set(id, value); } return value; };
  const businessTasks = [
    business('migration', 'Migration goal', 'Orchid', [worker('renderer', 'Implement renderer', 'running'), worker('review', 'Review runtime', 'idle')]),
    business('unrelated', 'Release goal', 'Maple', [worker('release', 'Publish release', 'running')]),
    business('empty', 'Plan next goal', 'Birch', []),
  ];
  const context = createContext({
    document: { getElementById: element, createElement: (tag: string) => new Element(tag), createDocumentFragment: () => new Element(), querySelectorAll: () => [] },
    window: { addEventListener() {}, setInterval() {} },
    EventSource: class { static readonly OPEN = 1; },
    fetch: async () => ({ ok: true, json: async () => ({ tasks: [], projects: [], businessTasks, now: 0, runtime: null, dataDir: '/test' }) }),
  });
  runInContext(dashboardScript, context);
  await new Promise<void>(resolve => setImmediate(resolve));
  return {
    filter(query: string, status = '', role = '') {
      element('search').value = query; element('status-filter').value = status; element('role-filter').value = role;
      element('search').listeners.get('input')?.();
      return element('project-overview').descendants().filter(value => value.dataset.businessTaskId).map(card => ({
        id: card.dataset.businessTaskId, workers: card.descendants().flatMap(row => row.dataset.taskId ? [row.dataset.taskId] : []),
      }));
    },
  };
}

test('business title and project searches retain only their Workers matching the selected status and role', async () => {
  const page = await browser();
  for (const query of ['Migration goal', 'Orchid']) {
    assert.deepEqual(page.filter(query), [{ id: 'migration', workers: ['renderer', 'review'] }]);
    assert.deepEqual(page.filter(query, 'running'), [{ id: 'migration', workers: ['renderer'] }]);
    assert.deepEqual(page.filter(query, '', 'worker'), [{ id: 'migration', workers: ['renderer', 'review'] }]);
    assert.deepEqual(page.filter(query, 'running', 'worker'), [{ id: 'migration', workers: ['renderer'] }]);
    assert.deepEqual(page.filter(query, 'failed', 'worker'), []);
    assert.deepEqual(page.filter(query, '', 'coordinator'), []);
  }
});

test('Worker text search excludes unrelated siblings even when they match the selected state', async () => {
  const page = await browser();
  assert.deepEqual(page.filter('Implement renderer', 'running', 'worker'), [{ id: 'migration', workers: ['renderer'] }]);
  assert.deepEqual(page.filter('Review runtime', 'running', 'worker'), []);
  assert.deepEqual(page.filter('Review runtime', 'idle', 'worker'), [{ id: 'migration', workers: ['review'] }]);
});

test('a matching business with no Workers remains searchable until a Worker filter is selected', async () => {
  const page = await browser();
  assert.deepEqual(page.filter('Plan next goal'), [{ id: 'empty', workers: [] }]);
  assert.deepEqual(page.filter('Plan next goal', '', 'worker'), []);
});
