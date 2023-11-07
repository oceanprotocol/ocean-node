import { Storage } from '..'
import { FileObject } from '../fileObject'

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
}
