import { Buffer } from 'node:buffer';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Definition, Nodes } from 'mdast';

type Message = { msg_type: 'post'; content: string } | { msg_type: 'text'; content: string };
type Patch = { start: number; end: number; text: string };

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function inlineCode(value: string): string {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  const pad = value.startsWith('`') || value.endsWith('`') || /^ .* $/.test(value);
  return `${fence}${pad ? ' ' : ''}${value}${pad ? ' ' : ''}${fence}`;
}

function localReference(url: string): string | undefined {
  if (url.startsWith('//')) return undefined;
  if (!/^(?:\/|[a-z]:[\\/]|\\\\|file:)/i.test(url)) return undefined;
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch {}
  const location = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/i.exec(decoded);
  const path = location ? decoded.slice(0, location.index) : decoded;
  const filename = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'file';
  const line = location?.[1] ?? location?.[3];
  const column = location?.[2] ?? location?.[4];
  return filename + (line ? `:${line}${column ? `:${column}` : ''}` : '');
}

function patchFor(node: Nodes, text: string): Patch | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? undefined : { start, end, text };
}

function htmlPatch(node: Nodes, source: string): Patch | undefined {
  const patch = patchFor(node, '');
  return patch ? { ...patch, text: escapeHtml(source.slice(patch.start, patch.end)) } : undefined;
}

function applyPatches(source: string, patches: Patch[], origin = 0): string {
  let boundary = source.length + origin;
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    if (patch.start < origin || patch.end > boundary) continue;
    source = source.slice(0, patch.start - origin) + patch.text + source.slice(patch.end - origin);
    boundary = patch.start;
  }
  return source;
}

function identifier(value: string): string {
  return value.replace(/\s+/g, ' ').toUpperCase();
}

export function renderFeishuMessage(raw: string): Message {
  const tree = fromMarkdown(raw, { extensions: [{ disable: { null: ['htmlFlow'] } }] });
  const definitions = new Map<string, Definition>();
  const patches: Patch[] = [];
  function collect(node: Nodes): void {
    if (node.type === 'definition' && !definitions.has(identifier(node.identifier))) {
      definitions.set(identifier(node.identifier), node);
    }
    if ('children' in node) node.children.forEach(collect);
  }
  collect(tree);

  function label(node: Nodes): string {
    if (node.type === 'image' || node.type === 'imageReference') {
      return inlineCode(node.alt || 'image');
    }
    if (!('children' in node)) return '';
    const first = node.children[0]?.position?.start.offset;
    const last = node.children.at(-1)?.position?.end.offset;
    if (first === undefined || last === undefined) return '';
    const html: Patch[] = [];
    function collectHtml(child: Nodes): void {
      if (child.type === 'html') {
        const patch = htmlPatch(child, raw);
        if (patch) html.push(patch);
      } else if ('children' in child) child.children.forEach(collectHtml);
    }
    node.children.forEach(collectHtml);
    return applyPatches(raw.slice(first, last), html, first);
  }

  function visit(node: Nodes): void {
    if (node.type === 'code' || node.type === 'inlineCode') return;
    if (node.type === 'html') {
      const patch = htmlPatch(node, raw);
      if (patch) patches.push(patch);
      return;
    }
    if (node.type === 'definition') {
      if (localReference(node.url) !== undefined) {
        const patch = patchFor(node, '');
        if (patch) patches.push(patch);
      }
      return;
    }
    const url = node.type === 'link' || node.type === 'image' ? node.url
      : node.type === 'linkReference' || node.type === 'imageReference'
        ? definitions.get(identifier(node.identifier))?.url : undefined;
    const reference = url === undefined ? undefined : localReference(url);
    if (reference !== undefined) {
      const description = label(node);
      const child = 'children' in node && node.children.length === 1 ? node.children[0] : undefined;
      const sourceLabel = child && (child.type === 'text' || child.type === 'inlineCode') ? child.value : undefined;
      const redundant = description === url || description === reference
        || description === inlineCode(reference)
        || (sourceLabel !== undefined && localReference(sourceLabel) !== undefined);
      const text = !description || redundant ? inlineCode(reference)
        : `${description} (${inlineCode(reference)})`;
      const patch = patchFor(node, text);
      if (patch) patches.push(patch);
      return;
    }
    if ('children' in node) node.children.forEach(visit);
  }
  visit(tree);
  const normalized = applyPatches(raw, patches);
  const content = JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: normalized }]] } });
  const message: Message = { msg_type: 'post', content };
  return Buffer.byteLength(JSON.stringify(message), 'utf8') > 24000
    ? { msg_type: 'text', content: JSON.stringify({ text: raw }) } : message;
}
