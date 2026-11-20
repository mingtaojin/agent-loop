import { inspect } from 'node:util';

const credentialValues = new Set<string>();
const redacted = '[REDACTED]';

export class ConfigCredential {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
    if (this.configured) {
      for (const variant of [value, JSON.stringify(value).slice(1, -1), new URLSearchParams({ value }).toString().slice(6).replaceAll('+', '%20')]) credentialValues.add(variant);
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

export function redactCredentials(text: string): string {
  for (const value of [...credentialValues].sort((a, b) => b.length - a.length)) text = text.replaceAll(value, redacted);
  return text;
}

export function publicJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? redactCredentials(item) : item, space);
}

const log = (...messages: unknown[]): void => {
  try { process.stderr.write(publicJson(messages.map(value => value instanceof Error ? { name: value.name, message: value.message } : value)) + '\n'); }
  catch { process.stderr.write('Feishu SDK diagnostic could not be serialized\n'); }
};
export const credentialSafeLogger = { error: log, warn: log, info: log, debug: log, trace: log };
