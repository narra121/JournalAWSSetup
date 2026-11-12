/** One Server-Sent Event frame. Multi-line data is split into several `data:` lines per the SSE spec. */
export function sseFrame(event: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${event}\n${payload.split(/\r?\n/).map((l) => `data: ${l}`).join('\n')}\n\n`;
}

/** Comment frame; keeps idle proxies from closing the stream. */
export const ssePing = ': ping\n\n';

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental SSE parser: feed arbitrary chunks (frames may be split anywhere, CRLF or LF), get complete
 * events. Comment lines are ignored; `event` defaults to 'message'.
 */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = this.buf.search(/\r\n|\n|\r/)) >= 0) {
      const line = this.buf.slice(0, nl);
      const sepLen = this.buf.startsWith('\r\n', nl) ? 2 : 1;
      if (sepLen === 1 && this.buf[nl] === '\r' && nl === this.buf.length - 1) break; // maybe CRLF split
      this.buf = this.buf.slice(nl + sepLen);
      if (line === '') {
        if (this.data.length) out.push({ event: this.event || 'message', data: this.data.join('\n') });
        this.event = '';
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') this.event = value;
      else if (field === 'data') this.data.push(value);
    }
    return out;
  }

  /** Flush a final event not terminated by a blank line. */
  end(): SseEvent[] {
    const out = this.push('\n\n');
    this.buf = '';
    return out;
  }
}
