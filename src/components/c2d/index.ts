import { OceanNode } from '../../OceanNode.js'
import { getConfiguration } from '../../utils/config.js'
import { ComputeGetEnvironmentsHandler } from '../core/compute/index.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import {
  deleteKeysFromObject,
  isDefined,
  sanitizeServiceFiles,
  streamToObject
} from '../../utils/util.js'
import { Readable } from 'stream'
import { decrypt } from '../../utils/crypt.js'
import { BaseFileObject, EncryptMethod } from '../../@types/fileObject.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { ComputeJob, DBComputeJob } from '../../@types/index.js'

export { C2DEngine } from './compute_engine_base.js'

export async function checkC2DEnvExists(
  envId: string,
  oceanNode: OceanNode
): Promise<boolean> {
  const config = await getConfiguration()
  const { supportedNetworks } = config
  for (const supportedNetwork of Object.keys(supportedNetworks)) {
    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS,
      chainId: parseInt(supportedNetwork)
    }
    const response = await new ComputeGetEnvironmentsHandler(oceanNode).handle(
      getEnvironmentsTask
    )
    if (response.status.httpStatus === 200) {
      const computeEnvironments = await streamToObject(response.stream as Readable)
      for (const computeEnvironment of computeEnvironments[parseInt(supportedNetwork)]) {
        if (computeEnvironment.id === envId) {
          return true
        }
      }
    }
  }
  return false
}

export async function decryptFilesObject(
  serviceFiles: any
): Promise<BaseFileObject | null> {
  try {
    // 2. Decrypt the url
    const decryptedUrlBytes = await decrypt(
      Uint8Array.from(Buffer.from(sanitizeServiceFiles(serviceFiles), 'hex')),
      EncryptMethod.ECIES
    )

    // 3. Convert the decrypted bytes back to a string
    const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
    const decryptedFileArray = JSON.parse(decryptedFilesString)

    console.log('decryptedFileArray: ', decryptedFileArray)
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
    'stopRequested',
    'algorithm',
    'assets',
    'isRunning',
    'isStarted',
    'containerImage'
  ]) as ComputeJob
  return job
}

export function isLegacyComputeEnvironment(environment: any): boolean {
  // just check a few know 'old' props to see if they are present
  return (
    isDefined(environment) &&
    (isDefined(environment.cpuNumber) ||
      isDefined(environment.cpuType) ||
      isDefined(environment.diskGB) ||
      isDefined(environment.ramGB))
  )
}
