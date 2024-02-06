import { expect, assert } from 'chai'
import { createHash } from 'crypto'
import {
  JsonRpcProvider,
  Signer,
  Contract,
  ethers,
  getAddress,
  hexlify,
  ZeroAddress,
  parseUnits
} from 'ethers'
import fs from 'fs'
import { homedir } from 'os'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { OceanNode } from '../../OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'
import { getEventFromTx, streamToString, streamToObject } from '../../utils/util.js'
import { delay, waitToIndex } from './testUtils.js'
import { genericDDO } from '../data/ddo.js'
import {
  ENVIRONMENT_VARIABLES,
  PROTOCOL_COMMANDS,
  getConfiguration
} from '../../utils/index.js'
import { encrypt } from '../../utils/crypt.js'
import { DownloadHandler } from '../../components/core/downloadHandler.js'
import { StatusHandler } from '../../components/core/statusHandler.js'

import { Readable } from 'stream'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { UrlFileObject } from '../../@types/fileObject.js'
import { createFee } from '../../components/core/utils/feesHandler.js'
import { DDO } from '../../@types/DDO/DDO.js'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { FileInfoHandler } from '../../components/core/fileInfoHandler.js'

describe('Should run a complete node flow.', () => {
  let config: OceanNodeConfig
  let database: Database
  let oceanNode: OceanNode
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let dataTokenContract: Contract
  let nftContract: Contract
  let publisherAccount: Signer
  let consumerAccount: Signer
  let consumerAddress: string
  let publisherAddress: string
  let dataNftAddress: string
  let datatokenAddress: string
  let resolvedDDO: Record<string, any>
  let orderTxId: string
  let assetDID: string
  let genericAsset: any

  const chainId = 8996
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
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          'http://localhost:8108/?apiKey=xyz',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260'])
        ]
      )
    )
    config = await getConfiguration(true)
    database = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(database)

    indexer = new OceanIndexer(database, mockSupportedNetworks)

    const data = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.readFileSync(
        process.env.ADDRESS_FILE ||
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`,
        'utf8'
      )
    )

    provider = new JsonRpcProvider('http://127.0.0.1:8545')

    publisherAccount = (await provider.getSigner(0)) as Signer
    publisherAddress = await publisherAccount.getAddress()
    consumerAccount = (await provider.getSigner(1)) as Signer
    consumerAddress = await consumerAccount.getAddress()

    genericAsset = genericDDO
    factoryContract = new ethers.Contract(
      data.development.ERC721Factory,
      ERC721Factory.abi,
      publisherAccount
    )
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
      type: 'url' as 'url'
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

  it('should publish a dataset', async function () {
    this.timeout(15000) // Extend default Mocha test timeout
    const tx = await factoryContract.createNftWithErc20(
      {
        name: '72120Bundle',
        symbol: '72Bundle',
        templateIndex: 1,
        tokenURI: 'https://oceanprotocol.com/nft/',
        transferable: true,
        owner: await publisherAccount.getAddress()
      },
      {
        strings: ['ERC20B1', 'ERC20DT1Symbol'],
        templateIndex: 1,
        addresses: [
          await publisherAccount.getAddress(),
          ZeroAddress,
          ZeroAddress,
          ZeroAddress
        ],
        uints: [1000, 0],
        bytess: []
      }
    )
    const txReceipt = await tx.wait()
    assert(txReceipt, 'transaction failed')
    const nftEvent = getEventFromTx(txReceipt, 'NFTCreated')
    const erc20Event = getEventFromTx(txReceipt, 'TokenCreated')

    dataNftAddress = nftEvent.args[0]
    datatokenAddress = erc20Event.args[0]

    assert(dataNftAddress, 'find nft created failed')
    assert(datatokenAddress, 'find datatoken created failed')
    // for testing purpose
    genericAsset.event = {
      tx: txReceipt.transactionHash,
      block: parseInt(txReceipt.blockNumber),
      from: txReceipt.from,
      contract: txReceipt.contractAddress,
      datetime: '2023-02-15T16:42:22'
    }
    genericAsset.nft = {
      address: dataNftAddress,
      owner: txReceipt.from,
      state: 0,
      created: '2022-12-30T08:40:43'
    }
  })

  it('should encrypt files, encrypt DDO, set metadata and save ', async () => {
    nftContract = new ethers.Contract(
      dataNftAddress,
      ERC721Template.abi,
      publisherAccount
    )
    genericAsset.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(dataNftAddress) + chainId.toString(10))
        .digest('hex')
    genericAsset.nftAddress = dataNftAddress
    genericAsset.services[0].datatokenAddress = datatokenAddress

    assetDID = genericAsset.id

    const files = {
      datatokenAddress: '0x0',
      nftAddress: '0x0',
      files: [
        {
          type: 'url',
          url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
          method: 'GET'
        }
      ]
    }
    const data = Uint8Array.from(Buffer.from(JSON.stringify(files)))
    const encryptedData = await encrypt(data, 'ECIES')

    genericAsset.services[0].files = encryptedData

    const metadata = hexlify(Buffer.from(JSON.stringify(genericAsset)))
    const documentHash = '0x' + createHash('sha256').update(metadata).digest('hex')

    const genericAssetData = Uint8Array.from(Buffer.from(JSON.stringify(genericAsset)))
    const encryptedDDO = await encrypt(genericAssetData, 'ECIES')
    const encryptedMetaData = hexlify(encryptedDDO)

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      '16Uiu2HAmN211yBiE6dF5xu8GFXV1jqZQzK5MbzBuQDspfa6qNgXF',
      '0x123',
      '0x02',
      encryptedMetaData,
      documentHash,
      []
    )
    const trxReceipt = await setMetaDataTx.wait()
    assert(trxReceipt, 'set metada failed')
  })

  delay(50000)

  it('should store the ddo in the database and return it ', async () => {
    resolvedDDO = await waitToIndex(assetDID, database)
    expect(resolvedDDO.id).to.equal(genericAsset.id)
  })

  // it('should be able to decrypt the ddo files ', async () => {
  //   const encryptedFilesHex = resolvedDDO.services[0].files
  //   const encryptedFilesBytes = Uint8Array.from(Buffer.from(encryptedFilesHex, 'hex'))
  //   const decryptedUrlBytes = await decrypt(encryptedFilesBytes, 'ECIES')
  //   const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
  //   const decryptedFileObject = JSON.parse(decryptedFilesString)
  //   expect(decryptedFileObject[0].url).to.equal(
  //     'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js'
  //   )
  // })

  it('should get file info with did', async () => {
    const fileInfoTask = {
      command: PROTOCOL_COMMANDS.FILE_INFO,
      did: assetDID,
      serviceId
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

  it('should start an order', async function () {
    this.timeout(15000) // Extend default Mocha test timeout
    try {
      const feeToken = '0x312213d6f6b5FCF9F56B7B8946A6C727Bf4Bc21f'
      const serviceIndex = '0'
      const consumeMarketFeeAddress = ZeroAddress
      const consumeMarketFeeAmount = 0
      const consumeMarketFeeToken = feeToken

      dataTokenContract = new Contract(
        datatokenAddress,
        ERC20Template.abi,
        publisherAccount
      )

      const feeData = await createFee(
        resolvedDDO as DDO,
        0,
        'null',
        resolvedDDO.services[0]
      )

      // call the mint function on the dataTokenContract
      const mintTx = await dataTokenContract.mint(consumerAddress, parseUnits('1000', 18))
      await mintTx.wait()
      const consumerBalance = await dataTokenContract.balanceOf(consumerAddress)
      assert(consumerBalance === parseUnits('1000', 18), 'consumer balance not correct')

      const dataTokenContractWithNewSigner = dataTokenContract.connect(
        consumerAccount
      ) as any

      const orderTx = await dataTokenContractWithNewSigner.startOrder(
        consumerAddress,
        serviceIndex,
        {
          providerFeeAddress: feeData.providerFeeAddress,
          providerFeeToken: feeData.providerFeeToken,
          providerFeeAmount: feeData.providerFeeAmount,
          v: feeData.v,
          r: feeData.r,
          s: feeData.s,
          providerData: feeData.providerData,
          validUntil: feeData.validUntil
        },
        {
          consumeMarketFeeAddress,
          consumeMarketFeeToken,
          consumeMarketFeeAmount
        }
      )
      const orderTxReceipt = await orderTx.wait()
      assert(orderTxReceipt, 'order transaction failed')
      orderTxId = orderTxReceipt.hash
      assert(orderTxId, 'transaction id not found')
    } catch (error) {
      console.log(error)
    }
  })

  it('should download triger download file', async function () {
    this.timeout(65000)

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
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})
