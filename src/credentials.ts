import { inspect } from 'node:util';

const credentialValues = new Set<string>();
const redacted = '[REDACTED]';
const word = (value: string | undefined): boolean => value !== undefined && /[\p{L}\p{N}_]/u.test(value);

function encodedVariants(value: string): string[] {
  const unicode = Buffer.from(value, 'utf8').toString('utf8');
  const component = encodeURIComponent(unicode);
  const strictComponent = component.replace(/[!'()*~]/g, character => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`);
  const form = new URLSearchParams({ value }).toString().slice('value='.length);
  const variants = [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURI(unicode),
    component,
    strictComponent,
    form,
    form.replaceAll('+', '%20'),
  ];
  return variants.flatMap(variant => [variant, variant.replace(/%[0-9A-F]{2}/g, code => code.toLowerCase())]);
}

export class ConfigCredential {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
    if (this.configured) {
      for (const variant of encodedVariants(value)) if (variant) credentialValues.add(variant);
    }
  }
  get rawValue(): string { return this.#value; }
  get configured(): boolean { return this.#value.length > 0 && !this.#value.startsWith('REPLACE_'); }
  require(field: 'github.token' | 'feishu.appId' | 'feishu.appSecret'): string {
    if (!this.configured) throw new Error(`Missing configuration credential: ${field}`);
    return this.#value;
  }
  toJSON(): string { return redacted; }
  toString(): string { return redacted; }
  [inspect.custom](): string { return redacted; }
}

export function redactCredentials(text: string, options: { embedded?: boolean } = {}): string {
  for (const value of [...credentialValues].sort((a, b) => b.length - a.length)) {
    if (text === value) { text = redacted; continue; }
    if (!options.embedded || !text.includes(value)) continue;
    const first = [...value][0], last = [...value].at(-1);
    let cursor = 0;
    let output = '';
    for (;;) {
      const index = text.indexOf(value, cursor);
      if (index < 0) { output += text.slice(cursor); break; }
      const before = [...text.slice(0, index)].at(-1);
      const after = [...text.slice(index + value.length)][0];
      if ((!word(first) || !word(before)) && (!word(last) || !word(after))) {
        output += text.slice(cursor, index) + redacted;
        cursor = index + value.length;
      } else {
        output += text.slice(cursor, index + value.length);
        cursor = index + value.length;
      }
    }
    text = output;
  }
  return text;
}

export function publicJson(value: unknown, space?: number): string {
  return JSON.stringify(value, undefined, space).replace(/"(?:\\.|[^"\\])*"/g, token => {
    const text: unknown = JSON.parse(token);
    return typeof text === 'string' ? JSON.stringify(redactCredentials(text, { embedded: true })) : token;
  });
}

const log = (...messages: unknown[]): void => {
  try { process.stderr.write(publicJson(messages.map(value => value instanceof Error ? { name: value.name, message: value.message } : value)) + '\n'); }
  catch { process.stderr.write('Feishu SDK diagnostic could not be serialized\n'); }
};
export const credentialSafeLogger = { error: log, warn: log, info: log, debug: log, trace: log };
