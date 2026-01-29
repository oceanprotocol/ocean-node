import { deleteKeysFromObject, sanitizeServiceFiles } from '../../utils/util.js'

import { BaseFileObject, EncryptMethod } from '../../@types/fileObject.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { ComputeJob, DBComputeJob } from '../../@types/index.js'
import { OceanNode } from '../../OceanNode.js'
export { C2DEngine } from './compute_engine_base.js'

export async function decryptFilesObject(
  serviceFiles: any
): Promise<BaseFileObject | null> {
  const node = OceanNode.getInstance()

  try {
    // 2. Decrypt the url
    const decryptedUrlBytes = await node
      .getKeyManager()
      .decrypt(
        Uint8Array.from(Buffer.from(sanitizeServiceFiles(serviceFiles), 'hex')),
        EncryptMethod.ECIES
      )

    // 3. Convert the decrypted bytes back to a string
    const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
    const decryptedFileArray = JSON.parse(decryptedFilesString)

    return decryptedFileArray.files[0]
  } catch (err) {
    CORE_LOGGER.error('Error decrypting files object: ' + err.message)
    return null
  }
}

export function omitDBComputeFieldsFromComputeJob(dbCompute: DBComputeJob): ComputeJob {
  const job: ComputeJob = deleteKeysFromObject(dbCompute, [
    'clusterHash',
    'configlogURL',
    'publishlogURL',
    'algologURL',
    'outputsURL',
    'algorithm',
    'assets',
    'isRunning',
    'isStarted',
    'containerImage'
  ]) as ComputeJob
  return job
}
