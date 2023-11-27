import { ethers, getAddress, hexlify, isAddress, keccak256, toUtf8Bytes } from 'ethers'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import { getNFTContract } from './utils.js'

export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

export function makeDID(dataNFTAddress: string, chainId: number): string | null {
  const isValidAddress = isAddress(dataNFTAddress)

  if (!isValidAddress) {
    return null
  }

  const checksummedAddress = getAddress(dataNFTAddress)
  const didData = `${checksummedAddress}${chainId}`
  const didHash = keccak256(toUtf8Bytes(didData))
  const did = `did:op:${hexlify(didHash).substring(2)}`

  return did
}

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
  console.log('log address', event.address)
  const nftContract = getNFTContract(provider, event.address)

  console.log('log tx hash', event.transactionHash)
  const receipt = await provider.getTransactionReceipt(event.transactionHash)
  console.log('logs receipt', receipt.logs)

  const eventData = event.data
  console.log('eventData', eventData)

  const decodedEvent = await nftContract.parseLog(event)
  console.log('decodedEvent', decodedEvent)

  const expectedDID = makeDID(event.address, chainId)
  INDEXER_LOGGER.logMessage(
    `Process new DDO: ${expectedDID}, block ${event.blockNumber}, ` +
      `contract: ${event.address}, txid: ${event.transactionHash}, chainId: ${chainId}`
  )

  INDEXER_LOGGER.logMessage(
    `Process new DDO: ${expectedDID}, block ${decodedEvent.args.metaDataHash}, `
  )
  INDEXER_LOGGER.logMessage(
    `Process new DDO: ${expectedDID}, block ${decodedEvent.args.data}, `
  )
  return decodedEvent.args.data
}
