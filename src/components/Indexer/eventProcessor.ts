import { ethers, getAddress, hexlify, isAddress, keccak256, toUtf8Bytes } from 'ethers'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import { getNFTContract } from './utils.js'
import { createHash } from 'node:crypto'

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
  provider: ethers.Provider
) => {
  const nftContract = getNFTContract(provider, event.address)

  const receipt = await provider.getTransactionReceipt(event.transactionHash)
  INDEXER_LOGGER.logMessage(`Process new DDO: ${event.blockNumber}, receipt ${receipt} `)

  const eventData = event.data

  // const decodedEvent = await nftContract.parseLog(event)
  const expectedDID =
    'did:op:' +
    createHash('sha256')
      .update(getAddress(event.address) + chainId.toString(10))
      .digest('hex')
  INDEXER_LOGGER.logMessage(
    `Process new DDO: ${expectedDID}, block ${event.blockNumber}, ` +
      `contract: ${event.address}, txid: ${event.transactionHash}, chainId: ${chainId}`
  )

  // INDEXER_LOGGER.logMessage(
  //   `Process new DDO: ${expectedDID}, metaDataHash ${decodedEvent.args.metaDataHash}, `
  // )

  INDEXER_LOGGER.logMessage(`Process new DDO: ${expectedDID}, data ${eventData} `)
  return event.data
}
