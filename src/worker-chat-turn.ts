import type { AgentOutput, Task } from './domain.js';
import type { Store } from './store.js';

export class WorkerChatTurn {
  private readonly turnKey: string;
  private readonly statusKey: string;

  constructor(private readonly store: Store, private readonly task: Task, threadId: string, readonly turnId: string) {
    this.turnKey = JSON.stringify([task.id, threadId, turnId]);
    this.statusKey = JSON.stringify(['worker-chat', threadId, turnId, task.chatId]);
  }

  private status(kind: 'working' | 'ended', after?: string): void {
    if (!this.task.chatId) return;
    const key = `${this.statusKey}:${kind}:${after ?? ''}`;
    if (this.store.hasOutput(this.task.id, key)) return;
    this.store.enqueueWorkerOutput(this.task.id, kind === 'working' ? '处理中' : '本轮已结束', key,
      { turn_key: this.turnKey, chat_id: this.task.chatId, kind });
  }

  get ended(): boolean {
    return this.store.hasOutput(this.task.id, `${this.statusKey}:ended:`);
  }

  start(): void { this.status('working'); }

  message(output: Pick<AgentOutput, 'id' | 'text' | 'phase'>, running: boolean): void {
    const key = `agent-output:${output.id}`;
    if (!output.text.trim() || this.store.hasOutput(this.task.id, key)) return;
    this.store.enqueueWorkerOutput(this.task.id, this.task.chatId || output.phase === 'final' ? output.text : '', key,
      { turn_key: this.turnKey, chat_id: this.task.chatId, kind: 'body' });
    if (running) this.status('working', output.id);
  }

  end(): void { this.status('ended'); }
}
