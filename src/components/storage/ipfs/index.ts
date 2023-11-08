import urlJoin from 'url-join'
import { Storage } from '..'
import { FileObject } from '../../../@types/fileObject'
import { Readable } from 'stream'

export class IpfsStorage extends Storage {
  public constructor(file: FileObject) {
    super(file)
  }

  validate(): boolean {
    const file: FileObject = this.getFile()
    if (!file.hash) {
      return false
    }

    return true
  }

  getDownloadUrl(): string {
    if (this.validate() === true) {
      if (!process.env.IPFS_GATEWAY) {
        throw Error('IPFS gateway is not provided!')
      }
      return urlJoin(process.env.IPFS_GATEWAY, urlJoin('/ipfs', this.getFile().hash))
    }
  }

  getReadableStream(readableStream: Readable): Promise<string> {
    return super.getReadableStream(readableStream)
  }
}
