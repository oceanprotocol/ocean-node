import {
  Storage,
  UrlStorage,
  ArweaveStorage,
  IpfsStorage
} from '../../components/storage/index.js'
import { FileInfoRequest } from '../../@types/fileObject.js'
import { expect, assert } from 'chai'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  tearDownEnvironment,
  setupEnvironment
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'

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
    encryptMethod: 'AES'
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
      url: 'https://github.com/datablist/sample-csv-files/raw/main/files/organizations/organizations-100.csv',
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
      type: 'url'
    }
    const fileInfo = await storage.getFileInfo(fileInfoRequest)

    assert(fileInfo[0].valid, 'File info is valid')
    expect(fileInfo[0].contentLength).to.equal('13873')
    expect(fileInfo[0].contentType).to.equal('text/plain')
    expect(fileInfo[0].name).to.equal('organizations-100.csv')
    expect(fileInfo[0].type).to.equal('url')
  })

  it('Throws error when URL is missing in request', async () => {
    const fileInfoRequest: FileInfoRequest = { type: 'url' }
    try {
      await storage.getFileInfo(fileInfoRequest)
    } catch (err) {
      expect(err.message).to.equal('URL is required for type url')
    }
  })
})

describe('Arweave Storage getFileInfo tests', () => {
  let storage: ArweaveStorage

  before(() => {
    storage = new ArweaveStorage({
      type: 'arweave',
      transactionId: 'gPPDyusRh2ZyFl-sQ2ODK6hAwCRBAOwp0OFKr0n23QE'
    })
  })

  it('Successfully retrieves file info for an Arweave transaction', async () => {
    const fileInfoRequest: FileInfoRequest = {
      type: 'arweave'
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
    const fileInfoRequest: FileInfoRequest = { type: 'arweave' }
    try {
      await storage.getFileInfo(fileInfoRequest)
    } catch (err) {
      expect(err.message).to.equal('Transaction ID is required for type arweave')
    }
  })
})

describe('IPFS Storage getFileInfo tests', async function () {
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
      hash: 'QmRhsp7eghZtW4PktPC2wAHdKoy2LiF1n6UXMKmAhqQJUA'
    })
  })

  it('Successfully retrieves file info for an IPFS hash', async () => {
    const fileInfoRequest: FileInfoRequest = {
      type: 'ipfs'
    }
    const fileInfo = await storage.getFileInfo(fileInfoRequest)
    if (fileInfo && fileInfo.length > 0) {
      assert(fileInfo[0].valid, 'File info is valid')
      assert(fileInfo[0].type === 'ipfs', 'Type is incorrect')
      assert(fileInfo[0].contentType === 'text/csv', 'Content type is incorrect')
      assert(fileInfo[0].contentLength === '680782', 'Content length is incorrect')
    }
  })

  it('Throws error when hash is missing in request', async () => {
    const fileInfoRequest: FileInfoRequest = { type: 'ipfs' }
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
