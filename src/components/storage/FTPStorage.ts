import { Readable, PassThrough } from 'stream'
import { Client as FtpClient } from 'basic-ftp'
import {
  FileInfoResponse,
  FtpFileObject,
  StorageReadable
} from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { Storage } from './Storage.js'

const DEFAULT_FTP_PORT = 21
const DEFAULT_FTPS_PORT = 990

function parseFtpUrl(url: string): {
  host: string
  port: number
  user: string
  password: string
  path: string
  secure: boolean
} {
  const parsed = new URL(url)
  if (parsed.protocol !== 'ftp:' && parsed.protocol !== 'ftps:') {
    throw new Error(`Invalid FTP URL protocol: ${parsed.protocol}`)
  }
  const secure = parsed.protocol === 'ftps:'
  const port = parsed.port
    ? parseInt(parsed.port, 10)
    : secure
      ? DEFAULT_FTPS_PORT
      : DEFAULT_FTP_PORT
  const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : ''
  return {
    host: parsed.hostname,
    port,
    user: decodeURIComponent(parsed.username || 'anonymous'),
    password: decodeURIComponent(parsed.password || 'anonymous@'),
    path,
    secure
  }
}

export class FTPStorage extends Storage {
  public constructor(file: FtpFileObject, config: OceanNodeConfig) {
    super(file, config, true)
    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validating the FTP file: ${message}`)
    }
  }

  async getReadableStream(): Promise<StorageReadable> {
    const file = this.getFile() as FtpFileObject
    const { host, port, user, password, path, secure } = parseFtpUrl(file.url)
    const client = new FtpClient(30000)
    const passThrough = new PassThrough()

    try {
      await client.access({
        host,
        port,
        user,
        password,
        secure
      })
      client.downloadTo(passThrough, path).then(
        () => {
          client.close()
        },
        (err) => {
          passThrough.destroy(err)
          client.close()
        }
      )
    } catch (err) {
      client.close()
      throw err
    }

    return {
      httpStatus: 200,
      stream: passThrough,
      headers: {}
    }
  }

  /**
   * Upload a file via FTP STOR. Appends filename to path if url ends with /.
   */
  async upload(
    filename: string,
    stream: Readable
  ): Promise<{ httpStatus: number; headers?: Record<string, string | string[]> }> {
    const file = this.getFile() as FtpFileObject
    let { host, port, user, password, path, secure } = parseFtpUrl(file.url)
    if (path.endsWith('/')) {
      path = `${path.replace(/\/+$/, '')}/${encodeURIComponent(filename)}`
    } else if (!path || path === '/') {
      path = `/${encodeURIComponent(filename)}`
    }

    const client = new FtpClient(30000)
    try {
      await client.access({
        host,
        port,
        user,
        password,
        secure
      })
      await client.uploadFrom(stream, path)
      return { httpStatus: 200, headers: {} }
    } finally {
      client.close()
    }
  }

  validate(): [boolean, string] {
    const file = this.getFile() as FtpFileObject
    if (!file.url) {
      return [false, 'FTP URL is missing']
    }
    try {
      const parsed = new URL(file.url)
      if (parsed.protocol !== 'ftp:' && parsed.protocol !== 'ftps:') {
        return [false, 'URL must be ftp:// or ftps://']
      }
    } catch {
      return [false, 'Invalid FTP URL']
    }
    if (this.config?.unsafeURLs) {
      for (const regex of this.config.unsafeURLs) {
        try {
          // eslint-disable-next-line security/detect-non-literal-regexp
          const pattern = new RegExp(regex)
          if (pattern.test(file.url)) {
            return [false, 'URL is marked as unsafe']
          }
        } catch (e) {
          /* ignore */
        }
      }
    }
    return [true, '']
  }

  getDownloadUrl(): string {
    if (this.validate()[0] === true) {
      return this.getFile().url
    }
    return null
  }

  async fetchSpecificFileMetadata(
    fileObject: FtpFileObject,
    _forceChecksum: boolean
  ): Promise<FileInfoResponse> {
    const { host, port, user, password, path, secure } = parseFtpUrl(fileObject.url)
    const client = new FtpClient(30000)
    try {
      await client.access({
        host,
        port,
        user,
        password,
        secure
      })
      let size = 0
      try {
        size = await client.size(path)
      } catch {
        size = 0
      }
      const name = path.split('/').filter(Boolean).pop() || ''
      return {
        valid: true,
        contentLength: String(size >= 0 ? size : 0),
        contentType: 'application/octet-stream',
        name,
        type: 'ftp',
        encryptedBy: fileObject.encryptedBy,
        encryptMethod: fileObject.encryptMethod
      }
    } finally {
      client.close()
    }
  }
}
