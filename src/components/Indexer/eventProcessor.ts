import {
  Interface,
  JsonRpcApiProvider,
  ethers,
  getAddress,
  hexlify,
  isAddress,
  keccak256,
  toUtf8Bytes
} from 'ethers'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import { getNFTContract } from './utils.js'
import { createHash } from 'node:crypto'
import { EVENTS } from '../../utils/constants.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }

export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

//   const deployerAddress =
//   const deployedByDeployer = eventData.some(
//     (event: { deployer: string }) => event.deployer === deployerAddress
//   )

//   if (deployedByDeployer) {
//     INDEXER_LOGGER.log(
//       LOG_LEVELS_STR.LEVEl_ERROR,
//       `nft not deployed by our factory`,
//       true
//     )
//   }

export const processMetadataCreatedEvent = async (
  event: ethers.Log,
  chainId: number,
  provider: JsonRpcApiProvider
) => {
  const nftContract = await getNFTContract(provider, event.address)
  nftContract.getEvent(EVENTS.METADATA_CREATED)

  const receipt = await provider.getTransactionReceipt(event.transactionHash)

  const iface = new Interface(ERC721Template.abi)
  const eventObj = {
    topics: receipt.logs[0].topics as string[],
    data: receipt.logs[0].data
  }
  const decodedEventData = iface.parseLog(eventObj)

  console.log('decodedEventData', decodedEventData.args)

  // const eventData = event.data
  const expectedDID =
    'did:op:' +
    createHash('sha256')
      .update(getAddress(event.address) + chainId.toString(10))
      .digest('hex')
  // INDEXER_LOGGER.logMessage(
  //   `Process new DDO: ${expectedDID}, block ${event.blockNumber}, ` +
  //     `contract: ${event.address}, txid: ${event.transactionHash}, chainId: ${chainId}`
  // )

  // INDEXER_LOGGER.logMessage(
  //   `Process new DDO: ${expectedDID}, metaDataHash ${decodedEvent.args.metaDataHash}, `
  // )

  INDEXER_LOGGER.logMessage(`Process new DDO: ${expectedDID}, data ${event.data} `)
  return event.data
}
