import { Storage } from '..'
import { FileObject } from '../fileObject'

export class IpfsStorage extends Storage {
  public constructor(files: FileObject) {
    super(files)
  }
}
