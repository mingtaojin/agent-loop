import { LiveExecution } from '../src/live-execution.js';
import { executionKey, type ExecutionEvent, type ExecutionHistory } from '../src/execution-events.js';

export class ExecutionFixture {
  readonly history = new Map<string, ExecutionHistory>();
  readonly reads: string[] = [];
  unavailable = false;
  execution = this.newFeed();
  private newFeed(): LiveExecution { return new LiveExecution({ readHistory: async threadId => {
    this.reads.push(threadId);
    if (this.unavailable) throw new Error('History unavailable');
    return structuredClone(this.history.get(threadId) ?? []);
  } }); }
  restart(): void { this.execution = this.newFeed(); }
  publish(taskId: string, event: ExecutionEvent): void {
    if (event.kind !== 'tool_output') {
      const entries = this.history.get(event.threadId) ?? [];
      const key = executionKey(event), index = entries.findIndex(item => item.key === key), previous = entries[index];
      if (event.kind === 'agent_delta' && !previous) this.execution.publish(taskId, { ...event, kind: 'agent_start', text: '' });
      if (!(event.kind === 'agent_delta' && previous?.kind === 'agent_message')) {
        const item = { ...event, key, text: event.kind === 'agent_delta' ? (previous?.text ?? '') + event.text : event.text };
        if (index < 0) entries.push(item); else entries[index] = item;
        this.history.set(event.threadId, entries);
      }
    }
    this.execution.publish(taskId, event);
  }
}
