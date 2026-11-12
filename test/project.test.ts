import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { taskSchema, type Source, type SourceComment } from '../src/domain.js';
import { ProjectLedger, matchesProjectIssue, projectActionSchema, projectConfigSchema, projectStateSchema,
  type ProjectAction, type ProjectConfig, type ProjectState } from '../src/project.js';
import { Store } from '../src/store.js';

function config(id = 'alpha'): ProjectConfig {
  return projectConfigSchema.parse({ id, name: id, directory: `/projects/${id}`,
    repositories: [{ name: 'owner/frontend', labelsAny: ['project'], assigneesAny: ['alice'] },
      { name: 'owner/backend', assigneesAny: ['bob'] }] });
}
function source(fields: Partial<Source> = {}): Source {
  return { id: 'issue-1', repository: 'owner/frontend', number: 1, url: 'https://example.test/issues/1',
    title: 'Support export', body: 'Export the selected rows.', state: 'open', assignees: [], labels: ['project'],
    nativeType: 'Feature', updatedAt: '2026-11-12T01:00:00Z', isPullRequest: false, ...fields };
}
function comment(fields: Partial<SourceComment> = {}): SourceComment {
  return { id: 'comment-1', sourceId: 'issue-1', url: 'https://example.test/issues/1#comment-1',
    author: 'alice', body: 'Keep the selected order.', createdAt: '2026-11-12T02:00:00Z', updatedAt: '2026-11-12T02:00:00Z', ...fields };
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'project-ledger-'));
  let store = new Store(directory);
  let ledger = new ProjectLedger(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get store() { return store; }, get ledger() { return ledger; },
    create(projectConfig = config(), coordinator = 'coordinator') {
      return store.transaction(() => ledger.create(projectConfig, coordinator));
    },
    write<T>(action: (ledger: ProjectLedger) => T): T { return store.transaction(() => action(ledger)); },
    restart() { store.close(); store = new Store(directory); ledger = new ProjectLedger(store); },
    persisted(projectId = 'alpha') {
      const payload = store.meta(`project:${JSON.stringify(['state', projectId])}`);
      assert.notEqual(payload, null);
      return z.strictObject({ state: projectStateSchema,
        issueRevisions: z.array(z.object({ eventId: z.string(), source: z.object({ id: z.string(), title: z.string(), body: z.string() }) })),
        commentRevisions: z.array(z.object({ eventId: z.string(), comment: z.object({ id: z.string(), body: z.string() }) })),
      }).parse(JSON.parse(payload ?? 'null'));
    },
  };
}
function state(ledger: ProjectLedger, projectId = 'alpha'): ProjectState {
  const result = ledger.project(projectId);
  assert.ok(result);
  return result;
}

test('project config applies defaults and rejects empty selectors, duplicate repositories and unexpected settings', () => {
  const project = config();
  assert.equal(project.instructions, '');
  assert.equal(project.supervisionIntervalMs, 300_000);
  assert.deepEqual(project.models, { coordinator: 'gpt-6-astra', worker: 'gpt-6.1-sol' });
  assert.deepEqual(project.reasoningEfforts, { coordinator: 'high', worker: 'xhigh' });
  assert.deepEqual(project.repositories[1]?.labelsAny, []);
  const invalid: unknown[] = [
    { ...project, id: '' }, { ...project, id: ' ' }, { ...project, id: 'a\0b' },
    { ...project, name: ' ' }, { ...project, directory: '' }, { ...project, directory: 'a\0b' },
    { ...project, repositories: [] }, { ...project, repositories: [{ name: 'owner/frontend' }] },
    { ...project, repositories: [{ name: 'owner/frontend', labelsAny: [' '] }] },
    { ...project, repositories: [{ name: 'invalid', labelsAny: ['project'] }] },
    { ...project, repositories: [{ name: 'owner/frontend', labelsAny: ['project'], taskTypes: ['bug'] }] },
    { ...project, repositories: [project.repositories[0], project.repositories[0]] },
    { ...project, repositories: [project.repositories[0], { ...project.repositories[0], name: 'OWNER/Frontend' }] },
    { ...project, instructions: 'a'.repeat(131_073) }, { ...project, supervisionIntervalMs: 0 },
    { ...project, supervisionIntervalMs: 1.5 }, { ...project, supervisionIntervalMs: 2_147_483_648 },
    { ...project, workflow: 'bug-fix' },
    { ...project, reasoningEfforts: { worker: 'unsupported' } },
  ];
  for (const input of invalid) assert.equal(projectConfigSchema.safeParse(input).success, false);
});

test('project intake uses label OR assignee with no task-type gate, and only open issues in owned repositories', () => {
  const project = config();
  assert.equal(matchesProjectIssue(source(), project), true);
  assert.equal(matchesProjectIssue(source({ labels: [], assignees: ['ALICE'], nativeType: 'Unmapped' }), project), true);
  assert.equal(matchesProjectIssue(source({ labels: [], assignees: ['bob'], repository: 'OWNER/BACKEND' }), project), true);
  assert.equal(matchesProjectIssue(source({ labels: ['bug', 'enhancement', 'project'], nativeType: null }), project), true);
  assert.equal(matchesProjectIssue(source({ labels: [], assignees: ['other'] }), project), false);
  assert.equal(matchesProjectIssue(source({ repository: 'other/frontend', assignees: ['alice'] }), project), false);
  assert.equal(matchesProjectIssue(source({ state: 'closed' }), project), false);
  assert.equal(matchesProjectIssue(source({ isPullRequest: true }), project), false);
});

test('project actions are discriminated strict shapes with a default worker role', () => {
  const actions: ProjectAction[] = [
    { action: 'status' }, { action: 'dispatch', requestId: 'd', prompt: 'Investigate.', role: 'worker' },
    { action: 'dispatch', requestId: 'v', prompt: 'Verify.', role: 'verifier', issueId: 'issue-1' },
    { action: 'send', requestId: 's', taskId: 'worker', text: 'Preserve order.' },
    { action: 'report', requestId: 'r', kind: 'question', text: 'Which format?' },
    { action: 'report', requestId: 'r', kind: 'result', text: 'Evidence is ready.' },
    { action: 'report', requestId: 'r', kind: 'update', text: 'Still investigating.' },
    { action: 'record', requestId: 'n', key: 'decision', text: 'CSV.', expectedVersion: 0 },
    { action: 'rotate', requestId: 'rot', checkpoint: 'Resume with task worker.' },
    { action: 'release_workspace', requestId: 'rel', resourceId: 'resource' },
  ];
  for (const action of actions) assert.deepEqual(projectActionSchema.parse(action), action);
  assert.deepEqual(projectActionSchema.parse({ action: 'dispatch', requestId: 'd', prompt: 'Investigate.' }), actions[1]);
  for (const action of actions) assert.equal(projectActionSchema.safeParse({ ...action, projectId: 'other' }).success, false);
});

test('status accepts optional bounded paging without injecting defaults', () => {
  const unpaged: ProjectAction = { action: 'status' };
  assert.deepEqual(projectActionSchema.parse(unpaged), unpaged);
  for (const section of ['overview', 'issues', 'comments', 'records', 'tasks']) {
    const action = { action: 'status', section, offset: 0, limit: 100 };
    assert.deepEqual(projectActionSchema.parse(action), action);
  }
  for (const input of [{ section: 'all' }, { offset: -1 }, { offset: 0.5 }, { offset: Infinity },
    { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '10' }, { cursor: 'next' }])
    assert.equal(projectActionSchema.safeParse({ action: 'status', ...input }).success, false);
  assert.deepEqual(projectActionSchema.parse({ action: 'status', offset: 20 }), { action: 'status', offset: 20 });
});

test('project actions reject blank or oversized payloads and invalid record versions', () => {
  const invalid: unknown[] = [
    { action: 'dispatch', requestId: 'd', prompt: ' ' },
    { action: 'dispatch', requestId: 'd', prompt: 'p'.repeat(131_073) },
    { action: 'dispatch', requestId: 'd', prompt: 'Work.', role: 'coordinator' },
    { action: 'send', requestId: '', taskId: 'w', text: 'Hello.' },
    { action: 'send', requestId: 's', taskId: 'w'.repeat(513), text: 'Hello.' },
    { action: 'send', requestId: 's', taskId: 'w', text: '' },
    { action: 'report', requestId: 'r', kind: 'approval', text: 'Approved.' },
    { action: 'record', requestId: 'n', key: 'decision', text: 'CSV.', expectedVersion: -1 },
    { action: 'record', requestId: 'n', key: 'decision', text: 'CSV.', expectedVersion: 0.5 },
    { action: 'record', requestId: 'n', key: 'decision', text: 'CSV.', expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { action: 'rotate', requestId: 'r', checkpoint: ' ' },
    { action: 'release_workspace', requestId: 'r', resourceId: '\0' },
    { action: 'unknown' },
  ];
  for (const action of invalid) assert.equal(projectActionSchema.safeParse(action).success, false);
});

test('project creation is durable and idempotent while project and coordinator identities remain fixed', t => {
  const fx = fixture(t);
  assert.equal(fx.ledger.project('alpha'), null);
  assert.equal(fx.ledger.membership('unknown'), null);
  const created = fx.create();
  assert.equal(created.version, 0);
  assert.deepEqual(fx.ledger.membership('coordinator'), { projectId: 'alpha', role: 'coordinator' });
  assert.deepEqual(fx.create(), created);
  fx.restart();
  assert.deepEqual(fx.create(), created);
  assert.throws(() => fx.create({ ...config(), directory: '/elsewhere' }));
  assert.throws(() => fx.create(config(), 'replacement'));
  assert.throws(() => fx.create(config('beta'), 'coordinator'));
  assert.equal(fx.ledger.project('beta'), null);
});

test('membership adopts existing tasks without rewriting their payload or creating a new execution', t => {
  const fx = fixture(t);
  const task = taskSchema.parse({ id: 'existing', sourceId: 'manual-existing', source: { kind: 'manual', message: {
    id: 'original', chatId: 'existing-chat', senderId: 'owner', text: 'Existing work.', attachments: [], createdAt: 1,
  } }, contextDirectory: '/existing', resources: [], status: 'running', reason: null,
  prompt: 'Original prompt.', promptHash: 'original', skillPath: null, chatId: 'existing-chat', threadId: 'existing-thread',
  turnId: 'active-turn', lastHandledTurnId: null, requests: [], createdAt: 1, updatedAt: 2 });
  fx.store.saveTask(task);
  fx.create();
  fx.write(ledger => ledger.issue('alpha', source()));
  fx.write(ledger => ledger.addMember('alpha', task.id, 'worker', 'issue-1'));
  fx.write(ledger => ledger.addMember('alpha', task.id, 'worker', 'issue-1'));
  assert.deepEqual(fx.store.task(task.id), task);
  assert.equal(fx.store.tasks().length, 1);
  assert.equal(fx.store.inputs(task.id).length, 0);
  fx.restart();
  assert.deepEqual(fx.ledger.membership(task.id), { projectId: 'alpha', role: 'worker' });
  assert.deepEqual(state(fx.ledger).members, [{ taskId: 'coordinator', role: 'coordinator' },
    { taskId: 'existing', role: 'worker', issueId: 'issue-1' }]);
  assert.deepEqual(fx.store.task(task.id), task);
});

test('membership rejects cross-project reuse, role changes and missing issue associations', t => {
  const fx = fixture(t);
  fx.create(); fx.create(config('beta'), 'beta-coordinator');
  fx.write(ledger => ledger.addMember('alpha', 'worker', 'worker'));
  assert.throws(() => fx.write(ledger => ledger.addMember('beta', 'worker', 'worker')));
  assert.throws(() => fx.write(ledger => ledger.addMember('alpha', 'worker', 'verifier')));
  assert.throws(() => fx.write(ledger => ledger.addMember('alpha', 'second-coordinator', 'coordinator')));
  assert.throws(() => fx.write(ledger => ledger.addMember('alpha', 'new-worker', 'worker', 'missing')));
  assert.throws(() => fx.write(ledger => ledger.addMember('missing', 'new-worker', 'worker')));
  assert.equal(fx.ledger.membership('new-worker'), null);
  assert.deepEqual(fx.ledger.membership('worker'), { projectId: 'alpha', role: 'worker' });
});

test('issue snapshots persist immutable semantic revisions and replay distinct changes only', t => {
  const fx = fixture(t); fx.create();
  const original = source({ labels: ['project', 'enhancement'], assignees: ['alice', 'bob'] });
  const first = fx.write(ledger => ledger.issue('alpha', original));
  assert.equal(first.changed, true);
  assert.deepEqual(fx.ledger.issue('alpha', original), { changed: false, eventId: first.eventId });
  const refresh = { ...original, labels: ['enhancement', 'project'], assignees: ['bob', 'alice'], updatedAt: '2026-11-12T02:00:00Z' };
  assert.deepEqual(fx.ledger.issue('alpha', refresh), { changed: false, eventId: first.eventId });
  assert.deepEqual(state(fx.ledger).issues, [refresh]);
  const update = { ...refresh, title: 'Export CSV', updatedAt: '2026-11-12T03:00:00Z' };
  const second = fx.ledger.issue('alpha', update);
  assert.equal(second.changed, true); assert.notEqual(second.eventId, first.eventId);
  fx.restart();
  assert.deepEqual(fx.ledger.issue('alpha', update), { changed: false, eventId: second.eventId });
  assert.equal(fx.ledger.issue('alpha', original).changed, false);
  assert.deepEqual(state(fx.ledger).issues, [update]);
  const third = fx.ledger.issue('alpha', { ...original, updatedAt: '2026-11-12T04:00:00Z' });
  assert.equal(third.changed, true); assert.notEqual(third.eventId, first.eventId);
  const document = fx.persisted();
  assert.deepEqual(document.issueRevisions.map(revision => [revision.eventId, revision.source.title]),
    [[first.eventId, 'Support export'], [second.eventId, 'Export CSV'], [third.eventId, 'Support export']]);
  assert.equal(document.state.version, 0);
});

test('owned issue updates retain closure and selector changes without invoking workflow policy', t => {
  const fx = fixture(t); fx.create();
  fx.ledger.issue('alpha', source());
  const update = source({ state: 'closed', labels: [], assignees: [], body: 'Closed upstream.', updatedAt: '2026-11-12T05:00:00Z' });
  assert.equal(fx.ledger.issue('alpha', update).changed, true);
  assert.deepEqual(state(fx.ledger).issues, [update]);
  assert.throws(() => fx.ledger.issue('alpha', { ...update, repository: 'owner/other', updatedAt: '2026-11-12T06:00:00Z' }));
  assert.throws(() => fx.ledger.issue('alpha', { ...update, number: 2, updatedAt: '2026-11-12T06:00:00Z' }));
  assert.throws(() => fx.ledger.issue('alpha', { ...update, repository: 'owner/other', updatedAt: '2026-11-12T01:00:00Z' }));
  assert.deepEqual(state(fx.ledger).issues, [update]);
});

test('comment revisions preserve provenance, survive restart and deduplicate retried deliveries', t => {
  const fx = fixture(t); fx.create(); fx.ledger.issue('alpha', source());
  const original = comment();
  const first = fx.ledger.comment('alpha', original);
  assert.equal(first.changed, true);
  assert.deepEqual(fx.ledger.comment('alpha', original), { changed: false, eventId: first.eventId });
  const refresh = { ...original, updatedAt: '2026-11-12T03:00:00Z' };
  assert.deepEqual(fx.ledger.comment('alpha', refresh), { changed: false, eventId: first.eventId });
  const edit = { ...original, body: 'Preserve the original order.', updatedAt: '2026-11-12T04:00:00Z' };
  const second = fx.ledger.comment('alpha', edit);
  assert.equal(second.changed, true); assert.notEqual(second.eventId, first.eventId);
  fx.restart();
  assert.deepEqual(fx.ledger.comment('alpha', edit), { changed: false, eventId: second.eventId });
  assert.equal(fx.ledger.comment('alpha', original).changed, false);
  assert.deepEqual(state(fx.ledger).comments, [edit]);
  assert.equal(fx.ledger.comment('alpha', { ...original, updatedAt: '2026-11-12T05:00:00Z' }).changed, true);
  assert.deepEqual(fx.persisted().commentRevisions.map(revision => revision.comment.body),
    [original.body, edit.body, original.body]);
});

test('comment identity cannot move to another issue or author and unknown source references fail atomically', t => {
  const fx = fixture(t); fx.create(); fx.ledger.issue('alpha', source());
  assert.throws(() => fx.ledger.comment('alpha', comment({ sourceId: 'missing' })));
  fx.ledger.issue('alpha', source({ id: 'issue-2', number: 2 }));
  fx.ledger.comment('alpha', comment());
  assert.throws(() => fx.ledger.comment('alpha', comment({ sourceId: 'issue-2' })));
  assert.throws(() => fx.ledger.comment('alpha', comment({ author: 'mallory' })));
  assert.throws(() => fx.ledger.comment('alpha', comment({ author: 'mallory', updatedAt: '2026-11-11T01:00:00Z' })));
  assert.throws(() => fx.ledger.comment('alpha', comment({ createdAt: '2026-11-11T02:00:00Z' })));
  assert.deepEqual(state(fx.ledger).comments, [comment()]);
  assert.equal(fx.persisted().commentRevisions.length, 1);
});

test('semantic changes and reversions remain observable within the same upstream timestamp', t => {
  const fx = fixture(t); fx.create();
  const firstIssue = fx.ledger.issue('alpha', source());
  const secondIssue = fx.ledger.issue('alpha', source({ body: 'Changed.' }));
  const thirdIssue = fx.ledger.issue('alpha', source());
  assert.equal(secondIssue.changed, true); assert.equal(thirdIssue.changed, true);
  assert.notEqual(firstIssue.eventId, thirdIssue.eventId);
  assert.deepEqual(fx.ledger.issue('alpha', source()), { changed: false, eventId: thirdIssue.eventId });
  const firstComment = fx.ledger.comment('alpha', comment());
  const secondComment = fx.ledger.comment('alpha', comment({ body: 'Changed.' }));
  const thirdComment = fx.ledger.comment('alpha', comment());
  assert.equal(secondComment.changed, true); assert.equal(thirdComment.changed, true);
  assert.notEqual(firstComment.eventId, thirdComment.eventId);
  assert.deepEqual(fx.ledger.comment('alpha', comment()), { changed: false, eventId: thirdComment.eventId });
  assert.equal(fx.persisted().issueRevisions.length, 3);
  assert.equal(fx.persisted().commentRevisions.length, 3);
});

test('receipts scope request identity by project and caller and reject conflicting retries', t => {
  const fx = fixture(t); fx.create(); fx.create(config('beta'), 'beta-coordinator');
  fx.write(ledger => ledger.addMember('alpha', 'worker', 'worker'));
  assert.equal(fx.ledger.receipt('alpha', 'coordinator', 'same'), null);
  fx.ledger.saveReceipt('alpha', 'coordinator', 'same', 'dispatch-one', { taskId: 'worker', status: 'created' });
  fx.ledger.saveReceipt('alpha', 'coordinator', 'same', 'dispatch-one', { status: 'created', taskId: 'worker' });
  fx.ledger.saveReceipt('alpha', 'worker', 'same', 'report-one', null);
  fx.ledger.saveReceipt('beta', 'beta-coordinator', 'same', 'dispatch-two', ['another-task']);
  fx.restart();
  assert.deepEqual(fx.ledger.receipt('alpha', 'coordinator', 'same'),
    { fingerprint: 'dispatch-one', value: { taskId: 'worker', status: 'created' } });
  assert.deepEqual(fx.ledger.receipt('alpha', 'worker', 'same'), { fingerprint: 'report-one', value: null });
  assert.deepEqual(fx.ledger.receipt('beta', 'beta-coordinator', 'same'), { fingerprint: 'dispatch-two', value: ['another-task'] });
  assert.throws(() => fx.ledger.saveReceipt('alpha', 'coordinator', 'same', 'different', {}));
  assert.throws(() => fx.ledger.saveReceipt('alpha', 'coordinator', 'same', 'dispatch-one', { taskId: 'different' }));
  assert.throws(() => fx.ledger.receipt('beta', 'coordinator', 'same'));
  assert.throws(() => fx.ledger.saveReceipt('alpha', 'outsider', 'same', 'f', {}));
  for (const value of [undefined, NaN, Infinity, BigInt(1), () => 1, { nested: undefined }])
    assert.throws(() => fx.ledger.saveReceipt('alpha', 'coordinator', 'invalid', 'f', value));
  assert.equal(fx.ledger.receipt('alpha', 'coordinator', 'invalid'), null);
});

test('metadata tuple keys cannot collide when task or request identifiers contain delimiters', t => {
  const fx = fixture(t); fx.create();
  fx.write(ledger => ledger.addMember('alpha', 'worker:one', 'worker'));
  fx.write(ledger => ledger.addMember('alpha', 'worker', 'worker'));
  fx.ledger.saveReceipt('alpha', 'worker:one', 'two', 'f1', 'first');
  fx.ledger.saveReceipt('alpha', 'worker', 'one:two', 'f2', 'second');
  assert.equal(fx.ledger.receipt('alpha', 'worker:one', 'two')?.value, 'first');
  assert.equal(fx.ledger.receipt('alpha', 'worker', 'one:two')?.value, 'second');
});

test('record CAS rejects stale writers and idempotent retries preserve immutable history', t => {
  const fx = fixture(t); fx.create();
  fx.write(ledger => ledger.addMember('alpha', 'worker', 'worker'));
  const original = { requestId: 'decision-1', key: 'format', text: 'CSV.', expectedVersion: 0, authorTaskId: 'coordinator' };
  const first = fx.write(ledger => ledger.record('alpha', original));
  assert.equal(first.version, 1);
  assert.equal(first.records[0]?.text, 'CSV.');
  assert.ok((first.records[0]?.createdAt ?? 0) > 0);
  assert.throws(() => fx.ledger.record('alpha', { ...original, requestId: 'stale', text: 'JSON.' }));
  const second = fx.write(ledger => ledger.record('alpha', {
    requestId: 'decision-2', key: 'format', text: 'JSON.', expectedVersion: 1, authorTaskId: 'worker',
  }));
  assert.equal(second.version, 2);
  fx.restart();
  assert.deepEqual(fx.ledger.record('alpha', original), second);
  assert.equal(state(fx.ledger).records.length, 2);
  assert.throws(() => fx.ledger.record('alpha', { ...original, key: 'other' }));
  assert.throws(() => fx.ledger.record('alpha', { ...original, text: 'Changed.' }));
  assert.throws(() => fx.ledger.record('alpha', { ...original, expectedVersion: 2 }));
  assert.throws(() => fx.ledger.record('alpha', { ...original, requestId: 'outsider', expectedVersion: 2, authorTaskId: 'unknown' }));
  assert.deepEqual(state(fx.ledger), second);
});

test('record request IDs are scoped to their author while the CAS version is project-wide', t => {
  const fx = fixture(t); fx.create();
  fx.write(ledger => ledger.addMember('alpha', 'verifier', 'verifier'));
  const input = { requestId: 'shared', key: 'evidence', text: 'Author report.', expectedVersion: 0, authorTaskId: 'coordinator' };
  fx.ledger.record('alpha', input);
  const second = fx.ledger.record('alpha', { ...input, text: 'Independent result.', expectedVersion: 1, authorTaskId: 'verifier' });
  assert.deepEqual(second.records.map(record => [record.authorTaskId, record.version]), [['coordinator', 1], ['verifier', 2]]);
});

test('save validates relational state invariants and forbids rewriting durable identities and history', t => {
  const fx = fixture(t); fx.create();
  fx.ledger.issue('alpha', source()); fx.ledger.comment('alpha', comment());
  fx.ledger.record('alpha', { requestId: 'r', key: 'decision', text: 'CSV.', expectedVersion: 0, authorTaskId: 'coordinator' });
  const original = state(fx.ledger);
  const invalid: unknown[] = [
    { ...original, unknown: true }, { ...original, directory: '/moved' },
    { ...original, coordinatorTaskId: 'different' }, { ...original, members: [] },
    { ...original, members: [...original.members, ...original.members] },
    { ...original, members: [...original.members, { taskId: 'other', role: 'coordinator' }] },
    { ...original, issues: [] }, { ...original, comments: [] },
    { ...original, issues: [source(), source({ id: 'duplicate' })] },
    { ...original, comments: [comment(), comment()] },
    { ...original, comments: [comment({ sourceId: 'missing' })] },
    { ...original, records: [], version: 0 }, { ...original, version: 2 },
    { ...original, records: original.records.map(record => ({ ...record, text: 'Changed.' })) },
    { ...original, records: original.records.map(record => ({ ...record, authorTaskId: 'outsider' })) },
    { ...original, records: original.records.map(record => ({ ...record, version: 2 })) },
  ];
  for (const input of invalid) {
    assert.throws(() => fx.write(ledger => ledger.save(projectStateSchema.parse(input))));
    assert.deepEqual(state(fx.ledger), original);
  }
  fx.write(ledger => ledger.save({ ...original, name: 'New display name' }));
  assert.equal(state(fx.ledger).name, 'New display name');
  assert.equal(fx.persisted().issueRevisions.length, 1);
  assert.equal(fx.persisted().commentRevisions.length, 1);
});

test('caller transactions atomically roll back project membership, revisions, records and receipts', t => {
  const fx = fixture(t);
  assert.throws(() => fx.write(ledger => { ledger.create(config(), 'coordinator'); throw new Error('Abort create'); }));
  assert.equal(fx.ledger.project('alpha'), null);
  assert.equal(fx.ledger.membership('coordinator'), null);
  fx.create();
  const original = state(fx.ledger);
  assert.throws(() => fx.write(ledger => {
    ledger.issue('alpha', source()); ledger.comment('alpha', comment());
    ledger.addMember('alpha', 'worker', 'worker', 'issue-1');
    ledger.record('alpha', { requestId: 'r', key: 'decision', text: 'CSV.', expectedVersion: 0, authorTaskId: 'coordinator' });
    ledger.saveReceipt('alpha', 'coordinator', 'dispatch', 'f', { taskId: 'worker' });
    throw new Error('Abort dispatch');
  }));
  assert.deepEqual(state(fx.ledger), original);
  assert.equal(fx.ledger.membership('worker'), null);
  assert.equal(fx.ledger.receipt('alpha', 'coordinator', 'dispatch'), null);
  assert.equal(fx.persisted().issueRevisions.length, 0);
  assert.equal(fx.persisted().commentRevisions.length, 0);
  fx.write(ledger => ledger.addMember('alpha', 'worker', 'worker'));
  assert.deepEqual(fx.ledger.membership('worker'), { projectId: 'alpha', role: 'worker' });
});

test('reads and returned snapshots do not alias persisted state and malformed persisted data fails validation', t => {
  const fx = fixture(t); fx.create(); fx.ledger.issue('alpha', source());
  const snapshot = state(fx.ledger);
  snapshot.members.push({ taskId: 'invented', role: 'worker' });
  snapshot.issues[0]?.labels.push('unexpected');
  assert.equal(fx.ledger.membership('invented'), null);
  assert.deepEqual(state(fx.ledger).issues, [source()]);
  const key = `project:${JSON.stringify(['state', 'alpha'])}`;
  const payload = fx.store.meta(key);
  fx.store.setMeta(key, JSON.stringify({ state: { ...state(fx.ledger), version: 9 }, issueRevisions: [], commentRevisions: [] }));
  assert.throws(() => fx.ledger.project('alpha'));
  assert.ok(payload); fx.store.setMeta(key, payload);
  fx.store.setMeta(`project:${JSON.stringify(['member', 'coordinator'])}`, JSON.stringify({ projectId: 'alpha', role: 'worker' }));
  assert.throws(() => fx.ledger.membership('coordinator'));
});

test('persisted revision history must retain its source identity and agree with the current snapshot', t => {
  const fx = fixture(t); fx.create();
  const issueEvent = fx.ledger.issue('alpha', source()).eventId;
  const commentEvent = fx.ledger.comment('alpha', comment()).eventId;
  const key = `project:${JSON.stringify(['state', 'alpha'])}`;
  const original = fx.store.meta(key);
  assert.ok(original);
  const issueRevision = { eventId: issueEvent, source: source() };
  const commentRevision = { eventId: commentEvent, comment: comment() };
  const current = state(fx.ledger);
  const variants = [
    { issueRevisions: [], commentRevisions: [commentRevision] },
    { issueRevisions: [issueRevision], commentRevisions: [] },
    { issueRevisions: [{ ...issueRevision, source: source({ body: 'Forged body.' }) }], commentRevisions: [commentRevision] },
    { issueRevisions: [{ ...issueRevision, source: source({ id: 'missing' }) }], commentRevisions: [commentRevision] },
    { issueRevisions: [issueRevision], commentRevisions: [{ ...commentRevision, comment: comment({ author: 'forged-author' }) }] },
    { issueRevisions: [issueRevision], commentRevisions: [{ ...commentRevision, comment: comment({ body: 'Forged comment.' }) }] },
    { issueRevisions: [issueRevision, { ...issueRevision, eventId: 'duplicate-content' }], commentRevisions: [commentRevision] },
    { issueRevisions: [issueRevision], commentRevisions: [{ ...commentRevision, eventId: issueEvent }] },
  ];
  for (const history of variants) {
    fx.store.setMeta(key, JSON.stringify({ state: current, ...history }));
    assert.throws(() => fx.ledger.project('alpha'));
  }
  fx.store.setMeta(key, original);
  assert.deepEqual(state(fx.ledger), current);
});
