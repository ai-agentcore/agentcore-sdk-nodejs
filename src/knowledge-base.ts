import type { AgentCoreControlPlane } from './controlplane/client';
import { InvocationError } from './errors';
import { requiredString } from './runtime/config';

export interface KnowledgeBaseSearchOptions {
  mode?: 'KEYWORD' | 'VECTOR' | 'HYBRID';
  topK?: number;
  metadataFilter?: string;
  rerank?: boolean;
  rrfK?: number;
  rankAlgorithm?: 'RRF' | 'WEIGHTED';
  vectorWeight?: number;
  rerankModel?: string;
}

export interface KnowledgeBaseChunk {
  content: string;
  assetId?: string;
  assetName?: string;
  fileName?: string;
  chunkSeq?: number;
  chunkToken?: string;
  score?: number;
  scores?: { keyword?: number; vector?: number; fusion?: number; rerank?: number };
  titlePath?: string;
  sourceLocation?: string;
}

export interface KnowledgeBaseSearchResult {
  chunks: KnowledgeBaseChunk[];
  timeSpent?: number;
  scoreType?: string;
}

/** Retrieval from an existing native AgentCore knowledge base. */
export class KnowledgeBase {
  constructor(readonly knowledgeBaseId: string, private readonly provider: () => Promise<AgentCoreControlPlane>) {
    requiredString(knowledgeBaseId, 'knowledgeBaseId must not be blank');
  }

  /** Omitted options inherit the knowledge base configuration. */
  async search(query: string, options: KnowledgeBaseSearchOptions = {}): Promise<KnowledgeBaseSearchResult> {
    requiredString(query, 'query must not be blank');
    const body = Object.fromEntries(Object.entries({ ...options, query }).filter(([, value]) => value !== undefined));
    const provider = await this.provider();
    const data = await provider.searchKnowledgeBase(this.knowledgeBaseId, body);
    if (!Array.isArray(data.chunks) || data.chunks.some(chunk => !chunk || typeof chunk.content !== 'string')) {
      throw new InvocationError('SearchKnowledgeBase returned invalid data.chunks');
    }
    return data as unknown as KnowledgeBaseSearchResult;
  }
}
