import { expect, assert, config, should } from 'chai'
import { createHash } from 'crypto'
import {
  JsonRpcProvider,
  Signer,
  Contract,
  ethers,
  getAddress,
  hexlify,
  ZeroAddress,
  solidityPackedKeccak256,
  toUtf8Bytes,
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
import { OceanP2P } from '../../components/P2P/index.js'
import { RPCS } from '../../@types/blockchain.js'
import { getEventFromTx, streamToString } from '../../utils/util.js'
import { delay, signMessage, waitToIndex } from './testUtils.js'
import { genericDDO } from '../data/ddo.js'
import { PROTOCOL_COMMANDS, getConfig } from '../../utils/index.js'
import { validateOrderTransaction } from '../../components/core/validateTransaction.js'
import { decrypt, encrypt } from '../../utils/crypt.js'
import { DownloadHandler } from '../../components/core/downloadHandler.js'
import { StatusHandler } from '../../components/core/statusHandler.js'

import { Readable } from 'stream'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { createFee } from '../../components/core/utils/feesHandler.js'
import { DDO } from '../../@types/DDO/DDO.js'

describe('Should run a complete node flow.', () => {
  let config: OceanNodeConfig
  let database: Database
  let oceanNode: OceanNode
  let p2pNode: OceanP2P
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
  const mockSupportedNetworks: RPCS = {
    '8996': {
      chainId: 8996,
      network: 'development',
      rpc: 'http://127.0.0.1:8545',
      chunkSize: 100
    }
  }
  const serviceId = '0'

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    config = await getConfig()
    database = await new Database(dbConfig)
    p2pNode = new OceanP2P(database, config)
    oceanNode = await new OceanNode(config, database)

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
    process.env.PRIVATE_KEY =
      '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58'
    process.env.RPCS = JSON.stringify(mockSupportedNetworks)
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
    const oceanNodeConfig = oceanNode.getConfig()

    const statusCommand = {
      command: PROTOCOL_COMMANDS.STATUS,
      node: oceanNodeConfig.keys.peerId.toString()
    }
    const response = await new StatusHandler(p2pNode).handle(statusCommand)
    console.log('resp: ', response)
    assert(response.status.httpStatus === 200, 'http status not 200')
    const resp = await streamToString(response.stream as Readable)
    const status = JSON.parse(resp)
    assert(status.id === oceanNodeConfig.keys.peerId.toString(), 'peer id not matching ')
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
  })

  it('should encrypt files, set metadata and save ', async () => {
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

    const stringDDO = JSON.stringify(genericAsset)
    const bytes = Buffer.from(stringDDO)
    const metadata = hexlify(bytes)
    const hash = createHash('sha256').update(metadata).digest('hex')

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x02',
      metadata,
      '0x' + hash,
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

  it('should start an order', async function () {
    this.timeout(15000) // Extend default Mocha test timeout
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
  })

  it('should download triger download file', async function () {
    this.timeout(65000)

    const config = await getConfig()
    config.supportedNetworks[8996] = {
      chainId: 8996,
      network: 'development',
      rpc: 'http://127.0.0.1:8545',
      chunkSize: 100
    }
    database = await new Database(config.dbConfig)
    const p2pNode = new OceanP2P(database, config)
    assert(p2pNode, 'Failed to instantiate OceanP2P')

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
      signature
    }
    const response = await new DownloadHandler(p2pNode).handle(downloadTask)
    console.log('resp: ', response)

    assert(response)
    assert(response.stream, 'stream not present')
    assert(response.status.httpStatus === 200, 'http status not 200')
    expect(response.stream).to.be.instanceOf(Readable)
  })
})
