import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

export const HEARTBEAT_INTERVAL_MS = 15_000;
export function sse(value: Record<string, unknown>): string { return `data: ${JSON.stringify(value)}\n\n`; }

/** One pending pull, at most one buffered frame; heartbeats never pull ahead. */
export async function* withHeartbeat(source: AsyncIterable<string>): AsyncGenerator<string> {
  const iterator = source[Symbol.asyncIterator]();
  let pending = iterator.next();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const heartbeat = Symbol();
      const tick = new Promise<typeof heartbeat>(resolve => { timer = setTimeout(() => resolve(heartbeat), HEARTBEAT_INTERVAL_MS); });
      let item;
      try { item = await Promise.race([pending, tick]); } finally { clearTimeout(timer); }
      if (item === heartbeat) { yield ': ping\n\n'; continue; }
      if (item.done) return;
      yield item.value;
      pending = iterator.next();
    }
  } finally { await iterator.return?.(); }
}

export function eventStream(c: Context, producer: (signal: AbortSignal) => AsyncIterable<string>): Response {
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async stream => {
    const cancelled = new AbortController();
    stream.onAbort(() => cancelled.abort());
    const signal = AbortSignal.any([c.req.raw.signal, cancelled.signal]);
    try {
      for await (const frame of withHeartbeat(producer(signal))) {
        if (signal.aborted) break;
        await stream.write(frame);
      }
    } catch (error) { if (!signal.aborted) throw error; }
  });
}
