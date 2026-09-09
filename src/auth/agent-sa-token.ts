import { readFile } from 'node:fs/promises';
import { AuthenticationError } from '../errors';

export const DEFAULT_AGENT_SA_TOKEN_PATH = '/var/run/agentcore/agent/token';
export interface AgentSATokenSource {
  get(): string | Promise<string>;
  refresh?(current: string): string | Promise<string>;
}

export class AgentSATokenProvider implements AgentSATokenSource {
  constructor(readonly path = DEFAULT_AGENT_SA_TOKEN_PATH) {}
  async get(): Promise<string> {
    let token: string;
    try { token = await readFile(this.path, 'utf8'); } catch (cause) {
      throw new AuthenticationError('cannot read the Agent SA token file', { cause });
    }
    return validToken(token);
  }
}

function validToken(token: string): string {
  if (typeof token !== 'string' || !token.trim()) throw new AuthenticationError('the Agent SA token source returned an empty token');
  return token.trim();
}
export async function getAgentSAToken(source: AgentSATokenSource): Promise<string> {
  return validToken(await source.get());
}
export async function refreshAgentSAToken(source: AgentSATokenSource, current: string): Promise<string> {
  return validToken(await (source.refresh ? source.refresh(current) : source.get()));
}
