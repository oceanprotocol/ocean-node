import {
  Contract,
  Interface,
  JsonRpcApiProvider,
  ethers,
  getAddress,
  getBytes,
  toUtf8String
} from 'ethers'
import { createHash } from 'crypto'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { getConfig } from '../../utils/config.js'
import { Database } from '../database/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { MetadataStates } from '../../utils/constants.js'
import { INDEXER_LOGGER } from './index.js'

class BaseEventProcessor {
  protected config: OceanNodeConfig

  constructor() {
    this.config = null
  }

  protected async getConfiguration(): Promise<OceanNodeConfig> {
    if (!this.config) {
      this.config = await getConfig()
    }
    return this.config
  }

  protected getTokenInfo(services: any[]): any[] {
    const datatokens: any[] = []
    services.forEach((service) => {
      datatokens.push({
        address: service.datatokenAddress,
        name: 'Datatoken',
        symbol: 'DT1',
        serviceId: service.id
      })
    })
    return datatokens
  }
}

class MetadataEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    provider: JsonRpcApiProvider
  ): Promise<any> {
    try {
      const receipt = await provider.getTransactionReceipt(event.transactionHash)
      const iface = new Interface(ERC721Template.abi)
      const eventObj = {
        topics: receipt.logs[0].topics as string[],
        data: receipt.logs[0].data
      }
      const decodedEventData = iface.parseLog(eventObj)
      const byteArray = getBytes(decodedEventData.args[4])
      const utf8String = toUtf8String(byteArray)
      const ddo = JSON.parse(utf8String)
      ddo.datatokens = this.getTokenInfo(ddo.services)
      INDEXER_LOGGER.logMessage(
        `Processed new DDO data ${ddo.id} with txHash ${event.transactionHash} from block ${event.blockNumber}`,
        true
      )
      return ddo
    } catch (error) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error processMetadataEvents: ${error}`,
        true
      )
    }
  }
}

class MetadataStateEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    provider: JsonRpcApiProvider
  ): Promise<any> {
    INDEXER_LOGGER.logMessage(`Processing metadata state event...`, true)
  }
}

class OrderStartedEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    provider: JsonRpcApiProvider
  ): Promise<any> {}
}

class OrderReusedEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    provider: JsonRpcApiProvider
  ): Promise<any> {}
}
