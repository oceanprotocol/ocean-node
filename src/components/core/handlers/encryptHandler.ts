import { EncryptCommand } from '../../../utils/constants.js'
import { P2PCommandResponse } from '../../../@types/index.js'
import { Readable } from 'stream'
import * as base58 from 'base58-js'
import { encrypt } from '../../../utils/crypt.js'
import { Handler } from './handler.js'

export class EncryptHandler extends Handler {
  public constructor(task: any) {
    super(task, null, null)
    if (!this.isEncryptCommand(task)) {
      throw new Error(`Task has not EncryptCommand type. It has ${typeof task}`)
    }
  }

  isEncryptCommand(obj: any): obj is EncryptCommand {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      'command' in obj &&
      'blob' in obj &&
      'encoding' in obj &&
      'encryptionType' in obj
    )
  }

  async handle(): Promise<P2PCommandResponse> {
    try {
      // prepare an empty array in case if
      let blobData: Uint8Array = new Uint8Array()
      if (this.getTask().encoding === 'string') {
        // get bytes from basic blob
        blobData = Uint8Array.from(Buffer.from(this.getTask().blob))
      }
      if (this.getTask().encoding === 'base58') {
        // get bytes from a blob that is encoded in standard base58
        blobData = base58.base58_to_binary(this.getTask().blob)
      }
      // do encrypt magic
      const encryptedData = await encrypt(blobData, this.getTask().encryptionType)
      return {
        stream: Readable.from(encryptedData.toString('hex')),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
