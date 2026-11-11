const maxElementBytes = 24_000;
const maxRunLength = 1000;

export function documentTextElements(text: string): { text_run: { content: string } }[] {
  const elements: { text_run: { content: string } }[] = [];
  let run = '';
  for (const char of text) {
    if (run.length + char.length > maxRunLength) { elements.push({ text_run: { content: run } }); run = ''; }
    run += char;
  }
  elements.push({ text_run: { content: run } });
  if (Buffer.byteLength(JSON.stringify(elements)) > maxElementBytes) throw new Error('Progress text exceeds document payload limit');
  return elements;
}

export function documentChunks(text: string): string[] {
  const chunks: string[] = [];
  const emptyRunBytes = Buffer.byteLength(JSON.stringify([{ text_run: { content: '' } }]));
  let start = 0;
  while (start < text.length) {
    let end = start, lastNewline = start, bytes = emptyRunBytes, runLength = 0;
    for (const char of text.slice(start)) {
      const newRun = runLength + char.length > maxRunLength;
      const extra = Buffer.byteLength(JSON.stringify(char)) - 2 + (newRun ? emptyRunBytes - 1 : 0);
      if (bytes + extra > maxElementBytes) break;
      bytes += extra;
      runLength = (newRun ? 0 : runLength) + char.length;
      end += char.length;
      if (char === '\n') lastNewline = end;
    }
    if (end < text.length && lastNewline > start) end = lastNewline;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks.length ? chunks : [''];
}
