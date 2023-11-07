import urlJoin from 'url-join'
import { Storage } from '..'
import { FileObject } from '../../../@types/fileObject'

export class ArweaveStorage extends Storage {
  public constructor(file: FileObject) {
    super(file)
  }

  validate(): boolean {
    const file: FileObject = this.getFile()
    if (!file.transactionId) {
      return false
    }
    return true
  }

  getDownloadUrl(): string {
    if (this.validate() === true) {
      if (!process.env.ARWEAVE_GATEWAY) {
        throw Error('Arweave gateway is not provided!')
      }
      return urlJoin(process.env.ARWEAVE_GATEWAY, this.getFile().transactionId)
    }
  }
}
