/**
 * ArweaveStorage integration tests.
 * Moved from unit/storage.test.ts.
 */

import { Storage, ArweaveStorage } from '../../../components/storage/index.js'
import { FileInfoRequest, FileObjectType } from '../../../@types/fileObject.js'
import { expect, assert } from 'chai'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  tearDownEnvironment,
  DEFAULT_TEST_TIMEOUT
} from '../../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../../utils/constants.js'
import { getConfiguration } from '../../../utils/index.js'

describe('Arweave Storage integration tests', function () {
  this.timeout(DEFAULT_TEST_TIMEOUT)

  let file: any = {
    type: 'arweave',
    transactionId: '0x2563ed54abc0001bcaef'
  }
  let error: Error
  let previousConfiguration: OverrideEnvConfig[]
  let config: Awaited<ReturnType<typeof getConfiguration>>

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

describe('Arweave Storage getFileInfo integration tests', function () {
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
    console.log(fileInfo)

    assert(fileInfo[0].valid, 'File info is valid')
    assert(fileInfo[0].type === FileObjectType.ARWEAVE, 'Type is incorrect')
    assert(
      fileInfo[0].contentType === 'text/csv; charset=utf-8' ||
        fileInfo[0].contentType === 'text/csv',
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

describe('Arweave Storage with malformed transaction ID integration tests', () => {
  let error: Error
  let config: Awaited<ReturnType<typeof getConfiguration>>

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
