import { UrlStorage } from './url'
import { IpfsStorage } from './ipfs'
import { ArweaveStorage } from './arweave'
import { FileObject } from './fileObject'

export class Storage {
  private file: FileObject
  public constructor(file: FileObject) {
    this.file = file
  }

  getStorageClass(): any {
    const type: string = this.file.type
    switch (type) {
      case 'url':
        return new UrlStorage(this.file)
      case 'ipfs':
        return new IpfsStorage(this.file)
      case 'arweave':
        return new ArweaveStorage(this.file)
      default:
        throw new Error(`Invalid storage type: ${type}`)
    }
  }
}
