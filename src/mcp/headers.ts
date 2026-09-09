import { ConfigError } from '../errors';

const transportHeaders = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade',
  'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'content-type', 'accept',
]);

/** Copy fixed headers, rejecting case-insensitive credential/transport conflicts. */
export function mergeMCPHeaders(base: Readonly<Record<string, string>>, custom?: Readonly<Record<string, string>>): Record<string, string> {
  const result = { ...base };
  if (custom === undefined) return result;
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) throw new ConfigError('MCP headers must be an object');
  const protectedNames = new Set([...Object.keys(base).map((name) => name.toLowerCase()), ...transportHeaders, 'authorization']);
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(custom)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new ConfigError('Invalid MCP header name');
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new ConfigError('MCP header values must be strings without control characters');
    const folded = name.toLowerCase();
    if (protectedNames.has(folded)) throw new ConfigError(`MCP header is protected: ${folded}`);
    if (seen.has(folded)) throw new ConfigError(`Duplicate MCP header: ${folded}`);
    seen.add(folded);
    Object.defineProperty(result, folded, { value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}
