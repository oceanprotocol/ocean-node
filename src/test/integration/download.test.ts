import { expect, assert } from 'chai'
import { JsonRpcProvider, Signer, ethers, sha256, toUtf8Bytes } from 'ethers'
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
import { DownloadHandler } from '../../components/core/downloadHandler.js'
import { StatusHandler } from '../../components/core/statusHandler.js'
import { GetDdoHandler } from '../../components/core/ddoHandler.js'

import { Readable } from 'stream'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { FileObjectType, UrlFileObject } from '../../@types/fileObject.js'

import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { FileInfoHandler } from '../../components/core/fileInfoHandler.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import { publishAsset, orderAsset } from '../utils/assets.js'
import { downloadAsset } from '../data/assets.js'
import { validateSignature } from '../../utils/auth.js'

describe('Should run a complete node flow.', async () => {
  let config: OceanNodeConfig
  let database: Database
  let oceanNode: OceanNode
  let provider: JsonRpcProvider
  let publisherAccount: Signer
  let consumerAccount: Signer
  let consumerAddress: string
  let resolvedDDO: Record<string, any>
  let orderTxId: string
  let assetDID: string
  let publishedDataset: any
  let actualDDO: any
  const publisherAddress = await publisherAccount.getAddress()

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  const serviceId = '0'

  let previousConfiguration: OverrideEnvConfig[]

  before(async () => {
    // override and save configuration (always before calling getConfig())
    previousConfiguration = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.DB_URL,
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS,
          ENVIRONMENT_VARIABLES.ALLOWED_ADMINS
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          'http://localhost:8108/?apiKey=xyz',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          JSON.stringify([publisherAddress, consumerAddress])
        ]
      )
    )

    config = await getConfiguration(true) // Force reload the configuration
    const dbconn = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(dbconn)
    //  eslint-disable-next-line no-unused-vars
    const indexer = new OceanIndexer(dbconn, mockSupportedNetworks)

    let network = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!network) {
      network = getOceanArtifactsAdresses().development
    }

    provider = new JsonRpcProvider('http://127.0.0.1:8545')

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
    assert(status.allowedAdmins)
  })

  it('signature should match', async () => {
    const currentDate = new Date()
    const expiryTimestamp = new Date(
      currentDate.getFullYear() + 1,
      currentDate.getMonth(),
      currentDate.getDate()
    ).getTime()

    const message = sha256(toUtf8Bytes(expiryTimestamp.toString()))

    // Sign the original message directly
    const signature = await (await provider.getSigner()).signMessage(message)

    assert(
      validateSignature(expiryTimestamp, signature) === true,
      'signatures do not match'
    )
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
    expect(fileInfo[0].contentLength).to.equal('417')
    expect(fileInfo[0].contentType).to.equal('text/plain; charset=utf-8')
    expect(fileInfo[0].name).to.equal('algo.js')
    expect(fileInfo[0].type).to.equal('url')
  })
  it('should publish compute datasets & algos', async () => {
    publishedDataset = await publishAsset(downloadAsset, publisherAccount)
    await waitToIndex(
      publishedDataset.ddo.id,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT
    )
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
      did: publishedDataset.ddo.id,
      serviceId: publishedDataset.ddo.services[0].id
    }

    const response = await new FileInfoHandler(oceanNode).handle(fileInfoTask)

    assert(response)
    assert(response.stream, 'stream not present')
    assert(response.status.httpStatus === 200, 'http status not 200')
    expect(response.stream).to.be.instanceOf(Readable)

    const fileInfo = await streamToObject(response.stream as Readable)

    assert(fileInfo[0].valid, 'File info is valid')
    expect(fileInfo[0].contentLength).to.equal('138486')
    expect(fileInfo[0].contentType).to.equal('text/plain; charset=utf-8')
    expect(fileInfo[0].name).to.equal('shs_dataset_test.txt')
    expect(fileInfo[0].type).to.equal('url')
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

  it('should download triger download file', function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const doCheck = async () => {
      const config = await getConfiguration(true)
      database = await new Database(config.dbConfig)
      const oceanNode = OceanNode.getInstance(database)
      assert(oceanNode, 'Failed to instantiate OceanNode')

      const wallet = new ethers.Wallet(
        '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
      )
      const nonce = Date.now().toString()
      const message = String(resolvedDDO.id + nonce)
      const consumerMessage = ethers.solidityPackedKeccak256(
        ['bytes'],
        [ethers.hexlify(ethers.toUtf8Bytes(message))]
      )
      const messageHashBytes = ethers.toBeArray(consumerMessage)
      const signature = await wallet.signMessage(messageHashBytes)

      const downloadTask = {
        fileIndex: 0,
        documentId: assetDID,
        serviceId,
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

    doCheck()
  })
  it('should not allow to download the asset with different consumer address', function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const doCheck = async () => {
      const downloadTask = {
        fileIndex: 0,
        documentId: assetDID,
        serviceId,
        transferTxId: orderTxId,
        nonce: Date.now().toString(),
        consumerAddress: '0xBE5449a6A97aD46c8558A3356267Ee5D2731ab57',
        signature: '',
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

    doCheck()
  })
  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})
