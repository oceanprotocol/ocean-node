import urlJoin from 'url-join'
import { Storage } from '..'
import { FileObject } from '../../../@types/fileObject'
import { Readable } from 'stream'

export class ArweaveStorage extends Storage {
  public constructor(file: FileObject) {
    super(file)
  }

  validate(): [boolean, string] {
    const file: FileObject = this.getFile()
    if (!file.transactionId) {
      return [false, 'Missing transaction ID']
    }
    return [true, '']
  }

  getDownloadUrl(): string {
    if (this.validate()[0] === true) {
      if (!process.env.ARWEAVE_GATEWAY) {
        throw Error('Arweave gateway is not provided!')
      }
      return urlJoin(process.env.ARWEAVE_GATEWAY, this.getFile().transactionId)
    }
  }

  getReadableStream(readableStream: Readable): Promise<string> {
    return super.getReadableStream(readableStream)
  }
}
