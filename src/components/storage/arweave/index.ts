import { Storage } from '..'
import { FileObject } from '../fileObject'

export class ArweaveStorage extends Storage {
  public constructor(files: FileObject) {
    super(files)
  }
}
