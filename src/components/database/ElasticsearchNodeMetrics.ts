import { Client } from '@elastic/elasticsearch'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import type { NodeMetricsHourly, NodeMetricsSnapshot } from '../../@types/nodeMetrics.js'
import { NodeMetricsProvider } from './NodeMetricsDatabase.js'
import {
  createElasticsearchClientWithRetry,
  ensureIndex,
  searchAllPages,
  SEARCH_PAGE_SIZE
} from './ElasticsearchConfigHelper.js'
import { stateSchemas } from './ElasticSchemas.js'
import {
  HOUR_MS,
  HourlyRow,
  SampleRow,
  aggregateRows,
  floorToHour,
  hourlyRowToApi,
  hourlyToRow,
  snapshotToSampleRow
} from './nodeMetricsAggregate.js'

const SAMPLES_INDEX = stateSchemas.metricsSamples.index
const HOURLY_INDEX = stateSchemas.metricsHourly.index

type SampleDoc = SampleRow & { instanceId: string }
type HourlyDoc = HourlyRow & { instanceId: string }

// samples: auto id; hourly rows: id = `${instanceId}:${hourStart}`
export class ElasticsearchNodeMetrics implements NodeMetricsProvider {
  private constructor(private config: OceanNodeDBConfig) {}

  // resolved per call: the health monitor replaces the client after a reconnect
  private client(): Promise<Client> {
    return createElasticsearchClientWithRetry(this.config)
  }

  static async create(config: OceanNodeDBConfig): Promise<ElasticsearchNodeMetrics> {
    await ensureIndex(config, stateSchemas.metricsSamples)
    await ensureIndex(config, stateSchemas.metricsHourly)
    return new ElasticsearchNodeMetrics(config)
  }

  async insertSample(instanceId: string, snapshot: NodeMetricsSnapshot): Promise<void> {
    const document: SampleDoc = { instanceId, ...snapshotToSampleRow(snapshot) }
    const client = await this.client()
    await client.index({ index: SAMPLES_INDEX, document, refresh: 'wait_for' })
  }

  async getPendingSampleHours(instanceId: string, beforeHour: number): Promise<number[]> {
    const client = await this.client()
    // every pending sample: an hour that is not listed here is purged without a roll-up
    const hits = await searchAllPages<Pick<SampleDoc, 'collectedAt'>>(client, {
      index: SAMPLES_INDEX,
      query: olderThanQuery(instanceId, 'collectedAt', beforeHour),
      _source: ['collectedAt']
    })
    const hours = new Set(hits.map((hit) => floorToHour(hit._source.collectedAt)))
    return [...hours].sort((a, b) => a - b)
  }

  // Average every raw sample in [hourStart, hourStart+1h) into one hourly row, upsert it, then
  // delete the consumed raw samples. No samples → no row written.
  async rollupHour(instanceId: string, hourStart: number): Promise<boolean> {
    const samples = await this.getHourSamples(instanceId, hourStart)
    if (samples.length === 0) return false
    const document: HourlyDoc = {
      instanceId,
      ...hourlyToRow(aggregateRows(samples, hourStart))
    }
    const client = await this.client()
    await client.index({
      index: HOURLY_INDEX,
      id: `${instanceId}:${hourStart}`,
      document,
      refresh: 'wait_for'
    })
    await client.deleteByQuery({
      index: SAMPLES_INDEX,
      query: hourRangeQuery(instanceId, hourStart),
      refresh: true,
      conflicts: 'proceed'
    })
    return true
  }

  async getPartialHour(
    instanceId: string,
    hourStart: number
  ): Promise<NodeMetricsHourly | null> {
    const samples = await this.getHourSamples(instanceId, hourStart)
    if (samples.length === 0) return null
    const agg = aggregateRows(samples, hourStart)
    agg.partial = true
    return agg
  }

  async purgeOldSamples(instanceId: string, olderThan: number): Promise<number> {
    const client = await this.client()
    const result = await client.deleteByQuery({
      index: SAMPLES_INDEX,
      query: olderThanQuery(instanceId, 'collectedAt', olderThan),
      refresh: true,
      conflicts: 'proceed'
    })
    return result.deleted ?? 0
  }

  async deleteHourlyOlderThan(instanceId: string, cutoff: number): Promise<number> {
    const client = await this.client()
    const result = await client.deleteByQuery({
      index: HOURLY_INDEX,
      query: olderThanQuery(instanceId, 'hourStart', cutoff),
      refresh: true,
      conflicts: 'proceed'
    })
    return result.deleted ?? 0
  }

  async getHourly(
    instanceId: string,
    from: number,
    to: number,
    limit: number
  ): Promise<NodeMetricsHourly[]> {
    const client = await this.client()
    const result = await client.search<HourlyDoc>({
      index: HOURLY_INDEX,
      query: {
        bool: {
          filter: [
            { term: { instanceId } },
            { range: { hourStart: { gte: from, lte: to } } }
          ]
        }
      },
      sort: [{ hourStart: { order: 'asc' } }],
      size: limit
    })
    return result.hits.hits.map((hit) => hourlyRowToApi(hit._source))
  }

  private async getHourSamples(
    instanceId: string,
    hourStart: number
  ): Promise<SampleRow[]> {
    const client = await this.client()
    const result = await client.search<SampleDoc>({
      index: SAMPLES_INDEX,
      query: hourRangeQuery(instanceId, hourStart),
      // one hour holds 60 samples, one per minute
      size: SEARCH_PAGE_SIZE
    })
    return result.hits.hits.map((hit) => hit._source)
  }
}

function hourRangeQuery(instanceId: string, hourStart: number) {
  return {
    bool: {
      filter: [
        { term: { instanceId } },
        { range: { collectedAt: { gte: hourStart, lt: hourStart + HOUR_MS } } }
      ]
    }
  }
}

function olderThanQuery(instanceId: string, field: string, cutoff: number) {
  return {
    bool: {
      filter: [{ term: { instanceId } }, { range: { [field]: { lt: cutoff } } }]
    }
  }
}
