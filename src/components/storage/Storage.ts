import {
  FileInfoRequest,
  FileInfoResponse,
  FileObjectType,
  StorageReadable,
  StorageObject,
  EncryptMethod
} from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { HeadersObject } from '../../@types/fileObject.js'

import { CORE_LOGGER } from '../../utils/logging/common.js'
import { DEFAULT_FILEINFO_ALLOWED_HEADERS } from '../../utils/config/constants.js'

export abstract class Storage {
  static getStorageClass: (
    file: any,
    config: OceanNodeConfig,
    consumerAddress?: string
  ) => Storage

  private file: StorageObject
  config: OceanNodeConfig
  public hasUpload: boolean
  // ON-07: true only when this storage was built for the UNAUTHENTICATED-risk raw-`file`
  // fileInfo path, where the file object (and its headers) come straight from a remote caller.
  // That path is the header-injection concern the allow-list targets, so only it filters.
  // Other caller-file paths (encrypt, and download/compute inputs sourced from a decrypted
  // DDO) are left unfiltered: they are authenticated and their outbound fetch is restricted to
  // public hosts by the SSRF guard, so header filtering is not the control there — and
  // filtering would break legitimately publisher-supplied auth headers for protected assets.
  // Defaults to false so existing flows are unchanged.
  protected callerHeadersUntrusted: boolean = false
  public constructor(
    file: StorageObject,
    config: OceanNodeConfig,
    hasUpload: boolean = false
  ) {
    this.file = file
    this.config = config
    this.hasUpload = hasUpload
  }

  /** Mark this storage's caller-supplied headers as untrusted so they are allow-listed. */
  markHeadersUntrusted(): this {
    this.callerHeadersUntrusted = true
    return this
  }

  abstract validate(): [boolean, string]

  abstract fetchSpecificFileMetadata(
    fileObject: any,
    forceChecksum: boolean
  ): Promise<FileInfoResponse>

  getFile(): any {
    return this.file
  }

  /**
   * ON-07: filter caller-supplied request headers down to an allow-list before they are
   * forwarded to the upstream. Prevents header injection to internal services (e.g. leaking
   * an `authorization`/`cookie`/`x-*` service key to an attacker-chosen URL). The built-in
   * default allow-list is extended by `config.fileInfoAllowedHeaders`. Comparison is
   * case-insensitive; the original header names/casing are preserved on the way out.
   */
  filterForwardedHeaders(headers?: HeadersObject): HeadersObject | undefined {
    // Only filter headers that came from an untrusted caller (raw-`file` fileInfo). Trusted
    // DDO-sourced headers (authenticated URL assets) must pass through untouched.
    if (!this.callerHeadersUntrusted) {
      return headers
    }
    if (!headers || typeof headers !== 'object') {
      return headers
    }
    const extra = Array.isArray(this.config?.fileInfoAllowedHeaders)
      ? this.config.fileInfoAllowedHeaders
      : []
    const allowed = new Set(
      [...DEFAULT_FILEINFO_ALLOWED_HEADERS, ...extra].map((h) => String(h).toLowerCase())
    )
    const filtered: HeadersObject = {}
    const dropped: string[] = []
    for (const [key, value] of Object.entries(headers)) {
      if (allowed.has(key.toLowerCase())) {
        filtered[key] = value
      } else {
        dropped.push(key)
      }
    }
    if (dropped.length > 0) {
      CORE_LOGGER.debug(
        `Dropped non-allow-listed forwarded header(s): ${dropped.join(', ')}`
      )
    }
    return filtered
  }

  abstract getReadableStream(): Promise<StorageReadable>

  getStorageType(file: any): FileObjectType {
    const { type } = file
    return type
  }

  async getFileInfo(
    fileInfoRequest: FileInfoRequest,
    forceChecksum: boolean = false
  ): Promise<FileInfoResponse[]> {
    if (!fileInfoRequest.type) {
      throw new Error('Storage type is not provided')
    }

    const response: FileInfoResponse[] = []

    try {
      const file = this.getFile()

      if (!file) {
        throw new Error('Empty file object')
      } else {
        const fileInfo = await this.fetchSpecificFileMetadata(file, forceChecksum)
        response.push(fileInfo)
      }
    } catch (error) {
      CORE_LOGGER.error(`getFileInfo failed: ${error.message}`)
      throw error
    }
    return response
  }

  isEncrypted(): boolean {
    if (
      this.file.encryptedBy &&
      (this.file.encryptMethod === EncryptMethod.AES ||
        this.file.encryptMethod === EncryptMethod.ECIES)
    ) {
      return true
    } else {
      return false
    }
  }

  canDecrypt(nodeId: string): boolean {
    if (
      this.file.encryptedBy === nodeId &&
      (this.file.encryptMethod === EncryptMethod.AES ||
        this.file.encryptMethod === EncryptMethod.ECIES)
    ) {
      return true
    } else {
      return false
    }
  }
}
