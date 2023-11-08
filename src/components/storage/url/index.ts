import { Storage } from '..'
import { FileObject } from '../../../@types/fileObject'
import { Readable } from 'stream'

export class UrlStorage extends Storage {
  public constructor(file: FileObject) {
    super(file)
  }

  validate(): [boolean, string] {
    const file: FileObject = this.getFile()
    if (!file.url && !file.method) {
      return [false, 'URL or method are missing!']
    }
    if (['get', 'post'].includes(file.method.toLowerCase())) {
      return [false, 'Invalid method for URL']
    }
    if (this.validateFilename() === true) {
      return [false, 'URL looks like a file path']
    }

    return [true, '']
  }

  validateFilename(): boolean {
    const regex: RegExp = /\\|\.\.|/ // The file name should not be a path
    const url: string = this.getFile().url
    const filename: string = url.split('/').pop()
    return regex.test(filename)
  }

  getDownloadUrl(): string {
    if (this.validate()[0] === true) {
      return this.getFile().url
    }
  }

  getReadableStream(readableStream: Readable): Promise<string> {
    return super.getReadableStream(readableStream)
  }
}
