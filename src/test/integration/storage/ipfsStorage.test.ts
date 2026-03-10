/**
 * IpfsStorage integration tests.
 * Moved from unit/storage.test.ts.
 */

import { Storage, IpfsStorage } from '../../../components/storage/index.js'
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
import { expectedTimeoutFailure } from '../testUtils.js'

const nodeId = '16Uiu2HAmUWwsSj39eAfi3GG9U2niNKi3FVxh3eTwyRxbs8cwCq72'
const nodeId2 = '16Uiu2HAmQWwsSj39eAfi3GG9U2niNKi3FVxh3eTwyRxbs8cwCq73'

describe('IPFS Storage integration tests', function () {
  this.timeout(DEFAULT_TEST_TIMEOUT)

  let file: any = {
    type: 'ipfs',
    hash: 'Qxchjkflsejdfklgjhfkgjkdjoiderj'
  }
  let error: Error
  let previousConfiguration: OverrideEnvConfig[]
  let config: Awaited<ReturnType<typeof getConfiguration>>

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

describe('IPFS Storage with malformed hash integration tests', () => {
  let error: Error
  let config: Awaited<ReturnType<typeof getConfiguration>>

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

describe('IPFS Storage getFileInfo integration tests', function () {
  let storage: IpfsStorage
  let previousConfiguration: OverrideEnvConfig[]
  let config: Awaited<ReturnType<typeof getConfiguration>>

  before(async () => {
    previousConfiguration = await buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.IPFS_GATEWAY],
      ['https://ipfs.oceanprotocol.com']
    )
    await setupEnvironment(undefined, previousConfiguration)
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
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const fileInfoRequest: FileInfoRequest = {
      type: FileObjectType.IPFS
    }
    setTimeout(async () => {
      const fileInfo = await storage.getFileInfo(fileInfoRequest)
      if (fileInfo && fileInfo.length > 0) {
        assert(fileInfo[0].valid, 'File info is valid')
        assert(fileInfo[0].type === 'ipfs', 'Type is incorrect')
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

describe('IPFS Storage encryption integration tests', function () {
  this.timeout(15000)

  let storage: IpfsStorage
  let previousConfiguration: OverrideEnvConfig[]

  before(async () => {
    previousConfiguration = await buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.IPFS_GATEWAY],
      ['https://ipfs.oceanprotocol.com']
    )
    await setupEnvironment(undefined, previousConfiguration)
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
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const fileInfoRequest: FileInfoRequest = {
      type: FileObjectType.IPFS
    }
    setTimeout(async () => {
      const fileInfo = await storage.getFileInfo(fileInfoRequest)
      if (fileInfo && fileInfo.length > 0) {
        assert(fileInfo[0].valid, 'File info is valid')
        expect(fileInfo[0].type).to.equal('ipfs')
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
      storage.canDecrypt(nodeId) === true,
      'Wrong response from canDecrypt() for an unencrypted file'
    )
    assert(
      storage.canDecrypt(nodeId2) === false,
      'Wrong response from canDecrypt() for an unencrypted file'
    )
  })

  after(() => {
    tearDownEnvironment(previousConfiguration)
  })
})
