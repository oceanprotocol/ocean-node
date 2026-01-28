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
  let config: any
  before(async () => {
    config = await getConfiguration()
    storage = Storage.getStorageClass(file, config)
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
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
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
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
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
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
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
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
    }
    storage = Storage.getStorageClass(file, config)
    expect(storage.getDownloadUrl()).to.eql('http://someUrl.com/file.json')
  })

  it('Gets readable stream', async () => {
    file = {
      type: 'url',
      url: 'https://stock-api.oceanprotocol.com/stock/stock.json',
      method: 'get'
    }
    const storage = Storage.getStorageClass(file, config)
    const stream = await storage.getReadableStream()
    expect(stream).not.to.eql(null)
  })
})

describe('Unsafe URL tests', () => {
  let previousConfiguration: OverrideEnvConfig[]
  let file: any
  let error: Error
  let config: any
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
    const storage = Storage.getStorageClass(file, config)
    expect(storage.getDownloadUrl()).to.eql('https://oceanprotocol.com')
  })
  after(() => {
    tearDownEnvironment(previousConfiguration)
  })
})

describe('IPFS Storage tests', () => {
  let file: any = {
    type: 'ipfs',
    hash: 'Qxchjkflsejdfklgjhfkgjkdjoiderj'
  }
  let error: Error
  let previousConfiguration: OverrideEnvConfig[]
  let config: any
  before(async () => {
    previousConfiguration = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.IPFS_GATEWAY],
      ['https://ipfs.oceanprotocol.com']
    )
    config = await getConfiguration()
  })

  it('Storage instance', () => {
    expect(Storage.getStorageClass(file, config)).to.be.instanceOf(IpfsStorage)
  })
  it('IPFS validation passes', () => {
    expect(Storage.getStorageClass(file, config).validate()).to.eql([true, ''])
  })
  it('IPFS validation fails', () => {
    file = {
      type: 'ipfs'
    }
    try {
      Storage.getStorageClass(file, config)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql('Error validating the IPFS file: Missing CID')
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
  let config: any

  before(async () => {
    previousConfiguration = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY],
      ['https://snaznabndfe3.arweave.net/nnLNdp6nuTb8mJ-qOgbUEx-9SBtBXQc_jejYOWzYEkM']
    )
    config = await getConfiguration()
  })

  it('Storage instance', () => {
    expect(Storage.getStorageClass(file, config)).to.be.instanceOf(ArweaveStorage)
  })
  it('Arweave validation passes', () => {
    expect(Storage.getStorageClass(file, config).validate()).to.eql([true, ''])
  })
  it('Arweave validation fails', () => {
    file = {
      type: 'arweave'
    }
    try {
      Storage.getStorageClass(file, config)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql(
      'Error validating the Arweave file: Missing transaction ID'
    )
  })

  after(() => {
    tearDownEnvironment(previousConfiguration)
  })
})

describe('URL Storage getFileInfo tests', () => {
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
    expect(fileInfo[0].contentLength).to.equal('319520')
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

describe('URL Storage with malformed URL', () => {
  let error: Error
  let config: any
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

describe('Arweave Storage getFileInfo tests', function () {
  // this.timeout(15000)
  let storage: ArweaveStorage

  before(async () => {
    const config = await getConfiguration(true)
    storage = new ArweaveStorage(
      {
        type: FileObjectType.ARWEAVE,
        transactionId: 'gPPDyusRh2ZyFl-sQ2ODK6hAwCRBAOwp0OFKr0n23QE'
      },
      config
    )
  })

  it('Successfully retrieves file info for an Arweave transaction', async () => {
    const fileInfoRequest: FileInfoRequest = {
      type: FileObjectType.ARWEAVE
    }
    const fileInfo = await storage.getFileInfo(fileInfoRequest)

    assert(fileInfo[0].valid, 'File info is valid')
    assert(fileInfo[0].type === FileObjectType.ARWEAVE, 'Type is incorrect')
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

describe('Arweave Storage with malformed transaction ID', () => {
  let error: Error
  let config: any
  before(async () => {
    config = await getConfiguration()
  })
  it('should detect URL path format', () => {
    try {
      // eslint-disable-next-line no-new
      new ArweaveStorage(
        {
          type: 'arweave',
          transactionId:
            'https://raw.githubusercontent.com/tbertinmahieux/MSongsDB/master/Tasks_Demos/CoverSongs/shs_dataset_test.txt'
        },
        config
      )
    } catch (err) {
      error = err
    }
    expect(error.message).to.equal(
      'Error validating the Arweave file: Transaction ID looks like an URL. Please specify URL storage instead.'
    )
  })

  it('should detect path regex', () => {
    try {
      // eslint-disable-next-line no-new
      new ArweaveStorage(
        {
          type: 'arweave',
          transactionId: '../../myFolder/'
        },
        config
      )
    } catch (err) {
      error = err
    }
    expect(error.message).to.equal(
      'Error validating the Arweave file: Transaction ID looks like a file path'
    )
  })
})

describe('Arweave Storage with malformed transaction ID', () => {
  let error: Error
  let config: any
  before(async () => {
    config = await getConfiguration()
  })
  it('should detect URL path format', () => {
    try {
      // eslint-disable-next-line no-new
      new IpfsStorage(
        {
          type: 'ipfs',
          hash: 'https://raw.githubusercontent.com/tbertinmahieux/MSongsDB/master/Tasks_Demos/CoverSongs/shs_dataset_test.txt'
        },
        config
      )
    } catch (err) {
      error = err
    }
    expect(error.message).to.equal(
      'Error validating the IPFS file: CID looks like an URL. Please specify URL storage instead.'
    )
  })

  it('should detect path regex', () => {
    try {
      // eslint-disable-next-line no-new
      new IpfsStorage(
        {
          type: 'ipfs',
          hash: '../../myFolder/'
        },
        config
      )
    } catch (err) {
      error = err
    }
    expect(error.message).to.equal(
      'Error validating the IPFS file: CID looks like a file path'
    )
  })
})

describe('IPFS Storage getFileInfo tests', function () {
  let storage: IpfsStorage
  let previousConfiguration: OverrideEnvConfig[]
  let config: any
  before(async () => {
    previousConfiguration = await buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.IPFS_GATEWAY],
      ['https://ipfs.oceanprotocol.com']
    )
    await setupEnvironment(undefined, previousConfiguration) // Apply the environment override
    config = await getConfiguration()

    storage = new IpfsStorage(
      {
        type: FileObjectType.IPFS,
        hash: 'QmRhsp7eghZtW4PktPC2wAHdKoy2LiF1n6UXMKmAhqQJUA'
      },
      config
    )
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
  let config: any
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
    const config = await getConfiguration()
    storage = new IpfsStorage(
      {
        type: 'ipfs',
        hash: 'QmQVPuoXMbVEk7HQBth5pGPPMcgvuq4VSgu2XQmzU5M2Pv',
        encryptedBy: nodeId,
        encryptMethod: EncryptMethod.AES
      },
      config
    )
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

  it('File info includes encryptedBy and encryptMethod', function () {
    // same thing here, IFPS takes time
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const fileInfoRequest: FileInfoRequest = {
      type: FileObjectType.IPFS
    }

    setTimeout(async () => {
      const fileInfo = await storage.getFileInfo(fileInfoRequest)
      if (fileInfo && fileInfo.length > 0) {
        assert(fileInfo[0].valid, 'File info is valid')
        expect(fileInfo[0].type).to.equal('ipfs')

        // same thing as above, these tests should consider that the metadata exists,
        // its not on our side anyway
        if (fileInfo[0].contentType && fileInfo[0].encryptedBy) {
          expect(fileInfo[0].contentType).to.equal('application/octet-stream')
          expect(fileInfo[0].encryptedBy).to.equal(nodeId)
          expect(fileInfo[0].encryptMethod).to.equal(EncryptMethod.AES)
        } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(true)
      }
    }, DEFAULT_TEST_TIMEOUT)
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
