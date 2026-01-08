import { ethers, isAddress } from 'ethers'
import { CORE_LOGGER } from './logging/common.js'
import { getConfiguration } from './index.js'
import { AccessListContract, OceanNodeConfig } from '../@types/OceanNode.js'
import { LOG_LEVELS_STR } from './logging/Logger.js'
import { CommonValidation } from './validators.js'
import { isERC1271Valid } from '../components/core/utils/nonceHandler.js'
import { checkSingleCredential } from './credentials.js'
import { CREDENTIALS_TYPES } from '../@types/DDO/Credentials.js'
export async function validateAdminSignature(
  expiryTimestamp: number,
  signature: string,
  address?: string
): Promise<CommonValidation> {
  const message = expiryTimestamp.toString()
  let signerAddress

  try {
    const config = await getConfiguration()
    if (address) {
      const hexMessage = ethers.hashMessage(message)
      const firstChainId = Object.keys(config?.supportedNetworks || {})[0]
      if (firstChainId) {
        const provider = new ethers.JsonRpcProvider(
          config.supportedNetworks[firstChainId].rpc
        )

        if (!(await isERC1271Valid(address, hexMessage, signature, provider))) {
          return { valid: false, error: 'Invalid ERC1271 signature' }
        }
        signerAddress = address
      } else {
        return { valid: false, error: 'No network configured in node config' }
      }
    } else {
      signerAddress = ethers.verifyMessage(message, signature)?.toLowerCase()
      CORE_LOGGER.logMessage(`Resolved signer address: ${signerAddress}`)
    }

    const currentTimestamp = new Date().getTime()
    if (currentTimestamp > expiryTimestamp) {
      const errorMsg = `The expiryTimestamp ${expiryTimestamp} sent for validation is in the past. Therefore signature ${signature} is rejected`
      CORE_LOGGER.logMessage(errorMsg)
      return { valid: false, error: errorMsg }
    }
    const allowedAdmins = await getAdminAddresses(config)

    const { addresses, accessLists } = allowedAdmins
    let allowed = await checkSingleCredential(
      { type: CREDENTIALS_TYPES.ADDRESS, values: addresses },
      signerAddress,
      null
    )
    if (allowed) {
      return { valid: true, error: '' }
    }
    for (const chainId of Object.keys(accessLists)) {
      allowed = await checkSingleCredential(
        {
          type: CREDENTIALS_TYPES.ACCESS_LIST,
          chainId: parseInt(chainId),
          accessList: accessLists[chainId]
        },
        signerAddress,
        null
      )
      if (allowed) {
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

export async function getAdminAddresses(
  existingConfig?: OceanNodeConfig
): Promise<{ addresses: string[]; accessLists: any }> {
  let config: OceanNodeConfig
  const ret = {
    addresses: [] as string[],
    accessLists: undefined as AccessListContract | undefined
  }
  if (!existingConfig) {
    config = await getConfiguration()
  } else {
    config = existingConfig
  }

  if (config.allowedAdmins && config.allowedAdmins.length > 0) {
    for (const admin of config.allowedAdmins) {
      if (isAddress(admin) === true) {
        ret.addresses.push(admin)
      }
    }
  }
  ret.accessLists = config.allowedAdminsList
  return ret
}
