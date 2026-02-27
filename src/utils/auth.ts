import { isAddress } from 'ethers'
import { getConfiguration } from './index.js'
import { AccessListContract, OceanNodeConfig } from '../@types/OceanNode.js'

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
