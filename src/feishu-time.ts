export function formatFeishuTime(timestamp: number): string {
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}
