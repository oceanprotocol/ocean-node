import { StorageObject, EncryptMethod } from '../@types/fileObject.js'
import { OceanNode } from '../OceanNode.js'
import { FindDdoHandler } from '../components/core/handler/ddoHandler.js'
import { AssetUtils } from './asset.js'
import { CORE_LOGGER } from './logging/common.js'
import { errorSummary } from './logging/redact.js'
import { sanitizeServiceFiles } from './util.js'
import { isOrderingAllowedForAsset } from '../components/core/handler/downloadHandler.js'
import { DDO, Service } from '@oceanprotocol/ddo-js'

export async function getFile(
  didOrDdo: string | DDO,
  serviceId: string,
  node: OceanNode
): Promise<StorageObject[]> {
  try {
    // 1. Get the DDO
    const ddo =
      typeof didOrDdo === 'string'
        ? ((await new FindDdoHandler(node).findAndFormatDdo(didOrDdo)) as DDO)
        : didOrDdo

    const isOrdable = isOrderingAllowedForAsset(ddo)
    if (!isOrdable.isOrdable) {
      throw new Error(isOrdable.reason)
    }

    // 2. Get the service
    const service: Service = AssetUtils.getServiceById(ddo, serviceId)
    if (!service) {
      throw new Error(`Service with id ${serviceId} not found`)
    }
    // 3. Decrypt the url
    const decryptedUrlBytes = await node
      .getKeyManager()
      .decrypt(
        Uint8Array.from(Buffer.from(sanitizeServiceFiles(service.files), 'hex')),
        EncryptMethod.ECIES
      )
    CORE_LOGGER.debug(`URL decrypted for service ${serviceId}`)

    // Convert the decrypted bytes back to a string
    const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
    const decryptedFileArray = JSON.parse(decryptedFilesString)
    return decryptedFileArray.files
  } catch (error) {
    const did = typeof didOrDdo === 'string' ? didOrDdo : didOrDdo?.id
    CORE_LOGGER.debug(
      `getFile failed for ${did} service ${serviceId}: ${errorSummary(error)}`
    )
    throw new Error('Unable to decrypt files, files not served by the current node!')
  }
}
