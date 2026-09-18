export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

// Libraries are silent unless the application supplies a logger.
export const nullLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
};

/** Render only a service message field, never a response or exception dump. */
export function safeErrorMessage(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\b(?:authorization|api[ _-]?key(?:\s+provided)?|access[_-]?key(?:[_-]?(?:id|secret))?|(?:security|access|refresh|jwt)[_-]?token|token|password|secret|text|content|query|messages|metadata|headers)["']?\s*[:=].*/i, '<redacted>')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '<redacted>')
    .replace(/\b(?:LTAI[A-Za-z0-9]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '<redacted>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .slice(0, 512);
}
