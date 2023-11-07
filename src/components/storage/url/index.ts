import { Storage } from '..'
import { FileObject } from '../fileObject'

export class UrlStorage extends Storage {
  public constructor(files: FileObject) {
    super(files)
  }
}
