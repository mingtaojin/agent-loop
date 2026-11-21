import { FeishuApiError, TaskGroupBindingChanged } from './ports.js';

export function progressFailure(error: unknown): string {
  if (error instanceof FeishuApiError) return `Feishu API error ${error.code}`;
  if (error instanceof TaskGroupBindingChanged) return 'Task group or Thread binding changed';
  const message = error instanceof Error ? error.message : String(error);
  const code = /^(?:Feishu API error )?(\d{6,9})\b/.exec(message)?.[1];
  if (code) return `Feishu API error ${code}`;
  if (/permission|forbidden|denied|scope/i.test(message)) return 'Feishu progress permission denied';
  if (/timeout|timed out/i.test(message)) return 'Feishu progress request timed out';
  if (/unknown|ACK|acknowledge/i.test(message)) return 'Feishu progress delivery outcome is unknown; reconciliation pending';
  if (/network|disconnect|ECONN|fetch|socket/i.test(message)) return 'Feishu progress transport disconnected';
  if (/expired|expiry|retry window/i.test(message)) return 'Feishu progress safe delivery window expired';
  if (/sequence/i.test(message)) return 'Feishu progress operation sequence rejected or exhausted';
  if (/scan|lookup|readback/i.test(message)) return 'Feishu progress reconciliation read failed';
  return 'Feishu progress operation failed';
}

export function progressDiagnostic(error: unknown, operation: string, retry: 'pending' | 'disabled'): string {
  const reason = progressFailure(error);
  const code = /^Feishu API error (\d+)$/.exec(reason)?.[1];
  return JSON.stringify({ operation, retry, reason, ...(code ? { apiCode: Number(code) } : {}) });
}
