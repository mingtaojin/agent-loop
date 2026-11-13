import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { documentTextElements } from '../feishu-document-text.js';
import { DocumentRequestRejected, TaskGroupUnavailable, type FeishuDocumentProgressPort, type ProgressWriteGuard } from '../ports.js';

export type FeishuDocumentApi = {
  document: Pick<Client['docx']['v1']['document'], 'create'>;
  children: Pick<Client['docx']['v1']['documentBlockChildren'], 'create' | 'get' | 'batchDelete'>;
  block: Pick<Client['docx']['v1']['documentBlock'], 'get' | 'patch'>;
  members: Pick<Client['drive']['v1']['permissionMember'], 'create' | 'list'>;
  tabs: Pick<Client['im']['v1']['chatTab'], 'create' | 'listTabs'>;
};
const id = z.string().min(1);
const envelope = z.object({ code: z.number().int(), msg: z.string().optional(), data: z.unknown().optional() });
const textElement = z.object({ text_run: z.object({ content: z.string() }) });
const textBlock = z.object({ block_id: id, block_type: z.literal(2), text: z.object({ elements: z.array(textElement) }) });
const childBlock = z.object({ block_id: id, block_type: z.number().int(), text: z.unknown().optional() });
const member = z.object({ member_type: id, member_id: id, perm: z.enum(['view', 'edit', 'full_access']) });
const tabsSchema = z.object({ chat_tabs: z.array(z.object({ tab_id: id, tab_type: id,
  tab_content: z.object({ doc: z.url().optional() }).optional() })) });
// Server/internal errors are ambiguous. Only documented request rejections permit a fresh create.
const rejectedCodes = new Set([99991672, 99991400,
  1770001, 1770002, 1770003, 1770004, 1770005, 1770006, 1770007, 1770032, 1770040,
  1063001, 1063002, 1063003, 1063004, 1063005, 1063006,
  232001, 232006, 232009, 232010, 232011, 232024, 232025, 232033, 232034, 232046, 232047, 232048, 232050, 232051, 232055]);
function check(raw: unknown): unknown {
  const result = envelope.parse(raw);
  if (result.code !== 0) {
    const message = `Feishu document API ${result.code}: ${result.msg ?? 'request failed'}`;
    if (result.code === 232009 || result.code === 232006) throw new TaskGroupUnavailable(result.code, message);
    if (rejectedCodes.has(result.code)) throw new DocumentRequestRejected(message);
    throw new Error(message);
  }
  if (result.data == null) throw new Error('Feishu document response has no data');
  return result.data;
}
function unique(ids: string[]): string | null {
  if (ids.length > 1) throw new Error('Multiple matching document entries; reconciliation is ambiguous');
  return ids[0] ?? null;
}
function blockText(raw: unknown, blockId?: string): string {
  const block = textBlock.parse(raw);
  if (blockId && block.block_id !== blockId) throw new Error('Document block identity mismatch');
  return block.text.elements.map(element => element.text_run.content).join('');
}

export class FeishuDocumentAdapter implements FeishuDocumentProgressPort {
  private nextRequestAt = 0;
  private lane: Promise<void> = Promise.resolve();
  constructor(private readonly api: () => FeishuDocumentApi,
    private readonly clock: { now(): number; sleep(ms: number): Promise<void> } = { now: Date.now, sleep: delay }) {}
  private async call(request: () => Promise<unknown>, guard?: ProgressWriteGuard): Promise<unknown> {
    const slot = this.lane.catch(() => undefined).then(async () => {
      const wait = this.nextRequestAt - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      this.nextRequestAt = this.clock.now() + 500;
    });
    this.lane = slot;
    await slot;
    guard?.();
    let raw: unknown;
    try { raw = await request(); }
    catch (error) {
      const response = z.object({ response: z.object({ status: z.number(), data: z.unknown() }) }).safeParse(error);
      if (response.success && response.data.response.status < 500) check(response.data.response.data);
      throw error;
    }
    return check(raw);
  }
  async createDocument(input: Parameters<FeishuDocumentProgressPort['createDocument']>[0], guard?: ProgressWriteGuard): Promise<string> {
    const data = await this.call(() => this.api().document.create({ data: { title: input.title } }), guard);
    return z.object({ document: z.object({ document_id: id }) }).parse(data).document.document_id;
  }
  async createBlock(input: Parameters<FeishuDocumentProgressPort['createBlock']>[0], guard?: ProgressWriteGuard): Promise<string> {
    const index = z.number().int().min(-1).parse(input.index ?? -1);
    const elements = documentTextElements(input.text);
    const data = await this.call(() => this.api().children.create({ path: { document_id: input.documentId, block_id: input.parentBlockId ?? input.documentId },
      params: { document_revision_id: -1, client_token: input.clientToken },
      data: { children: [{ block_type: 2, text: { elements } }], index } }), guard);
    const result = z.object({ children: z.array(textBlock).length(1), client_token: z.literal(input.clientToken) }).parse(data);
    const block = result.children[0];
    if (!block || blockText(block) !== input.text) throw new Error('Created document block does not match intent');
    return block.block_id;
  }
  async findBlock(input: Parameters<FeishuDocumentProgressPort['findBlock']>[0]): Promise<string | null> {
    const index = input.index === undefined ? undefined : z.number().int().nonnegative().parse(input.index);
    const children = await this.children({ documentId: input.documentId, parentBlockId: input.parentBlockId ?? input.documentId });
    if (index !== undefined) {
      const child = children[index];
      if (!child) return null;
      const text = textBlock.safeParse(child);
      if (!text.success || blockText(text.data) !== input.text) throw new Error('Document child at saved index does not match intent');
      return child.block_id;
    }
    return unique(children.flatMap(child => {
      const text = textBlock.safeParse(child);
      return text.success && blockText(text.data) === input.text ? [child.block_id] : [];
    }));
  }
  private async children(input: { documentId: string; parentBlockId: string }): Promise<z.infer<typeof childBlock>[]> {
    const children: z.infer<typeof childBlock>[] = [], seen = new Set<string>(), ids = new Set<string>();
    let pageToken: string | undefined;
    for (;;) {
      const data = await this.call(() => this.api().children.get({ path: { document_id: input.documentId, block_id: input.parentBlockId },
        params: { document_revision_id: -1, page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) } }));
      const result = z.object({ items: z.array(childBlock),
        has_more: z.boolean(), page_token: id.optional() }).parse(data);
      for (const block of result.items) {
        if (ids.has(block.block_id)) throw new Error('Duplicate document child identity in listing');
        ids.add(block.block_id); children.push(block);
      }
      if (!result.has_more) return children;
      if (!result.page_token || seen.has(result.page_token)) throw new Error('Incomplete document child pagination');
      pageToken = result.page_token; seen.add(pageToken);
    }
  }
  async removeBlocks(input: Parameters<FeishuDocumentProgressPort['removeBlocks']>[0], guard?: ProgressWriteGuard): Promise<void> {
    if (!input.blockIds.length) return;
    if (new Set(input.blockIds).size !== input.blockIds.length) throw new Error('Duplicate owned document block identity');
    const children = await this.children(input);
    const owned = new Set(input.blockIds);
    const remaining = children.filter(child => owned.has(child.block_id));
    if (!remaining.length) return;
    const start = children.length - input.blockIds.length;
    if (remaining.length !== input.blockIds.length || start < 0 || input.blockIds.some((blockId, index) => children[start + index]?.block_id !== blockId)) {
      throw new Error('Owned document blocks are not the complete expected suffix');
    }
    const data = await this.call(() => this.api().children.batchDelete({ path: { document_id: input.documentId, block_id: input.parentBlockId },
      params: { document_revision_id: -1, client_token: input.clientToken }, data: { start_index: start, end_index: children.length } }), guard);
    z.object({ client_token: z.literal(input.clientToken) }).parse(data);
  }
  async readBlock(input: Parameters<FeishuDocumentProgressPort['readBlock']>[0]): Promise<string> {
    const data = await this.call(() => this.api().block.get({ path: { document_id: input.documentId, block_id: input.blockId }, params: { document_revision_id: -1 } }));
    return blockText(z.object({ block: z.unknown() }).parse(data).block, input.blockId);
  }
  async replaceContent(input: Parameters<FeishuDocumentProgressPort['replaceContent']>[0], guard?: ProgressWriteGuard): Promise<void> {
    const elements = documentTextElements(input.text);
    const data = await this.call(() => this.api().block.patch({ path: { document_id: input.documentId, block_id: input.blockId },
      params: { document_revision_id: -1, client_token: input.clientToken }, data: { update_text_elements: { elements } } }), guard);
    const result = z.object({ block: textBlock, client_token: z.literal(input.clientToken) }).parse(data);
    if (blockText(result.block, input.blockId) !== input.text) throw new Error('Document write response does not match intent');
  }
  async grantGroupRead(input: Parameters<FeishuDocumentProgressPort['grantGroupRead']>[0], guard?: ProgressWriteGuard): Promise<void> {
    const data = await this.call(() => this.api().members.create({ path: { token: input.documentId }, params: { type: 'docx', need_notification: false },
      data: { member_type: 'openchat', member_id: input.chatId, perm: 'view' } }), guard);
    z.object({ member: member.extend({ member_type: z.literal('openchat'), member_id: z.literal(input.chatId), perm: z.literal('view') }) }).parse(data);
  }
  async hasGroupRead(input: Parameters<FeishuDocumentProgressPort['hasGroupRead']>[0]): Promise<boolean> {
    const data = await this.call(() => this.api().members.list({ path: { token: input.documentId }, params: { type: 'docx' } }));
    return z.object({ items: z.array(member) }).parse(data).items.some(item => item.member_type === 'openchat' && item.member_id === input.chatId);
  }
  async findTab(input: Parameters<FeishuDocumentProgressPort['findTab']>[0]): Promise<string | null> {
    const data = await this.call(() => this.api().tabs.listTabs({ path: { chat_id: input.chatId } }));
    return unique(tabsSchema.parse(data).chat_tabs.filter(tab => tab.tab_type === 'doc' && tab.tab_content?.doc === input.documentUrl).map(tab => tab.tab_id));
  }
  async createTab(input: Parameters<FeishuDocumentProgressPort['createTab']>[0], guard?: ProgressWriteGuard): Promise<string> {
    const data = await this.call(() => this.api().tabs.create({ path: { chat_id: input.chatId },
      data: { chat_tabs: [{ tab_name: '执行进度', tab_type: 'doc', tab_content: { doc: input.documentUrl } }] } }), guard);
    const tabId = unique(tabsSchema.parse(data).chat_tabs.filter(tab => tab.tab_type === 'doc' && tab.tab_content?.doc === input.documentUrl).map(tab => tab.tab_id));
    if (!tabId) throw new Error('Created tab response does not match document');
    return tabId;
  }
}
