import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, WSClient, EventDispatcher, Domain, LoggerLevel, defaultHttpInstance, type HttpInstance, type HttpRequestOptions } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { credentialSafeLogger } from '../credentials.js';
import { UncertainOperationError, errorMessage, projectDecisionActionSchema, type ApprovalAction, type Attachment, type IncomingMessage, type PendingRequest, type ProjectDecisionAction, type ReplyTarget } from '../domain.js';
import { FeishuApiError, GroupCreationRejected, TaskGroupUnavailable, type FeishuCardDelivery, type FeishuDecisionCardInput, type FeishuPort, type FeishuProgressPort, type FeishuReconnectEvent, type ProgressWriteGuard } from '../ports.js';
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
  cardkitNative?: boolean;
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
const optionalMessageId = z.preprocess(value => value === null || value === '' ? undefined : value, id.optional());
const eventSchema = z.object({
  sender: z.object({ sender_type: z.string(), sender_id: z.object({ open_id: id.optional() }).optional() }),
  message: z.object({ message_id: id, chat_id: id, chat_type: z.enum(['p2p', 'group']).default('group'), create_time: timestamp, message_type: id, content: z.string(),
    parent_id: optionalMessageId, root_id: optionalMessageId, thread_id: optionalMessageId }),
});
const historySchema = z.object({
  message_id: id, chat_id: id, create_time: timestamp, msg_type: id, deleted: z.boolean().optional(),
  sender: z.object({ sender_type: z.string(), id_type: z.string(), id: id }),
  body: z.object({ content: z.string() }), parent_id: optionalMessageId, root_id: optionalMessageId,
  thread_id: optionalMessageId, upper_message_id: optionalMessageId,
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
function replyTarget(parentId: string | undefined, rootId: string | undefined): ReplyTarget | undefined {
  if (!parentId && !rootId) return undefined;
  return { parentId: parentId ?? null, rootId: rootId ?? null };
}
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
  const replyTo = replyTarget(event.message.parent_id, event.message.root_id);
  return { id: event.message.message_id, chatId: event.message.chat_id, senderId: userOpenId,
    createdAt: event.message.create_time, chatType: event.message.chat_type, ...content(event.message.message_type, event.message.content),
    ...(replyTo ? { replyTo } : {}) };
}
export function parseFeishuHistory(raw: unknown, userOpenId: string): IncomingMessage | null {
  const envelope = z.object({ deleted: z.boolean().optional(), sender: z.object({
    sender_type: z.string(), id_type: z.string().optional(), id: z.string().optional(),
  }).optional() }).parse(raw);
  if (envelope.deleted || envelope.sender?.sender_type !== 'user' || envelope.sender.id_type !== 'open_id' || envelope.sender.id !== userOpenId) return null;
  const message = historySchema.parse(raw);
  const replyTo = replyTarget(message.parent_id, message.root_id);
  return { id: message.message_id, chatId: message.chat_id, senderId: userOpenId,
    createdAt: message.create_time, chatType: 'group', ...content(message.msg_type, message.body.content),
    ...(replyTo ? { replyTo } : {}) };
}
const approvalSchema = z.object({
  id, taskId: id, threadId: id, turnId: id, requestId: id,
  decision: z.enum(['approve', 'reject']), chatId: id, senderId: id, epoch: id,
});
const decisionTokenSchema = z.strictObject({ kind: z.literal('project_decision'), id, projectId: id, coordinatorTaskId: id,
  requestId: id, key: id, chatId: id, senderId: id, expiresAt: z.number().int().nonnegative(), epoch: id,
  options: z.array(z.string().trim().min(1).max(8_192)).max(20) });
const actionEventSchema = z.object({
  operator: z.object({ open_id: id }),
  context: z.object({ open_chat_id: id, open_message_id: id.optional() }).optional(),
  open_chat_id: id.optional(),
  action: z.object({ value: z.record(z.string(), z.unknown()).optional(), tag: z.enum(['button', 'input']).optional(),
    form_value: z.record(z.string(), z.unknown()).optional() }),
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
function cardToken(value: unknown, options: FeishuOptions): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', approvalKey(options), nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function decodeCardToken(token: string, options: FeishuOptions): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid Feishu card action');
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length < 29) throw new Error('Invalid Feishu card action');
  const decipher = createDecipheriv('aes-256-gcm', approvalKey(options), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}
function parseApproval(raw: unknown, options: FeishuOptions, includeMessageId = false): ApprovalAction | null {
  const envelope = z.object({ operator: z.object({ open_id: z.string().optional() }).optional() }).parse(raw);
  if (envelope.operator?.open_id !== options.userOpenId) return null;
  const event = actionEventSchema.parse(raw);
  const token = event.action.value?.agent_loop_approval;
  if (typeof token !== 'string') throw new Error('Invalid Feishu approval action');
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
  return includeMessageId && event.context?.open_message_id ? { ...action, messageId: event.context.open_message_id } : action;
}
function parseCardAction(raw: unknown, options: FeishuOptions, includeMessageId = false): ApprovalAction | ProjectDecisionAction | null {
  const envelope = actionEventSchema.parse(raw);
  if (envelope.operator.open_id !== options.userOpenId) return null;
  const values = { ...(envelope.action.value ?? {}), ...(envelope.action.form_value ?? {}) };
  const token = typeof values.agent_loop_approval === 'string' ? values.agent_loop_approval
    : typeof values.agent_loop_card === 'string' ? values.agent_loop_card : undefined;
  if (!token) throw new Error('Invalid Feishu card action');
  if (values.agent_loop_approval) return parseApproval(raw, options, includeMessageId);
  const { options: presetOptions, ...payload } = decisionTokenSchema.parse(decodeCardToken(token, options));
  if (Date.now() >= payload.expiresAt) throw new Error('Feishu decision card expired');
  const chatId = envelope.context?.open_chat_id ?? envelope.open_chat_id;
  if (!chatId || payload.chatId !== chatId || payload.senderId !== envelope.operator.open_id) throw new Error('Feishu decision actor or chat does not match its request');
  const choice = typeof values.agent_loop_choice === 'string' && values.agent_loop_choice.trim() ? values.agent_loop_choice.trim() : undefined;
  const customCandidate = typeof values.agent_loop_custom_text === 'string' ? values.agent_loop_custom_text.trim() : '';
  const customText = customCandidate && customCandidate !== '${agent_loop_custom_text}' ? customCandidate : undefined;
  const action = projectDecisionActionSchema.parse({ ...payload, id: `${payload.id}:${choice ?? customText}`, choice, customText,
    ...(includeMessageId && envelope.context?.open_message_id ? { messageId: envelope.context.open_message_id } : {}), sequence: 0 });
  if (choice && presetOptions.length && !presetOptions.includes(choice)) throw new Error('Invalid project decision option');
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
  private readonly cardkitNative: boolean;
  private nextProgressRequestAt = 0;
  constructor(private readonly options: FeishuOptions, dependencies: FeishuDependencies = {}) {
    this.http = timeoutTransport(options.requestTimeoutMs ?? 30_000);
    this.apiInstance = dependencies.api;
    this.cardkitInstance = dependencies.cardkit;
    this.cardkitNative = dependencies.cardkitNative ?? !dependencies.api;
    this.socket = dependencies.socket;
    let documentApi = dependencies.document;
    this.documentProgress = new FeishuDocumentAdapter(() => {
      if (!documentApi) {
        const client = new Client({ appId: this.options.appId, appSecret: this.options.appSecret,
          domain: Domain.Feishu, httpInstance: this.http, loggerLevel: LoggerLevel.error, logger: credentialSafeLogger });
        documentApi = { document: client.docx.v1.document, children: client.docx.v1.documentBlockChildren,
          block: client.docx.v1.documentBlock, members: client.drive.v1.permissionMember, tabs: client.im.v1.chatTab };
      }
      return documentApi;
    });
  }
  private get api(): FeishuApi {
    this.apiInstance ??= new Client({ appId: this.options.appId, appSecret: this.options.appSecret,
      domain: Domain.Feishu, httpInstance: this.http, loggerLevel: LoggerLevel.error, logger: credentialSafeLogger }).im.v1;
    return this.apiInstance;
  }
  private get cardkit(): NonNullable<FeishuDependencies['cardkit']> {
    this.cardkitInstance ??= new Client({ appId: this.options.appId, appSecret: this.options.appSecret,
      domain: Domain.Feishu, httpInstance: this.http, loggerLevel: LoggerLevel.error, logger: credentialSafeLogger }).cardkit.v1;
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
  async sendApproval(input: { chatId: string; id: string; taskId: string; request: PendingRequest }): Promise<FeishuCardDelivery> {
    if (input.request.kind !== 'approval' && input.request.kind !== 'permissions') throw new Error('Only native approvals can create approval cards');
    const button = (decision: ApprovalAction['decision'], text: string) => ({
      tag: 'button', text: { tag: 'plain_text', content: text }, type: decision === 'approve' ? 'primary' : 'default',
      value: { agent_loop_approval: approvalToken({
        id: `${input.id}:${decision}`, taskId: input.taskId, chatId: input.chatId, senderId: this.options.userOpenId,
        threadId: input.request.threadId, turnId: input.request.turnId, requestId: input.request.id,
        epoch: input.request.connectionEpoch, decision,
      }, this.options) },
    });
    const legacyCard = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '工具操作请求' } },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: input.request.prompt } },
        { tag: 'div', text: { tag: 'plain_text', content: `原生请求 ${input.request.method}` } },
        { tag: 'action', actions: [button('approve', '批准此请求'), button('reject', '拒绝此请求')] },
      ] };
    const uuid = stableUuid(`message:${input.id}`);
    if (this.apiInstance && !this.cardkitNative) {
      let response: Awaited<ReturnType<FeishuApi['message']['create']>>;
      try { response = await this.api.message.create({ params: { receive_id_type: 'chat_id' }, data: {
        receive_id: input.chatId, msg_type: 'interactive', content: JSON.stringify(legacyCard), uuid,
      } }); } catch (error) { throw new UncertainOperationError(`Feishu approval card delivery outcome is unknown: ${errorMessage(error)}`); }
      const data = checkWrite(response); const messageId = id.parse(data.message_id);
      return { kind: 'native_approval', requestId: input.request.id, cardId: messageId, messageId, sequence: 0, uuid };
    }
    const card = { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: '工具操作请求' } },
      body: { elements: [
        { tag: 'div', text: { tag: 'plain_text', content: input.request.prompt.slice(0, 8_000) } },
        { tag: 'div', text: { tag: 'plain_text', content: `原生请求 ${input.request.method.slice(0, 512)}` } },
        { tag: 'action', actions: [button('approve', '批准此请求'), button('reject', '拒绝此请求')] },
        { tag: 'div', text: { tag: 'plain_text', element_id: 'card_status', content: '等待处理' } },
      ] } };
    let cardResponse: Awaited<ReturnType<NonNullable<FeishuDependencies['cardkit']>['card']['create']>>;
    try { cardResponse = await this.cardkit.card.create({ data: { type: 'card_json', data: JSON.stringify(card) } }); }
    catch (error) { throw new UncertainOperationError(`Feishu approval card creation outcome is unknown: ${errorMessage(error)}`); }
    const cardId = id.parse(checkWrite(cardResponse).card_id);
    let response: Awaited<ReturnType<FeishuApi['message']['create']>>;
    try {
      response = await this.api.message.create({ params: { receive_id_type: 'chat_id' }, data: {
        receive_id: input.chatId, msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }), uuid,
      } });
    } catch (error) {
      throw new UncertainOperationError(`Feishu approval card delivery outcome is unknown: ${errorMessage(error)}`);
    }
    const data = checkWrite(response);
    const messageId = id.safeParse(data.message_id);
    if (!messageId.success) throw new UncertainOperationError('Feishu approval card delivery returned no valid message_id');
    return { kind: 'native_approval', requestId: input.request.id, cardId, messageId: messageId.data, sequence: 0, uuid };
  }
  async sendDecisionCard(input: FeishuDecisionCardInput): Promise<FeishuCardDelivery> {
    if (input.options.length < 1) throw new Error('Project decision cards require at least one preset option');
    const token = cardToken({ kind: 'project_decision', id: input.id, projectId: input.projectId, coordinatorTaskId: input.coordinatorTaskId,
      requestId: input.requestId, key: input.key, chatId: input.chatId, senderId: input.ownerId, expiresAt: input.expiresAt,
      epoch: String(input.expiresAt), options: input.options }, this.options);
    const optionButtons = input.options.map(choice => ({ tag: 'button', text: { tag: 'plain_text', content: choice.slice(0, 256) }, type: 'default',
      value: { agent_loop_card: token, agent_loop_choice: choice } }));
    const card = { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: '项目协调决策' } },
      body: { elements: [
        { tag: 'div', text: { tag: 'plain_text', content: input.prompt.slice(0, 8_000) } },
        ...(input.context ? [{ tag: 'div', text: { tag: 'plain_text', content: input.context.slice(0, 4_000) } }] : []),
        { tag: 'action', actions: optionButtons },
        { tag: 'form', name: 'agent_loop_decision_form', elements: [
          { tag: 'input', name: 'agent_loop_custom_text', placeholder: { tag: 'plain_text', content: '也可以输入自定义决定' },
            label: { tag: 'plain_text', content: '自定义决定' }, required: false },
          { tag: 'button', name: 'agent_loop_submit_custom', text: { tag: 'plain_text', content: '提交自定义决定' },
            type: 'primary', value: { agent_loop_card: token, agent_loop_custom_text: '${agent_loop_custom_text}' } },
        ] },
        { tag: 'div', text: { tag: 'plain_text', element_id: 'card_status', content: '等待处理' } },
      ] } };
    const uuid = stableUuid(`message:${input.id}`);
    let cardId: string;
    if (this.apiInstance && !this.cardkitInstance) {
      let response: Awaited<ReturnType<FeishuApi['message']['create']>>;
      try { response = await this.api.message.create({ params: { receive_id_type: 'chat_id' }, data: {
        receive_id: input.chatId, msg_type: 'interactive', content: JSON.stringify(card), uuid,
      } }); } catch (error) { throw new UncertainOperationError(`Feishu decision card delivery outcome is unknown: ${errorMessage(error)}`); }
      const data = checkWrite(response); const messageId = id.parse(data.message_id);
      return { kind: 'project_decision', requestId: input.requestId, cardId: messageId, messageId, sequence: 0, uuid };
    }
    let created: Awaited<ReturnType<NonNullable<FeishuDependencies['cardkit']>['card']['create']>>;
    try { created = await this.cardkit.card.create({ data: { type: 'card_json', data: JSON.stringify(card) } }); }
    catch (error) { throw new UncertainOperationError(`Feishu decision card creation outcome is unknown: ${errorMessage(error)}`); }
    cardId = id.parse(checkWrite(created).card_id);
    let response: Awaited<ReturnType<FeishuApi['message']['create']>>;
    try { response = await this.api.message.create({ params: { receive_id_type: 'chat_id' }, data: {
      receive_id: input.chatId, msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }), uuid,
    } }); } catch (error) { throw new UncertainOperationError(`Feishu decision card delivery outcome is unknown: ${errorMessage(error)}`); }
    const messageId = id.safeParse(checkWrite(response).message_id);
    if (!messageId.success) throw new UncertainOperationError('Feishu decision card delivery returned no valid message_id');
    return { kind: 'project_decision', requestId: input.requestId, cardId, messageId: messageId.data, sequence: 0, uuid };
  }
  async updateCard(input: { cardId: string; sequence: number; uuid: string; content: string; closed?: boolean }): Promise<void> {
    if (this.apiInstance && !this.cardkitInstance) return;
    await this.paceProgressRequest();
    checkWrite(await this.cardkit.cardElement.content({ path: { card_id: input.cardId, element_id: 'card_status' },
      data: { content: input.content.slice(0, 8_000), sequence: input.sequence, uuid: input.uuid } }));
    if (input.closed) {
      await this.paceProgressRequest();
      checkWrite(await this.cardkit.card.settings({ path: { card_id: input.cardId },
        data: { settings: JSON.stringify({ config: { update_multi: false } }), sequence: input.sequence + 1, uuid: input.uuid } }));
    }
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
  async start(onMessage: (message: IncomingMessage) => Promise<void>, onError: (error: unknown) => void, onAction?: (action: ApprovalAction) => Promise<void>, onReconnect?: (event: FeishuReconnectEvent) => void, onDecision?: (action: ProjectDecisionAction) => Promise<void>): Promise<void> {
    const eventDispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.error, logger: credentialSafeLogger }).register({
      'card.action.trigger': async (raw: unknown) => {
        const receivedAt = Date.now();
        let action: ApprovalAction | ProjectDecisionAction | null = null;
        try {
          action = parseCardAction(raw, this.options, this.cardkitNative);
          if (!action) return { toast: { type: 'warning', content: '此操作仅限任务所有者' } };
          if ('kind' in action) {
            if (!onDecision) throw new Error('Feishu decision actions have no registered handler');
            await onDecision(action);
          } else {
            if (!onAction) throw new Error('Feishu approval actions have no registered handler');
            await onAction(action);
          }
          await this.updateCallbackCard(raw, action, '已接收，正在处理', false, 1);
          const receipt = 'kind' in action
            ? '项目决策已接收，等待运行时确认'
            : `${action.decision === 'approve' ? '批准' : '拒绝'}决定已接收，等待执行器确认`;
          await this.updateCallbackCard(raw, action, '已确认，卡片已关闭', true, 2);
          return {
            toast: { type: 'info', content: receipt },
            card: { type: 'raw', data: {
              config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '卡片决定已接收' } },
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
              taskId: action && 'taskId' in action ? action.taskId : undefined,
              threadId: action && 'threadId' in action ? action.threadId : undefined,
              turnId: action && 'turnId' in action ? action.turnId : undefined,
              requestId: action?.requestId, decision: action && 'decision' in action ? action.decision : undefined,
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
        domain: Domain.Feishu, httpInstance: this.http, loggerLevel: LoggerLevel.error, logger: credentialSafeLogger,
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
  private async updateCallbackCard(raw: unknown, action: ApprovalAction | ProjectDecisionAction, content: string, closed: boolean, sequence: number): Promise<void> {
    if (!this.cardkitNative) return;
    const event = actionEventSchema.parse(raw);
    const messageId = event.context?.open_message_id;
    if (!messageId) return;
    await this.paceProgressRequest();
    const converted = check(await this.cardkit.card.idConvert({ data: { message_id: messageId } }));
    const cardId = id.parse(converted.card_id);
    await this.updateCard({ cardId, sequence, uuid: stableUuid(`callback:${messageId}:${action.requestId}:${sequence}`), content, closed });
  }
  async close(): Promise<void> { this.socket?.close({ force: true }); }
}
