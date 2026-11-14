import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, WSClient, EventDispatcher, Domain, LoggerLevel, defaultHttpInstance, type HttpInstance, type HttpRequestOptions } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { UncertainOperationError, errorMessage, type ApprovalAction, type Attachment, type IncomingMessage, type PendingRequest } from '../domain.js';
import { FeishuApiError, GroupCreationRejected, TaskGroupUnavailable, type FeishuPort, type FeishuProgressPort, type FeishuReconnectEvent, type ProgressWriteGuard } from '../ports.js';
import { FeishuDocumentAdapter, type FeishuDocumentApi } from './feishu-document.js';

export interface FeishuOptions {
  appId: string;
  appSecret: string;
  userOpenId: string;
  requestTimeoutMs?: number;
}
type FeishuApi = {
  chat: Pick<Client['im']['v1']['chat'], 'list' | 'get' | 'create'> & Partial<Pick<Client['im']['v1']['chat'], 'delete'>>;
  message: Pick<Client['im']['v1']['message'], 'list' | 'create'>;
  messageResource: Pick<Client['im']['v1']['messageResource'], 'get'>;
};
export interface FeishuDependencies {
  document?: FeishuDocumentApi;
  api?: FeishuApi;
  cardkit?: { card: Pick<Client['cardkit']['v1']['card'], 'create' | 'settings' | 'idConvert'>; cardElement: Pick<Client['cardkit']['v1']['cardElement'], 'content'> };
  socket?: Pick<WSClient, 'start' | 'close'>;
}
const id = z.string().min(1);
const progressCardTitle = '执行进度';
const progressCardSchema = z.object({ schema: z.literal('2.0'), header: z.object({
  title: z.object({ tag: z.literal('plain_text'), content: z.literal(progressCardTitle) }),
}) });
const progressMessagesSchema = z.array(z.union([
  z.object({ deleted: z.literal(true) }),
  z.object({ deleted: z.literal(false).optional(), message_id: id, chat_id: id, msg_type: id,
    body: z.object({ content: z.string() }).optional() }),
])).max(50);
const progressLookupRequestLimit = 12;
const timestamp = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().safe().nonnegative());
const eventSchema = z.object({
  sender: z.object({ sender_type: z.string(), sender_id: z.object({ open_id: id.optional() }).optional() }),
  message: z.object({ message_id: id, chat_id: id, chat_type: z.enum(['p2p', 'group']).default('group'), create_time: timestamp, message_type: id, content: z.string() }),
});
const historySchema = z.object({
  message_id: id, chat_id: id, create_time: timestamp, msg_type: id, deleted: z.boolean().optional(),
  sender: z.object({ sender_type: z.string(), id_type: z.string(), id: id }),
  body: z.object({ content: z.string() }),
});
const postNode = z.discriminatedUnion('tag', [
  z.object({ tag: z.literal('text'), text: z.string() }),
  z.object({ tag: z.literal('a'), text: z.string(), href: z.string() }),
  z.object({ tag: z.literal('at'), user_id: z.string(), user_name: z.string().optional() }),
  z.object({ tag: z.literal('img'), image_key: id }),
  z.object({ tag: z.literal('file'), file_key: id, file_name: z.string() }),
  z.object({ tag: z.literal('emotion'), emoji_type: z.string() }),
  z.object({ tag: z.literal('hr') }),
  z.object({ tag: z.literal('code_block'), text: z.string() }),
  z.object({ tag: z.literal('md'), text: z.string() }),
]);
const postSchema = z.object({ title: z.string().optional(), content: z.array(z.array(postNode)) });
function content(messageType: string, raw: string): Pick<IncomingMessage, 'text' | 'attachments'> {
  const value: unknown = JSON.parse(raw);
  switch (messageType) {
    case 'text': return { text: z.object({ text: z.string() }).parse(value).text, attachments: [] };
    case 'image': return { text: '', attachments: [{ key: z.object({ image_key: id }).parse(value).image_key, name: 'image', kind: 'image' }] };
    case 'file': {
      const file = z.object({ file_key: id, file_name: z.string() }).parse(value);
      return { text: '', attachments: [{ key: file.file_key, name: file.file_name, kind: 'file' }] };
    }
    case 'post': {
      const parsed = postSchema.safeParse(value);
      const localized = parsed.success ? null : z.record(z.string(), postSchema).parse(value);
      const post = parsed.success ? parsed.data : localized?.zh_cn ?? localized?.en_us ?? Object.values(localized ?? {})[0];
      if (!post) throw new Error('Feishu rich post has no readable content');
      const attachments: Attachment[] = [];
      const lines = post.content.map(row => row.map(node => {
        switch (node.tag) {
          case 'text': case 'code_block': case 'md': return node.text;
          case 'a': return `${node.text} (${node.href})`;
          case 'at': return `@${node.user_name ?? node.user_id}`;
          case 'img': attachments.push({ key: node.image_key, name: 'image', kind: 'image' }); return '';
          case 'file': attachments.push({ key: node.file_key, name: node.file_name, kind: 'file' }); return '';
          case 'emotion': return `[${node.emoji_type}]`;
          case 'hr': return '\n';
        }
      }).join(''));
      const title = post.title?.trim() ? [post.title] : [];
      return { text: [...title, ...lines].join('\n'), attachments };
    }
    default: throw new Error(`Unsupported Feishu user message type: ${messageType}`);
  }
}
export function parseFeishuEvent(raw: unknown, userOpenId: string): IncomingMessage | null {
  const event = eventSchema.parse(raw);
  if (event.sender.sender_type !== 'user' || event.sender.sender_id?.open_id !== userOpenId) return null;
  return { id: event.message.message_id, chatId: event.message.chat_id, senderId: userOpenId,
    createdAt: event.message.create_time, chatType: event.message.chat_type, ...content(event.message.message_type, event.message.content) };
}
export function parseFeishuHistory(raw: unknown, userOpenId: string): IncomingMessage | null {
  const envelope = z.object({ deleted: z.boolean().optional(), sender: z.object({
    sender_type: z.string(), id_type: z.string().optional(), id: z.string().optional(),
  }).optional() }).parse(raw);
  if (envelope.deleted || envelope.sender?.sender_type !== 'user' || envelope.sender.id_type !== 'open_id' || envelope.sender.id !== userOpenId) return null;
  const message = historySchema.parse(raw);
  return { id: message.message_id, chatId: message.chat_id, senderId: userOpenId,
    createdAt: message.create_time, chatType: 'group', ...content(message.msg_type, message.body.content) };
}
const approvalSchema = z.object({
  id, taskId: id, threadId: id, turnId: id, requestId: id,
  decision: z.enum(['approve', 'reject']), chatId: id, senderId: id, epoch: id,
});
const actionEventSchema = z.object({
  operator: z.object({ open_id: id }),
  context: z.object({ open_chat_id: id }).optional(),
  open_chat_id: id.optional(),
  action: z.object({ value: z.object({ agent_loop_approval: id }), tag: z.literal('button') }),
});
function approvalKey(options: FeishuOptions): Buffer {
  return createHash('sha256').update(`agent-loop:approval:v1:${options.appId}:`).update(options.appSecret).digest();
}
function approvalToken(action: ApprovalAction, options: FeishuOptions): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', approvalKey(options), nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(action), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function parseApproval(raw: unknown, options: FeishuOptions): ApprovalAction | null {
  const envelope = z.object({ operator: z.object({ open_id: z.string().optional() }).optional() }).parse(raw);
  if (envelope.operator?.open_id !== options.userOpenId) return null;
  const event = actionEventSchema.parse(raw);
  const token = event.action.value.agent_loop_approval;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid Feishu approval action');
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length < 29) throw new Error('Invalid Feishu approval action');
  const decipher = createDecipheriv('aes-256-gcm', approvalKey(options), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  const action = approvalSchema.parse(JSON.parse(plaintext.toString('utf8')));
  const chatId = event.context?.open_chat_id ?? event.open_chat_id;
  if (!chatId || (event.context && event.open_chat_id && event.context.open_chat_id !== event.open_chat_id)
    || action.chatId !== chatId || action.senderId !== event.operator.open_id) {
    throw new Error('Feishu approval actor or chat does not match its request');
  }
  return action;
}
function stableUuid(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
}
function check<T>(response: { code?: number; msg?: string; data?: T }): T {
  if (response?.code === 232009 || response?.code === 232006) throw new TaskGroupUnavailable(response.code, response.msg ?? 'Task group unavailable');
  if (!response || response.code !== 0) throw new FeishuApiError(response?.code ?? -1, response?.msg ?? 'unknown error');
  if (response.data == null) throw new Error('Feishu API response is missing data');
  return response.data;
}
function checkWrite<T>(response: { code?: number; msg?: string; data?: T }): T {
  if (!response || typeof response.code !== 'number' || (response.code === 0 && response.data == null)) {
    throw new UncertainOperationError('Feishu write returned an incomplete response');
  }
  return check(response);
}
function nextPage(data: { has_more?: boolean; page_token?: string }, seen: Set<string>): string | undefined {
  if (typeof data.has_more !== 'boolean') throw new Error('Feishu pagination is missing has_more');
  if (!data.has_more) return undefined;
  if (!data.page_token || seen.has(data.page_token)) throw new Error('Feishu pagination is incomplete or repeated');
  seen.add(data.page_token);
  return data.page_token;
}
function timeoutTransport(timeout: number): HttpInstance {
  const request = <T = unknown, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> =>
    defaultHttpInstance.request({ ...options, timeout }) as Promise<R>;
  return {
    request,
    get: (url, options) => request({ ...options, url, method: 'get' }),
    post: (url, data, options) => request({ ...options, url, data, method: 'post' }),
    put: (url, data, options) => request({ ...options, url, data, method: 'put' }),
    patch: (url, data, options) => request({ ...options, url, data, method: 'patch' }),
    delete: (url, options) => request({ ...options, url, method: 'delete' }),
    head: (url, options) => request({ ...options, url, method: 'head' }),
    options: (url, options) => request({ ...options, url, method: 'options' }),
  };
}
export class FeishuAdapter implements FeishuPort, FeishuProgressPort {
  readonly progress: FeishuProgressPort = this;
  readonly documentProgress: FeishuDocumentAdapter;
  private apiInstance: FeishuApi | undefined;
  private cardkitInstance: FeishuDependencies['cardkit'];
  private socket: Pick<WSClient, 'start' | 'close'> | undefined;
  private readonly http: HttpInstance;
  private nextProgressRequestAt = 0;
  constructor(private readonly options: FeishuOptions, dependencies: FeishuDependencies = {}) {
    this.http = timeoutTransport(options.requestTimeoutMs ?? 30_000);
    this.apiInstance = dependencies.api;
    this.cardkitInstance = dependencies.cardkit;
    this.socket = dependencies.socket;
    let documentApi = dependencies.document;
    this.documentProgress = new FeishuDocumentAdapter(() => {
      if (!documentApi) {
        const client = new Client({ appId: this.options.appId, appSecret: this.options.appSecret,
          domain: Domain.Feishu, httpInstance: this.http, loggerLevel: LoggerLevel.error });
        documentApi = { document: client.docx.v1.document, children: client.docx.v1.documentBlockChildren,
          block: client.docx.v1.documentBlock, members: client.drive.v1.permissionMember, tabs: client.im.v1.chatTab };
      }
      return documentApi;
    });
  }
  private get api(): FeishuApi {
    this.apiInstance ??= new Client({ appId: this.options.appId, appSecret: this.options.appSecret,
      domain: Domain.Feishu, httpInstance: this.http, loggerLevel: LoggerLevel.error }).im.v1;
    return this.apiInstance;
  }
  private get cardkit(): NonNullable<FeishuDependencies['cardkit']> {
    this.cardkitInstance ??= new Client({ appId: this.options.appId, appSecret: this.options.appSecret,
      domain: Domain.Feishu, httpInstance: this.http, loggerLevel: LoggerLevel.error }).cardkit.v1;
    return this.cardkitInstance;
  }
  private async paceProgressRequest(): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, this.nextProgressRequestAt);
    this.nextProgressRequestAt = start + 100;
    if (start > now) await delay(start - now);
  }
  async createProgressCard(input: Parameters<FeishuProgressPort['createProgressCard']>[0], guard?: ProgressWriteGuard): Promise<string> {
    const card = { schema: '2.0', config: { update_multi: true, streaming_mode: true, summary: { content: progressCardTitle } },
      header: { title: { tag: 'plain_text', content: progressCardTitle } },
      body: { elements: [
        { tag: 'div', text: { tag: 'plain_text', element_id: 'progress', content: input.content } },
        ...(input.dashboardUrl ? [{ tag: 'button', text: { tag: 'plain_text', content: '查看完整日志' }, type: 'default',
          multi_url: { url: input.dashboardUrl, pc_url: '', android_url: '', ios_url: '' } }] : []),
      ] } };
    const data = JSON.stringify(card);
    if (Buffer.byteLength(data) >= 30_000) throw new Error('Progress card exceeds the 30KB payload budget');
    await this.paceProgressRequest();
    guard?.();
    const response = checkWrite(await this.cardkit.card.create({ data: { type: 'card_json', data } }));
    return id.parse(response.card_id);
  }
  async sendProgressCard(input: Parameters<FeishuProgressPort['sendProgressCard']>[0], guard?: ProgressWriteGuard): Promise<string> {
    await this.paceProgressRequest();
    guard?.();
    const response = checkWrite(await this.api.message.create({ params: { receive_id_type: 'chat_id' }, data: {
      receive_id: input.chatId, msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: input.cardId } }), uuid: input.uuid,
    } }));
    return id.parse(response.message_id);
  }
  async findProgressMessage(input: Parameters<FeishuProgressPort['findProgressMessage']>[0]): Promise<string | null> {
    const pages = new Set<string>();
    const messages = new Set<string>();
    let token: string | undefined;
    let requests = 0;
    do {
      if (++requests > progressLookupRequestLimit) throw new Error('Feishu progress message scan exceeded its request limit');
      await this.paceProgressRequest();
      const page = check(await this.api.message.list({ params: { container_id_type: 'chat', container_id: input.chatId,
        start_time: String(Math.max(0, Math.floor(input.since / 1000) - 1)), sort_type: 'ByCreateTimeAsc',
        card_msg_content_type: 'user_card_content', page_size: 50, page_token: token } }));
      const items = progressMessagesSchema.parse(page.items);
      token = nextPage(page, pages);
      for (const item of items) {
        if (item.deleted) continue;
        if (item.chat_id !== input.chatId) throw new Error('Feishu progress history returned a message from a different group');
        if (item.msg_type !== 'interactive' || messages.has(item.message_id)) continue;
        messages.add(item.message_id);
        const card: unknown = JSON.parse(z.string().parse(item.body?.content));
        if (!progressCardSchema.safeParse(card).success) continue;
        if (++requests > progressLookupRequestLimit) throw new Error('Feishu progress message scan exceeded its request limit');
        await this.paceProgressRequest();
        const converted = check(await this.cardkit.card.idConvert({ data: { message_id: item.message_id } }));
        if (id.parse(converted.card_id) === input.cardId) return item.message_id;
      }
    } while (token);
    return null;
  }
  async updateProgressContent(input: Parameters<FeishuProgressPort['updateProgressContent']>[0], guard?: ProgressWriteGuard): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(input.content)) >= 24_000) throw new Error('Progress content exceeds its payload budget');
    await this.paceProgressRequest();
    guard?.();
    checkWrite(await this.cardkit.cardElement.content({ path: { card_id: input.cardId, element_id: 'progress' },
      data: { content: input.content, sequence: input.sequence, uuid: input.uuid } }));
  }
  async setProgressStreaming(input: Parameters<FeishuProgressPort['setProgressStreaming']>[0], guard?: ProgressWriteGuard): Promise<void> {
    await this.paceProgressRequest();
    guard?.();
    checkWrite(await this.cardkit.card.settings({ path: { card_id: input.cardId },
      data: { settings: JSON.stringify({ config: { streaming_mode: input.enabled } }), sequence: input.sequence, uuid: input.uuid } }));
  }
  async ensureGroup(input: { taskId: string; title: string; sourceUrl?: string; generation?: number; reconcileOnly?: boolean }): Promise<string> {
    const generation = input.generation ?? 0;
    const marker = `agent-loop:v1:${input.taskId}${generation ? `:generation:${generation}` : ''}`;
    const description = `${marker}\n${input.sourceUrl ?? ''}`;
    const matches = new Set<string>();
    const seen = new Set<string>();
    let token: string | undefined;
    try {
      do {
        const page = check(await this.api.chat.list({ params: { page_size: 100, page_token: token, user_id_type: 'open_id' } }));
        if (!page.items) throw new Error('Feishu chat list is missing items');
        for (const chat of page.items) {
          if (chat.description?.split('\n')[0] === marker) matches.add(id.parse(chat.chat_id));
        }
        token = nextPage(page, seen);
      } while (token);
    } catch (error) {
      if (!input.reconcileOnly) throw new GroupCreationRejected(error instanceof FeishuApiError ? error.code : -1, errorMessage(error));
      throw error;
    }
    if (matches.size > 1) throw new Error('Multiple Feishu groups claim the same task');
    const existing = [...matches][0];
    if (existing) { await this.verifyGroup(existing); return existing; }
    if (input.reconcileOnly) throw new UncertainOperationError('Previous group creation could not be reconciled; no replacement group created');
    let response: Awaited<ReturnType<FeishuApi['chat']['create']>>;
    try {
      response = await this.api.chat.create({ params: { user_id_type: 'open_id', uuid: stableUuid(`group:${input.taskId}${generation ? `:${generation}` : ''}`) },
        data: { name: input.title.slice(0, 80), description, owner_id: this.options.userOpenId,
          user_id_list: [this.options.userOpenId], chat_mode: 'group', chat_type: 'private', external: false } });
    } catch (error) {
      throw new UncertainOperationError(`Feishu group creation outcome is unknown: ${errorMessage(error)}`);
    }
    let data: NonNullable<typeof response.data>;
    try { data = checkWrite(response); }
    catch (error) {
      if (error instanceof FeishuApiError) throw new GroupCreationRejected(error.code, error.message);
      throw error;
    }
    const chatId = id.safeParse(data.chat_id);
    if (!chatId.success) throw new UncertainOperationError('Feishu group creation returned no valid chat_id');
    return chatId.data;
  }
  async verifyGroup(chatId: string): Promise<void> {
    const chat = z.object({ chat_status: id, owner_id: id, chat_mode: id, chat_type: id })
      .parse(check(await this.api.chat.get({ path: { chat_id: chatId }, params: { user_id_type: 'open_id' } })));
    if (chat.chat_status !== 'normal' || chat.owner_id !== this.options.userOpenId || chat.chat_mode !== 'group' || chat.chat_type !== 'private') {
      throw new TaskGroupUnavailable(0, 'Feishu task group is unavailable or its owner/privacy changed');
    }
  }
  async dissolveGroup(chatId: string): Promise<void> {
    if (!this.api.chat.delete) throw new Error('Feishu chat delete is unavailable');
    const response = await this.api.chat.delete({ path: { chat_id: chatId } });
    if (typeof response?.code !== 'number') throw new UncertainOperationError('Feishu group deletion returned an incomplete response');
    if (response?.code === 232009) return;
    if (response?.code !== 0) check(response);
  }
  async send(input: { chatId: string; text: string; id: string }): Promise<void> {
    let response: Awaited<ReturnType<FeishuApi['message']['create']>>;
    try {
      response = await this.api.message.create({ params: { receive_id_type: 'chat_id' },
        data: { receive_id: input.chatId, msg_type: 'text', content: JSON.stringify({ text: input.text }), uuid: stableUuid(`message:${input.id}`) } });
    } catch (error) {
      throw new UncertainOperationError(`Feishu message delivery outcome is unknown: ${errorMessage(error)}`);
    }
    const data = checkWrite(response);
    if (!id.safeParse(data.message_id).success) throw new UncertainOperationError('Feishu message delivery returned no valid message_id');
  }
  async sendApproval(input: { chatId: string; id: string; taskId: string; request: PendingRequest }): Promise<void> {
    if (input.request.kind !== 'approval' && input.request.kind !== 'permissions') throw new Error('Only native approvals can create approval cards');
    const button = (decision: ApprovalAction['decision'], text: string) => ({
      tag: 'button', text: { tag: 'plain_text', content: text }, type: decision === 'approve' ? 'primary' : 'default',
      value: { agent_loop_approval: approvalToken({
        id: `${input.id}:${decision}`, taskId: input.taskId, chatId: input.chatId, senderId: this.options.userOpenId,
        threadId: input.request.threadId, turnId: input.request.turnId, requestId: input.request.id,
        epoch: input.request.connectionEpoch, decision,
      }, this.options) },
    });
    const card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '工具操作请求' } },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: input.request.prompt } },
        { tag: 'div', text: { tag: 'plain_text', content: `原生请求 ${input.request.method}` } },
        { tag: 'action', actions: [button('approve', '批准此请求'), button('reject', '拒绝此请求')] },
      ] };
    let response: Awaited<ReturnType<FeishuApi['message']['create']>>;
    try {
      response = await this.api.message.create({ params: { receive_id_type: 'chat_id' }, data: {
        receive_id: input.chatId, msg_type: 'interactive', content: JSON.stringify(card), uuid: stableUuid(`message:${input.id}`),
      } });
    } catch (error) {
      throw new UncertainOperationError(`Feishu approval card delivery outcome is unknown: ${errorMessage(error)}`);
    }
    const data = checkWrite(response);
    if (!id.safeParse(data.message_id).success) throw new UncertainOperationError('Feishu approval card delivery returned no valid message_id');
  }
  async download(input: { messageId: string; attachment: Attachment; destination: string; maxBytes: number }): Promise<void> {
    const resource = await this.api.messageResource.get({ path: { message_id: input.messageId, file_key: input.attachment.key }, params: { type: input.attachment.kind } });
    const stream = resource.getReadableStream();
    const temporary = `${input.destination}.${randomUUID()}.part`;
    let size = 0;
    const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > input.maxBytes ? new Error(`Attachment exceeds ${input.maxBytes} bytes`) : null, chunk);
    } });
    try {
      await pipeline(stream, limit, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000) });
      await rename(temporary, input.destination);
    } catch (error) {
      stream.destroy();
      await rm(temporary, { force: true });
      throw error;
    }
  }
  async history(input: { chatId: string; since: number }): Promise<IncomingMessage[]> {
    const messages = new Map<string, IncomingMessage>();
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const page = check(await this.api.message.list({ params: { container_id_type: 'chat', container_id: input.chatId,
        start_time: String(Math.max(0, Math.floor(input.since / 1000) - 1)), sort_type: 'ByCreateTimeAsc', page_size: 50, page_token: token } }));
      if (!page.items) throw new Error('Feishu message history is missing items');
      for (const item of page.items) {
        const message = parseFeishuHistory(item, this.options.userOpenId);
        if (message) {
          if (message.chatId !== input.chatId) throw new Error('Feishu history returned a message from a different group');
          messages.set(message.id, message);
        }
      }
      token = nextPage(page, seen);
    } while (token);
    return [...messages.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async start(onMessage: (message: IncomingMessage) => Promise<void>, onError: (error: unknown) => void, onAction?: (action: ApprovalAction) => Promise<void>, onReconnect?: (event: FeishuReconnectEvent) => void): Promise<void> {
    const eventDispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.error }).register({
      'card.action.trigger': async (raw: unknown) => {
        const receivedAt = Date.now();
        let action: ApprovalAction | null = null;
        try {
          action = parseApproval(raw, this.options);
          if (!action) return { toast: { type: 'warning', content: '此操作仅限任务所有者' } };
          if (!onAction) throw new Error('Feishu approval actions have no registered handler');
          await onAction(action);
          const receipt = `${action.decision === 'approve' ? '批准' : '拒绝'}决定已接收，等待执行器确认`;
          return {
            toast: { type: 'info', content: receipt },
            card: { type: 'raw', data: {
              config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '工具审批决定已接收' } },
              elements: [
                { tag: 'div', text: { tag: 'plain_text', content: receipt } },
                { tag: 'div', text: { tag: 'plain_text', content: '请查看执行进度，了解后续处理结果。' } },
              ],
            } },
          };
        } catch {
          const event = z.object({ event_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() }).safeParse(raw);
          try {
            onError(new Error(`Feishu approval callback failed: ${JSON.stringify({
              receivedAt, durationMs: Date.now() - receivedAt, eventId: event.success ? event.data.event_id : undefined,
              taskId: action?.taskId, threadId: action?.threadId, turnId: action?.turnId,
              requestId: action?.requestId, decision: action?.decision,
            })}`));
          } catch {}
          return { toast: { type: 'error', content: '此次点击未被接收，请查看最新审批状态。' } };
        }
      },
      'im.message.receive_v1': async raw => {
        try {
          const message = parseFeishuEvent(raw, this.options.userOpenId);
          if (message) await onMessage(message);
        } catch (error) { onError(error); throw error; }
      },
    });
    if (this.socket) { await this.socket.start({ eventDispatcher }); return; }
    await new Promise<void>((resolve, reject) => {
      let reconnectAttempt = 0;
      let reconnectStartedAt: number | undefined;
      const timer = setTimeout(() => {
        this.socket?.close({ force: true });
        reject(new Error('Feishu long connection did not become ready before its timeout'));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.socket = new WSClient({ appId: this.options.appId, appSecret: this.options.appSecret,
        domain: Domain.Feishu, httpInstance: this.http, loggerLevel: LoggerLevel.error,
        handshakeTimeoutMs: this.options.requestTimeoutMs ?? 30_000,
        onReady: () => { clearTimeout(timer); resolve(); },
        onError: error => { clearTimeout(timer); onError(error); reject(error); },
        onReconnecting: () => {
          reconnectAttempt++;
          reconnectStartedAt ??= Date.now();
          const event: FeishuReconnectEvent = { state: 'reconnecting', attempt: reconnectAttempt };
          onReconnect?.(event);
          onError(new Error(`Feishu long connection reconnecting: ${JSON.stringify(event)}`));
        },
        onReconnected: () => {
          const event: FeishuReconnectEvent = { state: 'reconnected', attempt: reconnectAttempt, ...(reconnectStartedAt === undefined ? {} : { durationMs: Math.max(0, Date.now() - reconnectStartedAt) }) };
          onReconnect?.(event);
          reconnectAttempt = 0;
          reconnectStartedAt = undefined;
        },
      });
      void this.socket.start({ eventDispatcher }).catch(error => { clearTimeout(timer); reject(error); });
    });
  }
  async close(): Promise<void> { this.socket?.close({ force: true }); }
}
