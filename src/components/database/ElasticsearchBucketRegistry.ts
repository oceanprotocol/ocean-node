import { Client } from '@elastic/elasticsearch'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { BucketRegistry, BucketRow } from './BucketRegistry.js'
import {
  createElasticsearchClientWithRetry,
  ensureIndex,
  getOrNull
} from './ElasticsearchConfigHelper.js'
import { stateSchemas } from './ElasticSchemas.js'

const INDEX = stateSchemas.buckets.index
// Elasticsearch's default result window; an owner with more buckets sees the oldest 10000
const MAX_BUCKETS_PER_OWNER = 10000

type BucketDoc = Omit<BucketRow, 'bucketId'>

function toRow(bucketId: string, doc: BucketDoc): BucketRow {
  return {
    bucketId,
    owner: doc.owner,
    accessListJson: doc.accessListJson,
    createdAt: doc.createdAt,
    label: doc.label ?? null
  }
}

// one document per bucket: id = bucketId
export class ElasticsearchBucketRegistry implements BucketRegistry {
  private constructor(private config: OceanNodeDBConfig) {}

  // resolved per call: the health monitor replaces the client after a reconnect
  private client(): Promise<Client> {
    return createElasticsearchClientWithRetry(this.config)
  }

  static async create(config: OceanNodeDBConfig): Promise<ElasticsearchBucketRegistry> {
    await ensureIndex(config, stateSchemas.buckets)
    return new ElasticsearchBucketRegistry(config)
  }

  async upsertBucket(
    bucketId: string,
    owner: string,
    accessListJson: string,
    createdAt: number,
    label: string | null
  ): Promise<void> {
    const upsert: BucketDoc = { owner, accessListJson, createdAt, label }
    const client = await this.client()
    await client.update({
      index: INDEX,
      id: bucketId,
      doc: { accessListJson },
      upsert,
      refresh: 'wait_for'
    })
  }

  async getBucket(bucketId: string): Promise<BucketRow | null> {
    const row = await getOrNull<BucketDoc>(await this.client(), INDEX, bucketId)
    return row ? toRow(bucketId, row.source) : null
  }

  async listBucketsByOwner(owner: string): Promise<BucketRow[]> {
    const client = await this.client()
    const result = await client.search<BucketDoc>({
      index: INDEX,
      query: { term: { owner } },
      sort: [{ createdAt: { order: 'asc' } }],
      size: MAX_BUCKETS_PER_OWNER
    })
    return result.hits.hits.map((hit) => toRow(hit._id, hit._source))
  }

  async deleteBucket(bucketId: string): Promise<boolean> {
    try {
      const client = await this.client()
      await client.delete({ index: INDEX, id: bucketId, refresh: 'wait_for' })
      return true
    } catch (error) {
      if (error?.meta?.statusCode === 404) return false
      throw error
    }
  }

  async updateBucketLabel(
    bucketId: string,
    owner: string,
    label: string | null
  ): Promise<boolean> {
    const client = await this.client()
    const row = await getOrNull<BucketDoc>(client, INDEX, bucketId)
    if (!row || row.source.owner !== owner) return false
    await client.update({
      index: INDEX,
      id: bucketId,
      doc: { label },
      refresh: 'wait_for'
    })
    return true
  }
}
