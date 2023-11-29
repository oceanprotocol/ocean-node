import { Worker } from 'node:worker_threads'
import { Database } from '../database/index.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import { EVENTS } from '../../utils/index.js'
import { createHash } from 'crypto'
import { getAddress } from 'ethers'

export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

export class OceanIndexer {
  private db: Database
  private networks: RPCS
  private supportedChains: string[]

  constructor(db: Database, supportedNetworks: RPCS) {
    this.db = db
    this.networks = supportedNetworks
    this.supportedChains = Object.keys(supportedNetworks)
    this.startThreads()
  }

  public async startThreads(): Promise<void> {
    for (const network of this.supportedChains) {
      const chainId = parseInt(network)
      const rpcDetails: SupportedNetwork = this.networks[network]
      const lastIndexedBlock = await this.getLastIndexedBlock(chainId)
      const worker = new Worker('./dist/components/Indexer/crawlerThread.js', {
        workerData: { rpcDetails, lastIndexedBlock }
      })

      worker.on('message', (event: any) => {
        if (event.method === 'store-last-indexed-block') {
          this.updateLastIndexedBlockNumber(event.network, event.data)
        }
        if (event.method === EVENTS.METADATA_CREATED) {
          this.saveDDO(event.network, event.data)
        }
        if (event.method === EVENTS.METADATA_STATE) {
          this.storeState(event)
        }
      })

      worker.on('error', (err: Error) => {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEl_ERROR,
          `Error in worker for network ${network}: ${err.message}`,
          true
        )
      })

      worker.on('exit', (code: number) => {
        INDEXER_LOGGER.logMessage(
          `Worker for network ${network} exited with code: ${code}`,
          true
        )
      })

      worker.postMessage({ method: 'start-crawling' })
    }
  }

  public async getLastIndexedBlock(network: number): Promise<number> {
    const dbconn = this.db.indexer
    try {
      const indexer = await dbconn.retrieve(network)
      return indexer?.lastIndexedBlock
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEl_ERROR,
        'Error retrieving last indexed block',
        true
      )
      return null
    }
  }

  public async saveDDO(network: number, ddo: any): Promise<void> {
    const dbconn = this.db.ddo
    try {
      const saveDDO = await dbconn.update({ ...ddo })
      INDEXER_LOGGER.logMessage(
        `Saved new DDO  : ${saveDDO.id} from network: ${network} `
      )
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEl_ERROR,
        'Error retrieving last indexed block',
        true
      )
    }
  }

  public async storeState(event: any): Promise<void> {
    INDEXER_LOGGER.logMessage(
      `MetadataState event data: ${event.data}, network: ${event.network}`,
      true
    )

    const dbconn = this.db.ddo
    const did =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(event.data.eventAddress) + event.network.toString(10))
        .digest('hex')
    try {
      const ddo = await dbconn.retrieve(did)
      if (!ddo) {
        INDEXER_LOGGER.logMessage(
          `Detected MetadataState changed for ${did}, but it does not exists.`
        )
        return
      }
      INDEXER_LOGGER.logMessage(`Found did ${did} on network ${event.network}`)
      if ('nft' in ddo && ddo.nft.state !== event.data.metadataState) {
        ddo.nft.state = event.data.metadataState
      } else {
        // Still update until we validate and polish schemas for DDO.
        // But it should update ONLY if first condition is met.
        // Check https://github.com/oceanprotocol/aquarius/blob/84a560ea972485e46dd3c2cfc3cdb298b65d18fa/aquarius/events/processors.py#L663
        ddo.nft = {
          state: event.data.metadataState
        }
      }
      INDEXER_LOGGER.logMessage(`Found did ${did} on network ${event.network}`)
      await dbconn.update({ ...ddo })
      INDEXER_LOGGER.logMessage(
        `Updated ddo ${did} state with ${event.data.metadataState} on network ${event.network}`
      )
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEl_ERROR,
        `Error retrieving & updating DDO state: ${err}`,
        true
      )
    }
  }

  public async updateLastIndexedBlockNumber(
    network: number,
    block: number
  ): Promise<void> {
    const dbconn = this.db.indexer
    try {
      const updatedIndex = await dbconn.update(network, block)
      INDEXER_LOGGER.logMessage(`New last indexed block : ${updatedIndex}`, true)
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEl_ERROR,
        'Error retrieving last indexed block',
        true
      )
    }
  }
}
