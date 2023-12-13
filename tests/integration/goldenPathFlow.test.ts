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
import { getEventFromTx } from '../../utils/util.js'
import { delay, signMessage, waitToIndex } from './testUtils.js'
import { genericDDO } from '../data/ddo.js'
import { getConfig } from '../../utils/index.js'
import { validateOrderTransaction } from '../../components/core/validateTransaction.js'
import { decrypt, encrypt } from '../../utils/crypt.js'
import { Readable } from 'stream'

// TODO: remove this once we have it in the codebase
export async function streamToString(stream: Readable) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString()
}

describe('Indexer stores a new published DDO', () => {
  const chainId = 8996

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

  const mockSupportedNetworks: RPCS = {
    '8996': {
      chainId: 8996,
      network: 'development',
      rpc: 'http://127.0.0.1:8545',
      chunkSize: 100
    }
  }

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    const config = await getConfig()
    console.log('config ', config)
    database = await new Database(dbConfig)
    oceanNode = await new OceanNode(config)
    console.log(' node ', oceanNode)

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

    assetDID = genericAsset.id

    const fileData = Uint8Array.from(
      Buffer.from(JSON.stringify(genericAsset.services[0].files))
    )
    const encryptedData = (await encrypt(fileData, 'ECIES')).toString('hex')
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

  it('should be able to decrypt the ddo files ', async () => {
    const encryptedFilesHex = resolvedDDO.services[0].files
    const encryptedFilesBytes = Uint8Array.from(Buffer.from(encryptedFilesHex, 'hex'))
    const decryptedUrlBytes = await decrypt(encryptedFilesBytes, 'ECIES')
    const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
    const decryptedFileObject = JSON.parse(decryptedFilesString)
    expect(decryptedFileObject[0].url).to.equal(
      'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js'
    )
  })

  it('should start an order and validate the transaction', async function () {
    this.timeout(15000) // Extend default Mocha test timeout
    const feeToken = '0x312213d6f6b5FCF9F56B7B8946A6C727Bf4Bc21f'
    const providerFeeAddress = ZeroAddress
    const providerFeeToken = feeToken
    const serviceIndex = 0
    const providerFeeAmount = 0
    const consumeMarketFeeAddress = ZeroAddress
    const consumeMarketFeeAmount = 0
    const consumeMarketFeeToken = feeToken
    const providerValidUntil = 0
    const timeout = 0

    dataTokenContract = new Contract(
      datatokenAddress,
      ERC20Template.abi,
      publisherAccount
    )

    // sign provider data
    const providerData = JSON.stringify({ timeout })
    const message = solidityPackedKeccak256(
      ['bytes', 'address', 'address', 'uint256', 'uint256'],
      [
        hexlify(toUtf8Bytes(providerData)),
        providerFeeAddress,
        providerFeeToken,
        providerFeeAmount,
        providerValidUntil
      ]
    )
    const signedMessage = await signMessage(message, publisherAddress, provider)

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
        providerFeeAddress,
        providerFeeToken,
        providerFeeAmount,
        v: signedMessage.v,
        r: signedMessage.r,
        s: signedMessage.s,
        providerData: hexlify(toUtf8Bytes(providerData)),
        validUntil: providerValidUntil
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

    // Use the transaction receipt in validateOrderTransaction

    const validationResult = await validateOrderTransaction(
      orderTxId,
      consumerAddress,
      provider,
      dataNftAddress,
      datatokenAddress,
      serviceIndex,
      timeout
    )
    assert(validationResult.isValid, 'Transaction is not valid.')
    assert(
      validationResult.message === 'Transaction is valid.',
      'Invalid transaction validation message.'
    )
  })
})
