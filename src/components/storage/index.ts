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

export class UrlStorage extends Storage {
  public constructor(file: FileObject) {
    super(file)
  }

  validate(): [boolean, string] {
    const file: FileObject = this.getFile()
    if (!file.url || !file.method) {
      return [false, 'URL or method are missing!']
    }
    if (!['get', 'post'].includes(file.method.toLowerCase())) {
      return [false, 'Invalid method for URL']
    }
    if (this.isFilePath() === true) {
      return [false, 'URL looks like a file path']
    }

    return [true, '']
  }

  isFilePath(): boolean {
    const regex: RegExp = /^(.+)\/([^/]+)$/ // The URL should not represent a path
    const url: string = this.getFile().url
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return false
    }

    return regex.test(url)
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

export class ArweaveStorage extends Storage {
  public constructor(file: FileObject) {
    super(file)
  }

  validate(): [boolean, string] {
    const file: FileObject = this.getFile()
    if (!file.transactionId) {
      return [false, 'Missing transaction ID']
    }
    return [true, '']
  }

  getDownloadUrl(): string {
    if (this.validate()[0] === true) {
      if (!process.env.ARWEAVE_GATEWAY) {
        throw Error('Arweave gateway is not provided!')
      }
      return process.env.ARWEAVE_GATEWAY + '/' + this.getFile().transactionId
    }
  }

  getReadableStream(readableStream: Readable): Promise<string> {
    return super.getReadableStream(readableStream)
  }
}

export class IpfsStorage extends Storage {
  public constructor(file: FileObject) {
    super(file)
  }

  validate(): [boolean, string] {
    const file: FileObject = this.getFile()
    if (!file.hash) {
      return [false, 'Missing CID']
    }

    return [true, '']
  }

  getDownloadUrl(): string {
    if (this.validate()[0] === true) {
      if (!process.env.IPFS_GATEWAY) {
        throw Error('IPFS gateway is not provided!')
      }
      return process.env.IPFS_GATEWAY + '/ipfs/' + this.getFile().hash
    }
  }

  getReadableStream(readableStream: Readable): Promise<string> {
    return super.getReadableStream(readableStream)
  }
}
