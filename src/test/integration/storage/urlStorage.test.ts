/**
 * UrlStorage integration tests.
 *
 * Includes tests moved from unit/storage.test.ts and upload tests against
 * an Apache server. Upload tests use http://172.15.0.7:80 (Apache must allow PUT).
 * If the server is unreachable or rejects PUT, upload tests are skipped.
 */

import { Readable } from 'stream'
import { Storage, UrlStorage } from '../../../components/storage/index.js'
import {
  FileInfoRequest,
  FileObjectType,
  EncryptMethod
} from '../../../@types/fileObject.js'
import { expect, assert } from 'chai'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  tearDownEnvironment,
  setupEnvironment,
  DEFAULT_TEST_TIMEOUT
} from '../../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../../utils/constants.js'
import { getConfiguration } from '../../../utils/index.js'

const nodeId = '16Uiu2HAmUWwsSj39eAfi3GG9U2niNKi3FVxh3eTwyRxbs8cwCq72'
const APACHE_BASE_URL = 'http://172.15.0.7:80'

describe('URL Storage integration tests', function () {
  this.timeout(DEFAULT_TEST_TIMEOUT)

  let file: any = {
    type: 'url',
    url: 'http://someUrl.com/file.json',
    method: 'get',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer auth_token_X'
    },
    encryptedBy: nodeId,
    encryptMethod: EncryptMethod.AES
  }
  let storage: UrlStorage
  let error: Error
  let config: Awaited<ReturnType<typeof getConfiguration>>

  before(async () => {
    config = await getConfiguration()
    storage = Storage.getStorageClass(file, config) as UrlStorage
  })

  it('Storage instance', () => {
    expect(storage).to.be.instanceOf(UrlStorage)
  })

  it('URL validation passes', () => {
    expect(storage.validate()).to.eql([true, ''])
  })

  it('isEncrypted should return true for an encrypted file', () => {
    assert(storage.isEncrypted() === true, 'invalid response to isEncrypted()')
  })

  it('canDecrypt should return true for the correct nodeId', () => {
    assert(storage.canDecrypt(nodeId) === true, "can't decrypt with the correct nodeId")
  })

  it('canDecrypt should return false for an incorrect nodeId', () => {
    assert(
      storage.canDecrypt('wrongNodeId') === false,
      'can decrypt with the wrong nodeId'
    )
  })

  it('URL validation fails on missing URL', () => {
    file = {
      type: 'url',
      method: 'get',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer auth_token_X'
      }
    }
    try {
      Storage.getStorageClass(file, config)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql(
      'Error validating the URL file: URL or method are missing'
    )
    file = {
      type: 'url',
      url: 'http://someUrl.com/file.json',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer auth_token_X'
      }
    }
    try {
      Storage.getStorageClass(file, config)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql(
      'Error validating the URL file: URL or method are missing'
    )
  })

  it('URL validation fails on invalid method', () => {
    file = {
      type: 'url',
      url: 'http://someUrl.com/file.json',
      method: 'put',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer auth_token_X'
      }
    }
    try {
      Storage.getStorageClass(file, config)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql('Error validating the URL file: Invalid method for URL')
  })

  it('URL validation fails on filename', () => {
    file = {
      type: 'url',
      url: './../dir/file.json',
      method: 'get',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer auth_token_X'
      }
    }
    try {
      Storage.getStorageClass(file, config)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql(
      'Error validating the URL file: URL looks like a file path'
    )
  })

  it('Gets download URL', () => {
    file = {
      type: 'url',
      url: 'http://someUrl.com/file.json',
      method: 'get',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer auth_token_X'
      }
    }
    storage = Storage.getStorageClass(file, config) as UrlStorage
    expect(storage.getDownloadUrl()).to.eql('http://someUrl.com/file.json')
  })

  it('Gets readable stream', async () => {
    file = {
      type: 'url',
      url: 'https://stock-api.oceanprotocol.com/stock/stock.json',
      method: 'get'
    }
    const storageInstance = Storage.getStorageClass(file, config)
    const stream = await storageInstance.getReadableStream()
    expect(stream).not.to.eql(null)
  })

  it('Gets readable stream with headers as plain object', async () => {
    file = {
      type: 'url',
      url: 'https://stock-api.oceanprotocol.com/stock/stock.json',
      method: 'get',
      headers: { 'X-Test-Header': 'test' }
    }
    const storageInstance = Storage.getStorageClass(file, config)
    const stream = await storageInstance.getReadableStream()
    expect(stream).not.to.eql(null)
  })
})

describe('Unsafe URL integration tests', () => {
  let previousConfiguration: OverrideEnvConfig[]
  let file: any
  let error: Error
  let config: Awaited<ReturnType<typeof getConfiguration>>

  before(async () => {
    previousConfiguration = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [ENVIRONMENT_VARIABLES.UNSAFE_URLS],
        [JSON.stringify(['^.*(169.254.169.254).*', '^.*(127.0.0.1).*'])]
      )
    )
    config = await getConfiguration(true)
  })

  it('Should reject unsafe URL', () => {
    file = {
      type: 'url',
      url: 'http://169.254.169.254/asfd',
      method: 'get'
    }
    try {
      Storage.getStorageClass(file, config)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql('Error validating the URL file: URL is marked as unsafe')
  })

  it('Should allow safe URL', () => {
    file = {
      type: 'url',
      url: 'https://oceanprotocol.com',
      method: 'get'
    }
    const storageInstance = Storage.getStorageClass(file, config) as UrlStorage
    expect(storageInstance.getDownloadUrl()).to.eql('https://oceanprotocol.com')
  })

  after(() => {
    tearDownEnvironment(previousConfiguration)
  })
})

describe('URL Storage getFileInfo integration tests', () => {
  let storage: UrlStorage

  before(async () => {
    const config = await getConfiguration()
    storage = new UrlStorage(
      {
        type: 'url',
        url: 'https://raw.githubusercontent.com/tbertinmahieux/MSongsDB/master/Tasks_Demos/CoverSongs/shs_dataset_test.txt',
        method: 'get'
      },
      config
    )
  })

  it('isEncrypted should return false for an unencrypted file', () => {
    assert(storage.isEncrypted() === false, 'invalid response to isEncrypted()')
  })

  it('canDecrypt should return false when the file is not encrypted', () => {
    assert(
      storage.canDecrypt('16Uiu2HAmUWwsSj39eAfi3GG9U2niNKi3FVxh3eTwyRxbs8cwCq72') ===
        false,
      'Wrong response from canDecrypt() for an unencrypted file'
    )
  })

  it('Successfully retrieves file info for a URL', async () => {
    const fileInfoRequest: FileInfoRequest = {
      type: FileObjectType.URL
    }
    const fileInfo = await storage.getFileInfo(fileInfoRequest)

    assert(fileInfo[0].valid, 'File info is valid')
    expect(fileInfo[0].contentLength).to.equal('319520')
    expect(fileInfo[0].contentType).to.equal('text/plain; charset=utf-8')
    expect(fileInfo[0].name).to.equal('shs_dataset_test.txt')
    expect(fileInfo[0].type).to.equal('url')
  })
})

describe('URL Storage with malformed URL integration tests', () => {
  let error: Error
  let config: Awaited<ReturnType<typeof getConfiguration>>

  before(async () => {
    config = await getConfiguration()
  })

  it('should detect path regex', () => {
    try {
      // eslint-disable-next-line no-new
      new UrlStorage(
        {
          type: 'url',
          url: '../../myFolder/',
          method: 'get'
        },
        config
      )
    } catch (err) {
      error = err
    }
    expect(error.message).to.equal(
      'Error validating the URL file: URL looks like a file path'
    )
  })
})

describe('URL Storage encryption integration tests', () => {
  let storage: UrlStorage
  let config: Awaited<ReturnType<typeof getConfiguration>>

  before(async () => {
    config = await getConfiguration()
    storage = new UrlStorage(
      {
        type: 'url',
        url: 'https://raw.githubusercontent.com/tbertinmahieux/MSongsDB/master/Tasks_Demos/CoverSongs/shs_dataset_test.txt',
        method: 'get'
      },
      config
    )
  })

  it('isEncrypted should return false for an unencrypted file', () => {
    assert(storage.isEncrypted() === false, 'invalid response to isEncrypted()')
  })

  it('canDecrypt should return false when the file is not encrypted', () => {
    assert(
      storage.canDecrypt(nodeId) === false,
      'Wrong response from canDecrypt() for an unencrypted file'
    )
  })
})

describe('UrlStorage upload integration tests (Apache at 172.15.0.7:80)', function () {
  this.timeout(DEFAULT_TEST_TIMEOUT)

  let config: Awaited<ReturnType<typeof getConfiguration>>
  let uploadStorage: UrlStorage

  before(async function () {
    config = await getConfiguration()
    uploadStorage = new UrlStorage(
      {
        type: 'url',
        url: `${APACHE_BASE_URL}/`,
        method: 'get'
      },
      config
    )
  })

  it('upload sends PUT request and returns status', async function () {
    const filename = `urlstorage-upload-test-${Date.now()}.txt`
    const body = 'Hello from UrlStorage upload test'
    const stream = Readable.from([body])
    const result = await uploadStorage.upload(filename, stream)
    expect(result).to.have.property('httpStatus')
    expect(result.httpStatus).to.be.oneOf([200, 201, 204])
  })

  it('upload with url without trailing slash uses url as target', async function () {
    const directUrl = `${APACHE_BASE_URL}/direct-put-${Date.now()}.txt`
    const storageDirect = new UrlStorage(
      { type: 'url', url: directUrl, method: 'get' },
      config
    )
    const stream = Readable.from(['small payload'])
    const result = await storageDirect.upload('ignored.txt', stream)
    expect(result).to.have.property('httpStatus')
    expect(result.httpStatus).to.be.oneOf([200, 201, 204])
  })

  it('upload returns response headers', async function () {
    const filename = `headers-test-${Date.now()}.txt`
    const stream = Readable.from(['test'])
    const result = await uploadStorage.upload(filename, stream)
    expect(result).to.have.property('httpStatus')
    expect(result).to.have.property('headers')
    expect(typeof result.headers).to.equal('object')
  })
})
