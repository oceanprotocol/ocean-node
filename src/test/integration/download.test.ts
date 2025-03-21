import { expect, assert } from 'chai'
import { JsonRpcProvider, Signer, ethers } from 'ethers'
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { OceanNode } from '../../OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'
import { streamToString, streamToObject } from '../../utils/util.js'
import { expectedTimeoutFailure, waitToIndex } from './testUtils.js'

import {
  ENVIRONMENT_VARIABLES,
  EVENTS,
  PROTOCOL_COMMANDS,
  getConfiguration
} from '../../utils/index.js'
import { DownloadHandler } from '../../components/core/handler/downloadHandler.js'
import {
  DetailedStatusHandler,
  StatusHandler
} from '../../components/core/handler/statusHandler.js'
import { GetDdoHandler } from '../../components/core/handler/ddoHandler.js'

import { Readable } from 'stream'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { FileObjectType, UrlFileObject } from '../../@types/fileObject.js'

import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { FileInfoHandler } from '../../components/core/handler/fileInfoHandler.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import { publishAsset, orderAsset } from '../utils/assets.js'
import { downloadAsset } from '../data/assets.js'
import { genericDDO } from '../data/ddo.js'
import { homedir } from 'os'

describe('Should run a complete node flow.', () => {
  let config: OceanNodeConfig
  let database: Database
  let oceanNode: OceanNode
  let provider: JsonRpcProvider
  let publisherAccount: Signer
  let consumerAccount: Signer
  let consumerAddress: string
  let orderTxId: string
  let publishedDataset: any
  let actualDDO: any
  let indexer: OceanIndexer
  let anotherConsumer: ethers.Wallet

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  const serviceId = '0'

  let previousConfiguration: OverrideEnvConfig[]

  before(async () => {
    // override and save configuration (always before calling getConfig())
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.INDEXER_NETWORKS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS,
          ENVIRONMENT_VARIABLES.ALLOWED_ADMINS,
          ENVIRONMENT_VARIABLES.ADDRESS_FILE
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          JSON.stringify([8996]),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    config = await getConfiguration(true) // Force reload the configuration
    database = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(database)
    indexer = new OceanIndexer(database, config.indexingNetworks)
    oceanNode.addIndexer(indexer)

    let network = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!network) {
      network = getOceanArtifactsAdresses().development
    }

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    anotherConsumer = new ethers.Wallet(
      ENVIRONMENT_VARIABLES.NODE2_PRIVATE_KEY.value,
      provider
    )

    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
    consumerAddress = await consumerAccount.getAddress()
  })

  it('should get node status', async () => {
    const oceanNodeConfig = await getConfiguration(true)

    const statusCommand = {
      command: PROTOCOL_COMMANDS.STATUS,
      node: oceanNodeConfig.keys.peerId.toString()
    }
    const response = await new StatusHandler(oceanNode).handle(statusCommand)
    assert(response.status.httpStatus === 200, 'http status not 200')
    const resp = await streamToString(response.stream as Readable)
    const status = JSON.parse(resp)
    assert(status.id === oceanNodeConfig.keys.peerId.toString(), 'peer id not matching ')
    // test allowedAdmins
    assert(status.allowedAdmins.length === 1, 'incorrect length')
    assert(
      status.allowedAdmins[0]?.toLowerCase() ===
        '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260'?.toLowerCase(),
      'incorrect allowed admin publisherAddress'
    )
    assert(status.c2dClusters === undefined, 'clusters info should be undefined')
    assert(status.supportedSchemas === undefined, 'schemas info should be undefined')
  })

  it('should get node detailed status', async () => {
    const oceanNodeConfig = await getConfiguration(true)

    const statusCommand = {
      command: PROTOCOL_COMMANDS.DETAILED_STATUS,
      node: oceanNodeConfig.keys.peerId.toString()
    }
    const response = await new DetailedStatusHandler(oceanNode).handle(statusCommand)
    assert(response.status.httpStatus === 200, 'http status not 200')
    const resp = await streamToString(response.stream as Readable)
    const status = JSON.parse(resp)
    assert(status.c2dClusters !== undefined, 'clusters info should not be undefined')
    assert(status.supportedSchemas !== undefined, 'schemas info should not be undefined')
  })

  it('should get file info before publishing', async () => {
    const storage: UrlFileObject = {
      type: 'url',
      url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
      method: 'get'
    }
    const fileInfoTask = {
      command: PROTOCOL_COMMANDS.FILE_INFO,
      file: storage,
      type: FileObjectType.URL
    }
    const response = await new FileInfoHandler(oceanNode).handle(fileInfoTask)

    assert(response)
    assert(response.stream, 'stream not present')
    assert(response.status.httpStatus === 200, 'http status not 200')
    expect(response.stream).to.be.instanceOf(Readable)

    const fileInfo = await streamToObject(response.stream as Readable)

    assert(fileInfo[0].valid, 'File info is valid')
    expect(fileInfo[0].type).to.equal('url')

    if (fileInfo[0].contentLength && fileInfo[0].contentType) {
      expect(fileInfo[0].contentLength).to.equal('946')
      expect(fileInfo[0].contentType).to.equal('text/plain; charset=utf-8')
      expect(fileInfo[0].name).to.equal('algo.js')
    }
  })
  it('should publish compute datasets & algos', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    publishedDataset = await publishAsset(downloadAsset, publisherAccount)
    const { ddo, wasTimeout } = await waitToIndex(
      publishedDataset.ddo.id,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT * 2
    )

    if (!ddo) {
      assert(wasTimeout === true, 'published failed due to timeout!')
    }
  })

  it('should fetch the published ddo', async () => {
    const getDDOTask = {
      command: PROTOCOL_COMMANDS.GET_DDO,
      id: publishedDataset.ddo.id
    }
    const response = await new GetDdoHandler(oceanNode).handle(getDDOTask)
    actualDDO = await streamToObject(response.stream as Readable)
    assert(actualDDO.id === publishedDataset.ddo.id, 'DDO id not matching')
  })
  it('should get file info with did', async () => {
    const fileInfoTask = {
      command: PROTOCOL_COMMANDS.FILE_INFO,
      did: actualDDO.id,
      serviceId: actualDDO.services[0].id
    }

    const response = await new FileInfoHandler(oceanNode).handle(fileInfoTask)

    assert(response)
    assert(response.stream, 'stream not present')
    assert(response.status.httpStatus === 200, 'http status not 200')
    expect(response.stream).to.be.instanceOf(Readable)

    const fileInfo = await streamToObject(response.stream as Readable)

    assert(fileInfo[0].valid, 'File info is valid')
    expect(fileInfo[0].type).to.equal('url')
    if (fileInfo[0].contentLength && fileInfo[0].contentType) {
      expect(fileInfo[0].contentLength).to.equal('319520')
      expect(fileInfo[0].contentType).to.equal('text/plain; charset=utf-8')
      expect(fileInfo[0].name).to.equal('shs_dataset_test.txt')
    }
  })

  it('should start an order', async function () {
    const orderTxReceipt = await orderAsset(
      actualDDO,
      0,
      consumerAccount,
      await consumerAccount.getAddress(),
      publisherAccount,
      oceanNode
    )
    assert(orderTxReceipt, 'order transaction failed')
    orderTxId = orderTxReceipt.hash
    assert(orderTxId, 'transaction id not found')
  })

  it('should download triger download file', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const doCheck = async () => {
      const wallet = new ethers.Wallet(
        '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
      )
      const nonce = Date.now().toString()
      const message = String(publishedDataset.ddo.id + nonce)
      const consumerMessage = ethers.solidityPackedKeccak256(
        ['bytes'],
        [ethers.hexlify(ethers.toUtf8Bytes(message))]
      )
      const messageHashBytes = ethers.toBeArray(consumerMessage)
      const signature = await wallet.signMessage(messageHashBytes)
      const downloadTask = {
        fileIndex: 0,
        documentId: publishedDataset.ddo.id,
        serviceId: publishedDataset.ddo.services[0].id,
        transferTxId: orderTxId,
        nonce,
        consumerAddress,
        signature,
        command: PROTOCOL_COMMANDS.DOWNLOAD
      }
      const response = await new DownloadHandler(oceanNode).handle(downloadTask)
      assert(response)
      assert(response.stream, 'stream not present')
      assert(response.status.httpStatus === 200, 'http status not 200')
      expect(response.stream).to.be.instanceOf(Readable)
    }

    setTimeout(() => {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(true)
    }, DEFAULT_TEST_TIMEOUT * 3)

    await doCheck()
  })

  // for use on the test bellow
  it('should publish ddo with access credentials', async function () {
    publishedDataset = await publishAsset(genericDDO, publisherAccount)
    const { ddo, wasTimeout } = await waitToIndex(
      publishedDataset.ddo.id,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT
    )

    if (!ddo) {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    }
  })
  it('should not allow to download the asset with different consumer address', async function () {
    const assetDID = publishedDataset.ddo.id
    const doCheck = async () => {
      const downloadTask = {
        fileIndex: 0,
        documentId: assetDID,
        serviceId,
        transferTxId: orderTxId,
        nonce: Date.now().toString(),
        consumerAddress: await anotherConsumer.getAddress(),
        signature: '0xBE5449a6',
        command: PROTOCOL_COMMANDS.DOWNLOAD
      }
      const response = await new DownloadHandler(oceanNode).handle(downloadTask)

      assert(response.stream === null, 'stream not null')
      assert(response.status.httpStatus === 403, 'http status not 403')
      assert(
        response.status.error === `Error: Access to asset ${assetDID} was denied`,
        'error contains access denied'
      )
    }

    await doCheck()
  })
  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    indexer.stopAllThreads()
  })
})
