import type { EmbeddingProvider } from './types.ts';

export class NoopEmbeddingProvider implements EmbeddingProvider {
  dimensions = 0;

  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array(0);
  }

  async embedBatch(_texts: string[]): Promise<Float32Array[]> {
    return [];
  }
}

export function createEmbeddingProvider(providerType: string): EmbeddingProvider {
  switch (providerType) {
    case 'none':
    default:
      return new NoopEmbeddingProvider();
  }
}
