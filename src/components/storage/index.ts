import { ArweaveFileObject } from '../../@types/arweaveFileObject'
import { IpfsFileObject } from '../../@types/ipfsFileObject'
import { UrlFileObject } from '../../@types/urlFileObject'
import { Readable } from 'stream'

export class Storage {
  private file: any
  public constructor(file: any) {
    this.file = file
  }

  getFile(): any {
    return this.file
  }

  getReadableStream(): Readable {
    return new Readable()
  }

  static getStorageClass(file: any): UrlStorage | IpfsStorage | ArweaveStorage {
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
}

export class UrlStorage extends Storage {
  public constructor(file: UrlFileObject) {
    super(file)
    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validationg the URL file: ${message}`)
    }
  }

  getFile(): UrlFileObject {
    if (this.getFile() instanceof UrlStorage) {
      return this.getFile()
    }
    throw new Error(`Invalid storage type for this method`)
  }

  validate(): [boolean, string] {
    const file: UrlFileObject = this.getFile()
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
    return null
  }

  getReadableStream(): Readable {
    const input = this.getDownloadUrl()
    const readableStream = new Readable()
    if (input) {
      readableStream.push(input)
      return readableStream
    } else {
      throw new Error(`Input stream is null due to invalid URL ${this.getFile().url}`)
    }
  }
}

export class ArweaveStorage extends Storage {
  public constructor(file: ArweaveFileObject) {
    super(file)

    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validationg the Arweave file: ${message}`)
    }
  }

  getFile(): ArweaveFileObject {
    if (this.getFile() instanceof ArweaveStorage) {
      return this.getFile()
    }
    throw new Error(`Invalid storage type for this method`)
  }

  validate(): [boolean, string] {
    const file: ArweaveFileObject = this.getFile()
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

  getReadableStream(): Readable {
    const input = this.getDownloadUrl()
    const readableStream = new Readable()
    if (input) {
      readableStream.push(input)
      return readableStream
    } else {
      throw new Error(
        `Input stream is null due to invalid URL. Transaction ID: ${
          this.getFile().transactionId
        }`
      )
    }
  }
}

export class IpfsStorage extends Storage {
  public constructor(file: IpfsFileObject) {
    super(file)

    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validationg the IPFS file: ${message}`)
    }
  }

  getFile(): IpfsFileObject {
    if (this.getFile() instanceof IpfsStorage) {
      return this.getFile()
    }
    throw new Error(`Invalid storage type for this method`)
  }

  validate(): [boolean, string] {
    const file: IpfsFileObject = this.getFile()
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

  getReadableStream(): Readable {
    const input = this.getDownloadUrl()
    const readableStream = new Readable()
    if (input) {
      readableStream.push(input)
      return readableStream
    } else {
      throw new Error(
        `Input stream is null due to invalid URL. CID: ${this.getFile().hash}`
      )
    }
  }
}
