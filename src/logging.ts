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
