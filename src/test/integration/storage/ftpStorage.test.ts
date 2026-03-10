/**
 * FTPStorage integration tests.
 *
 * Uses vsftpd at 172.15.0.7 (ports 20/21) with user ftpuser / ftppass. before() uploads
 * readme.txt first so getReadableStream and getFileInfo have a file to read.
 */

import { Readable } from 'stream'
import { Storage, FTPStorage } from '../../../components/storage/index.js'
import { FileInfoRequest, FileObjectType } from '../../../@types/fileObject.js'
import { expect, assert } from 'chai'
import { getConfiguration } from '../../../utils/index.js'
import { DEFAULT_TEST_TIMEOUT } from '../../utils/utils.js'

const FTP_HOST = '172.15.0.7'
const FTP_PORT = 21
const FTP_USER = 'ftpuser'
const FTP_PASS = 'ftppass'
const FTP_BASE_URL = `ftp://${FTP_USER}:${FTP_PASS}@${FTP_HOST}:${FTP_PORT}`
const FTP_FILE_URL = `${FTP_BASE_URL}/readme.txt`
const FTP_UPLOAD_DIR = `${FTP_BASE_URL}`

describe('FTP Storage integration tests', function () {
  this.timeout(DEFAULT_TEST_TIMEOUT)

  let config: Awaited<ReturnType<typeof getConfiguration>>
  let error: Error

  before(async function () {
    config = await getConfiguration()
    const storage = new FTPStorage({ type: 'ftp', url: FTP_UPLOAD_DIR }, config)
    await storage.upload('readme.txt', Readable.from(['FTP test file content']))
  })

  it('returns FTPStorage from getStorageClass for type ftp', () => {
    const file = {
      type: 'ftp',
      url: 'ftp://example.com/path/to/file.txt'
    }
    const storage = Storage.getStorageClass(file, config)
    expect(storage).to.be.instanceOf(FTPStorage)
  })

  it('FTP validation passes for valid ftp URL', () => {
    const file = {
      type: 'ftp',
      url: 'ftp://user:pass@ftp.example.com:21/files/data.zip'
    }
    const storage = Storage.getStorageClass(file, config) as FTPStorage
    expect(storage.validate()).to.eql([true, ''])
  })

  it('FTP validation passes for valid ftps URL', () => {
    const file = {
      type: 'ftp',
      url: 'ftps://secure.example.com/pub/readme.txt'
    }
    const storage = Storage.getStorageClass(file, config) as FTPStorage
    expect(storage.validate()).to.eql([true, ''])
  })

  it('FTP validation fails when URL is missing', () => {
    const file = { type: 'ftp' }
    try {
      Storage.getStorageClass(file, config)
    } catch (err) {
      error = err
    }
    expect(error.message).to.include('FTP URL is missing')
  })

  it('FTP validation fails for non-ftp URL', () => {
    const file = {
      type: 'ftp',
      url: 'https://example.com/file.txt'
    }
    try {
      Storage.getStorageClass(file, config)
    } catch (err) {
      error = err
    }
    expect(error.message).to.include('URL must be ftp:// or ftps://')
  })

  it('getDownloadUrl returns the FTP URL', () => {
    const file = {
      type: 'ftp',
      url: 'ftp://host.example.com/dir/file.bin'
    }
    const storage = Storage.getStorageClass(file, config) as FTPStorage
    expect(storage.getDownloadUrl()).to.equal('ftp://host.example.com/dir/file.bin')
  })

  it('getReadableStream connects to vsftpd and returns stream', async function () {
    const file = { type: 'ftp', url: FTP_FILE_URL }
    const storage = Storage.getStorageClass(file, config) as FTPStorage
    const result = await storage.getReadableStream()
    expect(result).to.have.property('stream')
    expect(result.httpStatus).to.equal(200)
  })

  it('getFileInfo returns metadata from vsftpd', async function () {
    const file = { type: 'ftp', url: FTP_FILE_URL }
    const storage = Storage.getStorageClass(file, config) as FTPStorage
    const fileInfoRequest: FileInfoRequest = { type: FileObjectType.FTP }
    const fileInfo = await storage.getFileInfo(fileInfoRequest)
    expect(fileInfo).to.have.lengthOf(1)
    assert(fileInfo[0].valid, 'File info is valid')
    expect(fileInfo[0].type).to.equal('ftp')
    expect(fileInfo[0].contentType).to.equal('application/octet-stream')
  })

  it('upload sends file via FTP to vsftpd', async function () {
    const storage = new FTPStorage({ type: 'ftp', url: FTP_UPLOAD_DIR }, config)
    const filename = `ftp-upload-test-${Date.now()}.txt`
    const stream = Readable.from(['FTP upload test content'])
    const result = await storage.upload(filename, stream)
    expect(result).to.have.property('httpStatus')
    expect(result.httpStatus).to.equal(200)
  })
})
