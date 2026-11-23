import { Client, estypes } from '@elastic/elasticsearch'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import type { NodeMetricsHourly, NodeMetricsSnapshot } from '../../@types/nodeMetrics.js'
import { MAX_RESULT_WINDOW } from './BaseDatabase.js'
import { NodeMetricsProvider } from './NodeMetricsDatabase.js'
import {
  assertCompleteSearch,
  createElasticsearchClientWithRetry,
  deleteMatching,
  ensureIndex,
  isStatus,
  searchAllPages
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

const hourlyId = (instanceId: string, hourStart: number) => `${instanceId}:${hourStart}`

// samples: auto id; hourly rows: id = hourlyId
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

  // Averages the samples of the hour into one hourly row, then deletes them. The first
  // roll-up of an hour wins: the row is created once, so the samples that a partial delete
  // (Elasticsearch does not roll back) leaves are deleted by the next run, not counted again.
  async rollupHour(instanceId: string, hourStart: number): Promise<boolean> {
    const client = await this.client()
    const hits = await this.getHourSamples(instanceId, hourStart)
    if (hits.length === 0) return false
    const document: HourlyDoc = {
      instanceId,
      ...hourlyToRow(
        aggregateRows(
          hits.map((hit) => hit._source),
          hourStart
        )
      )
    }
    let written = true
    try {
      await client.index({
        index: HOURLY_INDEX,
        id: hourlyId(instanceId, hourStart),
        document,
        op_type: 'create',
        refresh: 'wait_for'
      })
    } catch (error) {
      if (!isStatus(error, 409)) throw error
      written = false
    }
    await deleteMatching(client, SAMPLES_INDEX, {
      ids: { values: hits.map((hit) => hit._id) }
    })
    return written
  }

  async insertHourly(instanceId: string, row: HourlyRow): Promise<void> {
    const client = await this.client()
    const document: HourlyDoc = { instanceId, ...row }
    await client.index({
      index: HOURLY_INDEX,
      id: hourlyId(instanceId, row.hourStart),
      document,
      refresh: 'wait_for'
    })
  }

  async getPartialHour(
    instanceId: string,
    hourStart: number
  ): Promise<NodeMetricsHourly | null> {
    const hits = await this.getHourSamples(instanceId, hourStart)
    if (hits.length === 0) return null
    const agg = aggregateRows(
      hits.map((hit) => hit._source),
      hourStart
    )
    agg.partial = true
    return agg
  }

  async purgeOldSamples(instanceId: string, olderThan: number): Promise<number> {
    const query = olderThanQuery(instanceId, 'collectedAt', olderThan)
    return deleteMatching(await this.client(), SAMPLES_INDEX, query)
  }

  async deleteHourlyOlderThan(instanceId: string, cutoff: number): Promise<number> {
    const query = olderThanQuery(instanceId, 'hourStart', cutoff)
    return deleteMatching(await this.client(), HOURLY_INDEX, query)
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
  ): Promise<estypes.SearchHit<SampleDoc>[]> {
    const client = await this.client()
    const result = await client.search<SampleDoc>({
      index: SAMPLES_INDEX,
      query: hourRangeQuery(instanceId, hourStart),
      // one hour holds 60 samples, one per minute
      size: MAX_RESULT_WINDOW,
      // the rollup deletes the samples of the hour: it must see all of them
      allow_partial_search_results: false
    })
    assertCompleteSearch(result, SAMPLES_INDEX)
    return result.hits.hits
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
