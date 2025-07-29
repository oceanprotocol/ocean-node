import { ethers, isAddress } from 'ethers'
import { CORE_LOGGER } from './logging/common.js'
import { Blockchain, getConfiguration } from './index.js'
import { RPCS } from '../@types/blockchain.js'
import { isDefined } from '../utils/util.js'
import AccessListContract from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }
import { getAccountsFromAccessList } from '../utils/credentials.js'
import { OceanNodeConfig } from '../@types/OceanNode.js'
import { LOG_LEVELS_STR } from './logging/Logger.js'
import { CommonValidation } from './validators.js'
export async function validateAdminSignature(
  expiryTimestamp: number,
  signature: string
): Promise<CommonValidation> {
  const message = expiryTimestamp.toString()
  const signerAddress = ethers.verifyMessage(message, signature)?.toLowerCase()
  CORE_LOGGER.logMessage(`Resolved signer address: ${signerAddress}`)
  try {
    const allowedAdmins: string[] = await getAdminAddresses()
    console.log(`Allowed admins: ${allowedAdmins}`)

    if (allowedAdmins.length === 0) {
      const errorMsg = "Allowed admins list is empty. Please add admins' addresses."
      CORE_LOGGER.logMessage(errorMsg)
      return { valid: false, error: errorMsg }
    }
    const currentTimestamp = new Date().getTime()
    if (currentTimestamp > expiryTimestamp) {
      const errorMsg = `The expiryTimestamp ${expiryTimestamp} sent for validation is in the past. Therefore signature ${signature} is rejected`
      CORE_LOGGER.logMessage(errorMsg)
      return { valid: false, error: errorMsg }
    }
    for (const address of allowedAdmins) {
      if (
        ethers.getAddress(address)?.toLowerCase() ===
        ethers.getAddress(signerAddress)?.toLowerCase()
      ) {
        return { valid: true, error: '' }
      }
    }
    const errorMsg = `The address which signed the message is not on the allowed admins list. Therefore signature ${signature} is rejected`
    CORE_LOGGER.logMessage(errorMsg)
    return { valid: false, error: errorMsg }
  } catch (e) {
    const errorMsg = `Error during signature validation: ${e}`
    CORE_LOGGER.error(errorMsg)
    return { valid: false, error: errorMsg }
  }
}

export async function getAdminAddresses(): Promise<string[]> {
  const config: OceanNodeConfig = await getConfiguration()
  const validAddresses: string[] = []
  if (config.allowedAdmins && config.allowedAdmins.length > 0) {
    for (const admin of config.allowedAdmins) {
      if (isAddress(admin) === true) {
        validAddresses.push(admin)
      }
    }
    if (validAddresses.length === 0) {
      CORE_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Invalid format for ETH address from ALLOWED ADMINS.`
      )
    }
  }
  if (
    config.allowedAdminsList &&
    isDefined(config.supportedNetworks) &&
    Object.keys(config.allowedAdminsList).length > 0
  ) {
    const RPCS: RPCS = config.supportedNetworks
    const supportedChains: string[] = Object.keys(config.supportedNetworks)
    const accessListsChainsListed = Object.keys(config.allowedAdminsList)
    for (const chain of supportedChains) {
      const { chainId, network, rpc, fallbackRPCs } = RPCS[chain]
      const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)

      // check the access lists for this chain
      if (accessListsChainsListed.length > 0 && accessListsChainsListed.includes(chain)) {
        for (const accessListAddress of config.allowedAdminsList[chainId]) {
          // instantiate contract and check addresses present + balanceOf()
          const accessListContract = new ethers.Contract(
            accessListAddress,
            AccessListContract.abi,
            blockchain.getSigner()
          )

          const adminsFromAccessList: string[] = await getAccountsFromAccessList(
            accessListContract,
            chainId
          )
          if (adminsFromAccessList.length > 0) {
            return validAddresses.concat(adminsFromAccessList)
          }
        }
      }
    }
  }
  return validAddresses
}
