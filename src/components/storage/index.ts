import { UrlStorage } from './url'
import { IpfsStorage } from './ipfs'
import { ArweaveStorage } from './arweave'
import { FileObject } from '../../@types/fileObject'
import { Readable } from 'stream'

export class Storage {
  private file: FileObject
  public constructor(file: FileObject) {
    this.file = file
  }

  getFile(): FileObject {
    return this.file
  }

  static getStorageClass(file: FileObject): Storage {
    const type: string = file.type
    switch (type) {
      case 'url':
        return new UrlStorage(file)
      case 'ipfs':
        return new IpfsStorage(file)
      case 'arweave':
        return new ArweaveStorage(file)
      default:
        throw new Error(`Invalid storage type: ${type}`)
    }
  }

  validate(): [boolean, string] {
    return [true, '']
  }

  getDownloadUrl(): string {
    return ''
  }

  async getReadableStream(readableStream: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: string[] = []
      readableStream.on('data', (data) => {
        chunks.push(data.toString())
      })
      readableStream.on('end', () => {
        resolve(chunks.join(''))
      })
      readableStream.on('error', reject)
    })
  }
}
