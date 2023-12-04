import {
  Interface,
  JsonRpcApiProvider,
  ethers,
  getAddress,
  getBytes,
  toUtf8String
} from 'ethers'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import { createHash } from 'node:crypto'
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
  const receipt = await provider.getTransactionReceipt(event.transactionHash)
  const iface = new Interface(ERC721Template.abi)
  const eventObj = {
    topics: receipt.logs[0].topics as string[],
    data: receipt.logs[0].data
  }
  const decodedEventData = iface.parseLog(eventObj)
  console.log('decodedEventData == ', decodedEventData)

  // const eventData = event.data
  const expectedDID =
    'did:op:' +
    createHash('sha256')
      .update(getAddress(event.address) + chainId.toString(10))
      .digest('hex')

  // Convert hex string to byte array
  const byteArray = getBytes(decodedEventData.args[4])

  // Decode byte array to UTF-8 string
  const utf8String = toUtf8String(byteArray)
  // INDEXER_LOGGER.logMessage(
  //   `Process new DDO: ${expectedDID}, block ${event.blockNumber}, ` +
  //     `contract: ${event.address}, txid: ${event.transactionHash}, chainId: ${chainId}`
  // )

  // INDEXER_LOGGER.logMessage(
  //   `Process new DDO: ${expectedDID}, metaDataHash ${decodedEvent.args.metaDataHash}, `
  // )

  INDEXER_LOGGER.logMessage(`Process new DDO: ${expectedDID}, data ${utf8String} `)
  return utf8String
}
