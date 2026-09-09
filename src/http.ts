import { ConfigError } from './errors';

/** Read a bounded body without retaining a credential-bearing URL in errors. */
export async function readBytes(response: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > maxBytes) throw new ConfigError(`${label} exceeds the ${maxBytes} byte size limit`);
      chunks.push(result.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
