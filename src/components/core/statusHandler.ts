import {
  OceanNodeStatus,
  OceanNodeConfig,
  OceanNodeProvider,
  OceanNodeIndexer
} from '../../@types'
import { Blockchain } from '../../utils/blockchain.js'
import { version } from '../../../package.json'

export function status(config: OceanNodeConfig, blockchain: Blockchain): OceanNodeStatus {
  let status: OceanNodeStatus
  status.version = version
  status.publicKey = config.keys.publicKey
  status.address = config.keys.ethAddress
  status.http = config.hasHttp
  status.p2p = config.hasP2P
  const supportedChains = blockchain.getSupportedChains()
  status.provider = supportedChains.map((chain) => {
    let provider: OceanNodeProvider
    provider.chainId = chain
    provider.network = blockchain.getNetworkNameByChainId(chain)
    return provider
  })
  status.indexer = supportedChains.map((chain) => {
    let indexer: OceanNodeIndexer
    indexer.chainId = chain
    indexer.network = blockchain.getNetworkNameByChainId(chain)
    indexer.block = '0'
    return indexer
  })

  return status
}
