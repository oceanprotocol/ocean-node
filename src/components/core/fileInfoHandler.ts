import { Readable } from 'stream'
import { P2PCommandResponse } from '../../@types'
import { ArweaveFileObject, IpfsFileObject, UrlFileObject } from '../../@types/fileObject'
import { FileInfoCommand } from '../../utils'
import { P2P_CONSOLE_LOGGER } from '../../utils/logging/common'
import { ArweaveStorage, IpfsStorage, UrlStorage } from '../storage'
import { Handler } from './handler'
import { OceanP2P } from '../P2P'
import { decrypt } from '../../utils/crypt'
import { Service } from '../../@types/DDO/Service'
import { FindDdoHandler } from './ddoHandler'
import { AssetUtils } from '../../utils/asset'

async function getFile(
  did: string,
  serviceId: string,
  node: OceanP2P
): Promise<UrlFileObject[] | ArweaveFileObject[] | IpfsFileObject[]> {
  // 1. Get the DDO
  const ddo = await new FindDdoHandler(node).findAndFormatDdo(did)
  // 2. Get the service
  const service: Service = AssetUtils.getServiceById(ddo, serviceId)
  // 3. Decrypt the url
  const decryptedUrlBytes = await decrypt(
    Uint8Array.from(Buffer.from(service.files, 'hex')),
    'ECIES'
  )
  // Convert the decrypted bytes back to a string
  const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
  const decryptedFileArray = JSON.parse(decryptedFilesString)
  return decryptedFileArray.files
}
export class FileInfoHandler extends Handler {
  // No encryption here yet

  async handle(task: FileInfoCommand): Promise<P2PCommandResponse> {
    try {
      P2P_CONSOLE_LOGGER.logMessage(
        'File Info Request recieved with arguments: ' + JSON.stringify(task, null, 2),
        true
      )
      const p2pNode = this.getP2PNode()

      if (task.file && task.type) {
        const storage =
          task.type === 'url'
            ? new UrlStorage(task.file as UrlFileObject)
            : task.type === 'arweave'
            ? new ArweaveStorage(task.file as ArweaveFileObject)
            : task.type === 'ipfs'
            ? new IpfsStorage(task.file as IpfsFileObject)
            : null

        const fileInfo = await storage.getFileInfo(task)
        P2P_CONSOLE_LOGGER.logMessage(
          'File Info Response: ' + JSON.stringify(fileInfo, null, 2),
          true
        )
        return {
          stream: Readable.from(JSON.stringify(fileInfo)),
          status: {
            httpStatus: 200
          }
        }
      } else if (task.did && task.serviceId) {
        const file = await getFile(task.did, task.serviceId, p2pNode)

        // return {
        //   stream: Readable.from(JSON.stringify(fileInfo)),
        //   status: {
        //     httpStatus: 200
        //   }
        // }
      } else {
        const errorMessage =
          'Invalid arguments. Please provide either file && Type OR did && serviceId'
        P2P_CONSOLE_LOGGER.error(errorMessage)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: errorMessage
          }
        }
      }
    } catch (error) {
      P2P_CONSOLE_LOGGER.error(error.message)
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: error.message
        }
      }
    }
  }
}
