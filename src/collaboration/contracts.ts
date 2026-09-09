import type { Tool } from '../integrations/common';
import type { Logger } from '../logging';
import type { Skill } from '../skill/loader';

/** Stable base-SDK contract; Worker implementation lives in the independently installed addon. */
export interface Worker {
  composePrompt(userPrompt: string): string;
  tools(): Tool[];
  skills(): Promise<Skill[]>;
  requestContext<T>(headers: Readonly<Record<string, string>>, callback: () => T): T;
}
export interface CollaborationRuntime {
  worker(): Promise<Worker>;
  close(): void | Promise<void>;
}
export interface CollaborationOptions {
  teamsPath?: string;
  envPath?: string;
  workspaceDir?: string;
  logger?: Logger;
  /** Borrowed runtime identity; the addon does not own its lifetime. */
  debugSource?: {
    readonly matrixUrl: string;
    loadTeamsConfig(): Promise<Uint8Array | undefined>;
    exchangeMatrixToken(): Promise<string>;
  };
}
