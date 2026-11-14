import { seedSavedIntake } from './saved-intake.js';
import type { AgentLoop } from '../src/loop.js';
import type { IncomingMessage } from '../src/domain.js';
import type { CodexPort } from '../src/ports.js';
import { CodexFake } from './fakes.js';
import { testProject, tickWithDirectGroups } from './coordinated-runtime.js';

export { testProject };

export class SurfaceCodex extends CodexFake {
  private readonly coordinators = new Set<string>();
  override async createThread(input: Parameters<CodexPort['createThread']>[0]) {
    const id = await super.createThread(input);
    if (input.instructions.includes('\nProject role: coordinator.')) this.coordinators.add(id);
    return id;
  }
  override async startTurn(input: Parameters<CodexPort['startTurn']>[0]) {
    const id = await super.startTurn(input);
    if (this.coordinators.has(input.threadId)) this.complete(input.threadId, null);
    return id;
  }
}

export async function restoreSurface(loop: AgentLoop, message: IncomingMessage) {
  if (message.chatType === 'p2p') { seedSavedIntake(loop, message); await tickWithDirectGroups(loop); }
  else await loop.receive(message);
  await loop.tick();
}

export async function tickSurface(loop: AgentLoop) {
  await tickWithDirectGroups(loop);
  await loop.tick();
}
