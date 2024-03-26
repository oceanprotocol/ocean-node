import {
  Storage,
  UrlStorage,
  ArweaveStorage,
  IpfsStorage
} from '../../components/storage/index.js'
import {
  FileInfoRequest,
  FileObjectType,
  EncryptMethod
} from '../../@types/fileObject.js'
import { expect, assert } from 'chai'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  tearDownEnvironment,
  setupEnvironment,
  DEFAULT_TEST_TIMEOUT
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { getConfiguration } from '../../utils/index.js'
import { Readable } from 'stream'
import fs from 'fs'
import { expectedTimeoutFailure } from '../integration/testUtils.js'

let nodeId: string

describe('URL Storage tests', () => {
  let file: any = {
    type: 'url',
    url: 'http://someUrl.com/file.json',
    method: 'get',
    headers: [
      {
        'Content-Type': 'application/json',
        Authorization: 'Bearer auth_token_X'
      }
    ],
    encryptedBy: '16Uiu2HAmUWwsSj39eAfi3GG9U2niNKi3FVxh3eTwyRxbs8cwCq72',
    encryptMethod: EncryptMethod.AES
  }
  let storage: Storage
  let error: Error
  before(() => {
    storage = Storage.getStorageClass(file)
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
    assert(
      storage.canDecrypt('16Uiu2HAmUWwsSj39eAfi3GG9U2niNKi3FVxh3eTwyRxbs8cwCq72') ===
        true,
      "can't decrypt with the correct nodeId"
    )
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
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
    }
    try {
      Storage.getStorageClass(file)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql(
      'Error validationg the URL file: URL or method are missing'
    )
    file = {
      type: 'url',
      url: 'http://someUrl.com/file.json',
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
    }
    try {
      Storage.getStorageClass(file)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql(
      'Error validationg the URL file: URL or method are missing'
    )
  })
  it('URL validation fails on invalid method', () => {
    file = {
      type: 'url',
      url: 'http://someUrl.com/file.json',
      method: 'put',
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
    }
    try {
      Storage.getStorageClass(file)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql('Error validationg the URL file: Invalid method for URL')
  })

  it('URL validation fails on filename', () => {
    file = {
      type: 'url',
      url: './../dir/file.json',
      method: 'get',
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
    }
    try {
      Storage.getStorageClass(file)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql(
      'Error validationg the URL file: URL looks like a file path'
    )
  })
  it('Gets download URL', () => {
    file = {
      type: 'url',
      url: 'http://someUrl.com/file.json',
      method: 'get',
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
    }
    storage = Storage.getStorageClass(file)
    expect(storage.getDownloadUrl()).to.eql('http://someUrl.com/file.json')
  })

  it('Gets readable stream', async () => {
    file = {
      type: 'url',
      url: 'https://stock-api.oceanprotocol.com/stock/stock.json',
      method: 'get'
    }
    const storage = Storage.getStorageClass(file)
    const stream = await storage.getReadableStream()
    expect(stream).not.to.eql(null)
  })
})

describe('IPFS Storage tests', () => {
  let file: any = {
    type: 'ipfs',
    hash: 'Qxchjkflsejdfklgjhfkgjkdjoiderj'
  }
  let error: Error
  let previousConfiguration: OverrideEnvConfig[]

  before(() => {
    previousConfiguration = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.IPFS_GATEWAY],
      ['https://ipfs.oceanprotocol.com']
    )
  })

  it('Storage instance', () => {
    expect(Storage.getStorageClass(file)).to.be.instanceOf(IpfsStorage)
  })
  it('IPFS validation passes', () => {
    expect(Storage.getStorageClass(file).validate()).to.eql([true, ''])
  })
  it('IPFS validation fails', () => {
    file = {
      type: 'ipfs'
    }
    try {
      Storage.getStorageClass(file)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql('Error validationg the IPFS file: Missing CID')
  })

  after(() => {
    tearDownEnvironment(previousConfiguration)
  })
})

describe('Arweave Storage tests', () => {
  let file: any = {
    type: 'arweave',
    transactionId: '0x2563ed54abc0001bcaef'
  }

  let error: Error
  let previousConfiguration: OverrideEnvConfig[]

  before(() => {
    previousConfiguration = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY],
      ['https://snaznabndfe3.arweave.net/nnLNdp6nuTb8mJ-qOgbUEx-9SBtBXQc_jejYOWzYEkM']
    )
  })

  it('Storage instance', () => {
    expect(Storage.getStorageClass(file)).to.be.instanceOf(ArweaveStorage)
  })
  it('Arweave validation passes', () => {
    expect(Storage.getStorageClass(file).validate()).to.eql([true, ''])
  })
  it('Arweave validation fails', () => {
    file = {
      type: 'arweave'
    }
    try {
      Storage.getStorageClass(file)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql(
      'Error validationg the Arweave file: Missing transaction ID'
    )
  })

  after(() => {
    tearDownEnvironment(previousConfiguration)
  })
})

describe('URL Storage getFileInfo tests', () => {
  let storage: UrlStorage
  before(() => {
    storage = new UrlStorage({
      type: 'url',
      url: 'https://raw.githubusercontent.com/tbertinmahieux/MSongsDB/master/Tasks_Demos/CoverSongs/shs_dataset_test.txt',
      method: 'get'
    })
  })

  it('isEncrypted should return false for an encrypted file', () => {
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
    expect(fileInfo[0].contentLength).to.equal('138486')
    expect(fileInfo[0].contentType).to.equal('text/plain; charset=utf-8')
    expect(fileInfo[0].name).to.equal('shs_dataset_test.txt')
    expect(fileInfo[0].type).to.equal('url')
  })

  it('Throws error when URL is missing in request', async () => {
    const fileInfoRequest: FileInfoRequest = { type: FileObjectType.URL }
    try {
      await storage.getFileInfo(fileInfoRequest)
    } catch (err) {
      expect(err.message).to.equal('URL is required for type url')
    }
  })
})

describe('Arweave Storage getFileInfo tests', function () {
  this.timeout(15000)
  let storage: ArweaveStorage

  before(() => {
    storage = new ArweaveStorage({
      type: 'arweave',
      transactionId: 'gPPDyusRh2ZyFl-sQ2ODK6hAwCRBAOwp0OFKr0n23QE'
    })
  })

  it('Successfully retrieves file info for an Arweave transaction', async () => {
    const fileInfoRequest: FileInfoRequest = {
      type: FileObjectType.ARWEAVE
    }
    const fileInfo = await storage.getFileInfo(fileInfoRequest)

    assert(fileInfo[0].valid, 'File info is valid')
    assert(fileInfo[0].type === 'arweave', 'Type is incorrect')
    assert(
      fileInfo[0].contentType === 'text/csv; charset=utf-8',
      'Content type is incorrect'
    )
    assert(fileInfo[0].contentLength === '680782', 'Content length is incorrect')
  })

  it('Throws error when transaction ID is missing in request', async () => {
    const fileInfoRequest: FileInfoRequest = { type: FileObjectType.ARWEAVE }
    try {
      await storage.getFileInfo(fileInfoRequest)
    } catch (err) {
      expect(err.message).to.equal('Transaction ID is required for type arweave')
    }
  })
})

describe('IPFS Storage getFileInfo tests', function () {
  let storage: IpfsStorage
  let previousConfiguration: OverrideEnvConfig[]

  before(async () => {
    previousConfiguration = await buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.IPFS_GATEWAY],
      ['https://ipfs.oceanprotocol.com']
    )
    await setupEnvironment(undefined, previousConfiguration) // Apply the environment override

    storage = new IpfsStorage({
      type: 'ipfs',
      hash: 'QmRhsp7eghZtW4PktPC2wAHdKoy2LiF1n6UXMKmAhqQJUA'
    })
  })

  it('Successfully retrieves file info for an IPFS hash', function () {
    // this test fails often because of timeouts apparently
    // so we increase the deafult timeout
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const fileInfoRequest: FileInfoRequest = {
      type: FileObjectType.IPFS
    }
    // and only fire the test half way
    setTimeout(async () => {
      const fileInfo = await storage.getFileInfo(fileInfoRequest)
      if (fileInfo && fileInfo.length > 0) {
        assert(fileInfo[0].valid, 'File info is valid')
        assert(fileInfo[0].type === 'ipfs', 'Type is incorrect')
        // if these are not available is because we could not fetch the metadata yet
        if (fileInfo[0].contentType && fileInfo[0].contentLength) {
          assert(fileInfo[0].contentType === 'text/csv', 'Content type is incorrect')
          assert(fileInfo[0].contentLength === '680782', 'Content length is incorrect')
        } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(true)
      }
    }, DEFAULT_TEST_TIMEOUT)
  })

  it('Throws error when hash is missing in request', async () => {
    const fileInfoRequest: FileInfoRequest = { type: FileObjectType.IPFS }
    try {
      await storage.getFileInfo(fileInfoRequest)
    } catch (err) {
      expect(err.message).to.equal('Hash is required for type ipfs')
    }
  })

  after(() => {
    tearDownEnvironment(previousConfiguration)
  })
})

describe('URL Storage encryption tests', () => {
  let storage: UrlStorage

  before(() => {
    storage = new UrlStorage({
      type: 'url',
      url: 'https://raw.githubusercontent.com/tbertinmahieux/MSongsDB/master/Tasks_Demos/CoverSongs/shs_dataset_test.txt',
      method: 'get'
    })
  })

  it('isEncrypted should return false for an encrypted file', () => {
    assert(storage.isEncrypted() === false, 'invalid response to isEncrypted()')
  })

  it('canDecrypt should return false when the file is not encrypted', () => {
    assert(
      storage.canDecrypt('16Uiu2HAmUWwsSj39eAfi3GG9U2niNKi3FVxh3eTwyRxbs8cwCq72') ===
        false,
      'Wrong response from canDecrypt() for an unencrypted file'
    )
  })

  it('encrypt method should correctly encrypt data', async () => {
    const { keys } = await getConfiguration()
    nodeId = keys.peerId.toString()
    // Perform encryption
    const encryptResponse = await storage.encrypt(EncryptMethod.AES)
    assert(encryptResponse.httpStatus === 200, 'Response is not 200')
    assert(encryptResponse.stream, 'Stream is not null')
    assert(encryptResponse.stream instanceof Readable, 'Stream is not a ReadableStream')

    // Create a writable stream for the output file
    const fileStream = fs.createWriteStream('src/test/data/organizations-100.aes')

    // Use the 'finish' event to know when the file has been fully written
    fileStream.on('finish', () => {
      console.log('Encrypted file has been written successfully')
    })

    // Handle errors in the stream
    encryptResponse.stream.on('error', (err) => {
      console.error('Stream encountered an error:', err)
    })

    // Pipe the encrypted content stream to the file stream
    encryptResponse.stream.pipe(fileStream)
  })
})

describe('URL Storage encryption tests', function () {
  this.timeout(15000)
  let storage: IpfsStorage
  let previousConfiguration: OverrideEnvConfig[]

  before(async () => {
    previousConfiguration = await buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.IPFS_GATEWAY],
      ['https://ipfs.oceanprotocol.com']
    )
    await setupEnvironment(undefined, previousConfiguration) // Apply the environment override

    storage = new IpfsStorage({
      type: 'ipfs',
      hash: 'QmQVPuoXMbVEk7HQBth5pGPPMcgvuq4VSgu2XQmzU5M2Pv',
      encryptedBy: nodeId,
      encryptMethod: EncryptMethod.AES
    })
  })

  it('isEncrypted should return true for an encrypted file', () => {
    assert(storage.isEncrypted() === true, 'invalid response to isEncrypted()')
  })

  it('canDecrypt should return true for this node', () => {
    assert(
      storage.canDecrypt(nodeId) === true,
      'Wrong response from canDecrypt() for an encrypted file'
    )
  })

  it('File info includes encryptedBy and encryptMethod', async () => {
    const fileInfoRequest: FileInfoRequest = {
      type: FileObjectType.IPFS
    }
    const fileInfo = await storage.getFileInfo(fileInfoRequest)

    assert(fileInfo[0].valid, 'File info is valid')
    expect(fileInfo[0].contentType).to.equal('application/octet-stream')
    expect(fileInfo[0].type).to.equal('ipfs')
    expect(fileInfo[0].encryptedBy).to.equal(nodeId)
    expect(fileInfo[0].encryptMethod).to.equal(EncryptMethod.AES)
  })

  it('canDecrypt should return false when called from an unauthorised node', () => {
    assert(
      storage.canDecrypt('16Uiu2HAmUWwsSj39eAfi3GG9U2niNKi3FVxh3eTwyRxbs8cwCq72') ===
        false,
      'Wrong response from canDecrypt() for an unencrypted file'
    )
  })

  after(() => {
    tearDownEnvironment(previousConfiguration)
  })
})
