import {
  ArweaveFileObject,
  EncryptMethod,
  IpfsFileObject,
  UrlFileObject
} from '../@types/fileObject.js'
import { OceanNode } from '../OceanNode.js'
import { FindDdoHandler } from '../components/core/handler/ddoHandler.js'
import { AssetUtils } from './asset.js'
import { decrypt } from './crypt.js'
import { CORE_LOGGER } from './logging/common.js'
import { sanitizeServiceFiles } from './util.js'
import { isOrderingAllowedForAsset } from '../components/core/handler/downloadHandler.js'
import { DDO, Service } from '@oceanprotocol/ddo-js'

export async function getFile(
  didOrDdo: string | DDO,
  serviceId: string,
  node: OceanNode
): Promise<UrlFileObject[] | ArweaveFileObject[] | IpfsFileObject[]> {
  try {
    // 1. Get the DDO
    const ddo =
      typeof didOrDdo === 'string'
        ? ((
            await new FindDdoHandler(node).findAndFormatDdo(didOrDdo)
          ).getDDOData() as DDO)
        : didOrDdo

    const isOrdable = isOrderingAllowedForAsset(ddo)
    if (!isOrdable.isOrdable) {
      CORE_LOGGER.error(isOrdable.reason)
      throw new Error(isOrdable.reason)
    }

    // 2. Get the service
    const service: Service = AssetUtils.getServiceById(ddo, serviceId)
    if (!service) {
      const msg = `Service with id ${serviceId} not found`
      CORE_LOGGER.error(msg)
      throw new Error(msg)
    }
    // 3. Decrypt the url
    const decryptedUrlBytes = await decrypt(
      Uint8Array.from(Buffer.from(sanitizeServiceFiles(service.files), 'hex')),
      EncryptMethod.ECIES
    )
    CORE_LOGGER.logMessage(`URL decrypted for Service ID: ${serviceId}`)

    // Convert the decrypted bytes back to a string
    const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
    const decryptedFileArray = JSON.parse(decryptedFilesString)
    return decryptedFileArray.files
  } catch (error) {
    const msg = 'Error occured while requesting the files: ' + error.message
    CORE_LOGGER.error(msg)
    throw new Error(msg)
  }
}
