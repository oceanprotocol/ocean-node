import { Storage } from '..'
import { FileObject } from '../fileObject'

export class UrlStorage extends Storage {
  public constructor(file: FileObject) {
    super(file)
  }

  validate(): boolean {
    const file: FileObject = this.getFile()
    if (!file.url && !file.method) {
      return false
    }
    if (['get', 'post'].includes(file.method.toLowerCase())) {
      return false
    }
    if (this.validateFilename()) {
      return false
    }

    return true
  }

  validateFilename(): boolean {
    const regex: RegExp = /\\|\.\.|/
    const url: string = this.getFile().url
    const filename: string = url.split('/').pop()
    return regex.test(filename)
  }
}
