import { expect, assert } from 'chai'
import {
  JsonRpcProvider,
  Signer,
  Contract,
  ethers,
  getAddress,
  hexlify,
  toUtf8Bytes,
  solidityPackedKeccak256,
  parseUnits,
  ZeroAddress
} from 'ethers'
import { createHash } from 'crypto'
import fs from 'fs'
import { homedir } from 'os'
import { validateOrderTransaction } from '../../components/core/validateTransaction.js'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { getEventFromTx } from '../../utils/util.js'
import { delay, signMessage, waitToIndex } from './testUtils.js'
import { genericDDO } from '../data/ddo.js'
import { Database } from '../../components/database/index.js'
import { getOceanArtifactsAdresses } from '../../utils/address.js'
import { createFee } from '../../components/core/utils/feesHandler.js'
import { DDO } from '../../@types/DDO/DDO.js'

describe('validateOrderTransaction Function with Orders', () => {
  let database: Database
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let nftContract: Contract
  let dataTokenContract: Contract
  const chainId = 8996
  let publisherAccount: Signer
  let publisherAddress: string
  let consumerAccount: Signer
  let consumerAddress: string
  let dataNftAddress: string
  let datatokenAddress: string
  let message: string
  let providerData: string
  let orderTxId: string
  let dataTokenContractWithNewSigner: any
  let signedMessage: {
    v: string
    r: string
    s: string
  }
  let resolvedDDO: any

  const feeToken = '0x312213d6f6b5FCF9F56B7B8946A6C727Bf4Bc21f'
  const providerFeeAddress = ZeroAddress // publisherAddress
  const providerFeeToken = feeToken
  const serviceId = '0' // dummy index
  const providerFeeAmount = 0 // fee to be collected on top, requires approval
  const consumeMarketFeeAddress = ZeroAddress // marketplace fee Collector
  const consumeMarketFeeAmount = 0 // fee to be collected on top, requires approval
  const consumeMarketFeeToken = feeToken // token address for the feeAmount,
  const providerValidUntil = 0
  const timeout = 0

  before(async () => {
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
    publisherAddress = await publisherAccount.getAddress()
    consumerAddress = await consumerAccount.getAddress()

    console.log('publisher address', publisherAddress)

    const data = getOceanArtifactsAdresses()

    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)

    // Initialize the factory contract
    factoryContract = new ethers.Contract(
      data.development.ERC721Factory,
      ERC721Factory.abi,
      publisherAccount
    )
  })

  it('Start instance of Database', async () => {
    expect(database).to.be.instanceOf(Database)
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

  it('should set metadata and save', async function () {
    this.timeout(15000) // Extend default Mocha test timeout
    nftContract = new Contract(dataNftAddress, ERC721Template.abi, publisherAccount)
    genericDDO.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(dataNftAddress) + chainId.toString(10))
        .digest('hex')
    genericDDO.nftAddress = dataNftAddress

    const stringDDO = JSON.stringify(genericDDO)
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
    assert(trxReceipt, 'set metadata failed')
  })

  delay(30000)

  it('should get the active state', async () => {
    resolvedDDO = await waitToIndex(genericDDO.id, database)
  })

  it('should start an order and validate the transaction', async function () {
    this.timeout(15000) // Extend default Mocha test timeout
    dataTokenContract = new Contract(
      datatokenAddress,
      ERC20Template.abi,
      publisherAccount
    )
    const paymentCollector = await dataTokenContract.getPaymentCollector()
    assert(paymentCollector === publisherAddress, 'paymentCollector not correct')

    const feeData = await createFee(
      resolvedDDO as DDO,
      0,
      'null',
      resolvedDDO.services[0]
    )

    // sign provider data
    providerData = JSON.stringify({ timeout })
    message = solidityPackedKeccak256(
      ['bytes', 'address', 'address', 'uint256', 'uint256'],
      [
        hexlify(toUtf8Bytes(providerData)),
        feeData.providerFeeAddress,
        feeData.providerFeeToken,
        feeData.providerFeeAmount,
        feeData.validUntil
      ]
    )
    signedMessage = await signMessage(message, publisherAddress, provider)

    // call the mint function on the dataTokenContract
    const mintTx = await dataTokenContract.mint(consumerAddress, parseUnits('1000', 18))
    await mintTx.wait()
    const consumerBalance = await dataTokenContract.balanceOf(consumerAddress)
    assert(consumerBalance === parseUnits('1000', 18), 'consumer balance not correct')

    dataTokenContractWithNewSigner = dataTokenContract.connect(consumerAccount) as any

    const orderTx = await dataTokenContractWithNewSigner.startOrder(
      consumerAddress,
      serviceId,
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

    // Use the transaction receipt in validateOrderTransaction

    const validationResult = await validateOrderTransaction(
      orderTxId,
      consumerAddress,
      provider,
      dataNftAddress,
      datatokenAddress,
      parseInt(serviceId),
      timeout
    )
    assert(validationResult.isValid, 'Transaction is not valid.')
    assert(
      validationResult.message === 'Transaction is valid.',
      'Invalid transaction validation message.'
    )
  })

  it('should reuse an order and validate the transaction', async function () {
    this.timeout(15000) // Extend default Mocha test timeout

    const feeData = await createFee(
      resolvedDDO as DDO,
      0,
      'null',
      resolvedDDO.services[0]
    )

    // sign provider data
    providerData = JSON.stringify({ timeout })
    message = solidityPackedKeccak256(
      ['bytes', 'address', 'address', 'uint256', 'uint256'],
      [
        hexlify(toUtf8Bytes(providerData)),
        feeData.providerFeeAddress,
        feeData.providerFeeToken,
        feeData.providerFeeAmount,
        feeData.validUntil
      ]
    )
    signedMessage = await signMessage(message, publisherAddress, provider)

    const orderTx = await dataTokenContractWithNewSigner.reuseOrder(
      orderTxId,
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
    const txId = orderTxReceipt.hash
    assert(txId, 'transaction id not found')

    // Use the transaction receipt in validateOrderTransaction

    const validationResult = await validateOrderTransaction(
      txId,
      consumerAddress,
      provider,
      dataNftAddress,
      datatokenAddress,
      parseInt(serviceId),
      timeout
    )

    assert(validationResult.isValid, 'Reuse order transaction is not valid.')
    assert(
      validationResult.message === 'Transaction is valid.',
      'Invalid reuse order transaction validation message.'
    )
  })

  it('should reject reuse an order with invald serviceId', async function () {
    this.timeout(15000) // Extend default Mocha test timeout

    const feeData = await createFee(
      resolvedDDO as DDO,
      0,
      'null',
      resolvedDDO.services[0]
    )

    const orderTx = await dataTokenContractWithNewSigner.reuseOrder(
      orderTxId,
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
    const txId = orderTxReceipt.hash
    assert(txId, 'transaction id not found')

    // Use the transaction receipt in validateOrderTransaction

    const validationResult = await validateOrderTransaction(
      txId,
      consumerAddress,
      provider,
      dataNftAddress,
      datatokenAddress,
      parseInt('999'),
      timeout
    )

    assert(!validationResult.isValid, 'Reuse order transaction should not be valid.')
    assert(
      validationResult.message === 'Invalid service index.',
      'Invalid reuse order transaction validation message.'
    )
  })

  it('should reject reuse an order with invald user address', async function () {
    this.timeout(15000) // Extend default Mocha test timeout

    const feeData = await createFee(
      resolvedDDO as DDO,
      0,
      'null',
      resolvedDDO.services[0]
    )

    const orderTx = await dataTokenContractWithNewSigner.reuseOrder(
      orderTxId,
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
    const txId = orderTxReceipt.hash
    assert(txId, 'transaction id not found')

    // Use the transaction receipt in validateOrderTransaction

    const validationResult = await validateOrderTransaction(
      txId,
      '0x0',
      provider,
      dataNftAddress,
      datatokenAddress,
      parseInt(serviceId),
      timeout
    )

    assert(!validationResult.isValid, 'Reuse order transaction should not be valid.')
    assert(
      validationResult.message ===
        'User address does not match the sender of the transaction.',
      'Wrong transaction rejection message'
    )
  })
})
