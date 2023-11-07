import { Storage } from '..'
import { FileObject } from '../fileObject'

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
}
