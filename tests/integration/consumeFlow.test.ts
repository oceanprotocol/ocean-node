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
  Interface
} from 'ethers'
import { createHash } from 'crypto'
import fs from 'fs'
import { homedir } from 'os'
import { validateOrderTransaction } from '../../src/components/core/validateTransaction'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { getEventFromTx, sleep } from '../../src/utils/util.js'
import { genericAsset, signMessage } from '../testUtils.js'
import { Database } from '../../src/components/database/index.js'

describe('validateOrderTransaction Function with Real Transactions', () => {
  let database: Database
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let nftContract: Contract
  let dataTokenContract: Contract
  let nftAddress: string
  const chainId = 8996
  let assetDID: string
  let publisherAccount: Signer
  let publisherAddress: string
  let consumerAccount: Signer
  let consumerAddress: string
  let dataNftAddress: string
  let feeAddress: string
  let datatokenAddress: string
  let fixedDDO
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
  const providerFeeAmount = 0
  const feeToken = '0x312213d6f6b5FCF9F56B7B8946A6C727Bf4Bc21f'

  before(async () => {
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
    feeAddress = await publisherAccount.getAddress()
    publisherAddress = await publisherAccount.getAddress()
    consumerAddress = await consumerAccount.getAddress()

    const data = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.readFileSync(
        process.env.ADDRESS_FILE ||
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`,
        'utf8'
      )
    )

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

  it('should publish a dataset', async () => {
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
          ZERO_ADDRESS,
          ZERO_ADDRESS,
          '0x0000000000000000000000000000000000000000'
        ],
        uints: [1000, 0],
        bytess: []
      }
    )
    const txReceipt = await tx.wait()
    assert(txReceipt, 'transaction failed')
    const nftEvent = getEventFromTx(txReceipt, 'NFTCreated')
    const erc20Event = getEventFromTx(txReceipt, 'TokenCreated')
    console.log('erc20Event', erc20Event)
    dataNftAddress = nftEvent.args[0]
    datatokenAddress = erc20Event.args[0]
    console.log('nftAddress ', dataNftAddress)
    console.log('datatokenAddress ', datatokenAddress)
    assert(dataNftAddress, 'find nft created failed')
    assert(datatokenAddress, 'find datatoken created failed')
  })

  it('should set metadata and save', async () => {
    console.log('1. should set metadata and save')
    nftContract = new Contract(dataNftAddress, ERC721Template.abi, publisherAccount)
    console.log('2. should set metadata and save')
    genericAsset.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(dataNftAddress) + chainId.toString(10))
        .digest('hex')
    genericAsset.nftAddress = dataNftAddress
    console.log('3. should set metadata and save')

    assetDID = genericAsset.id
    console.log('assetDID', assetDID)
    const stringDDO = JSON.stringify(genericAsset)
    const bytes = Buffer.from(stringDDO)
    const metadata = hexlify(bytes)
    console.log('metadata ', metadata)
    const hash = createHash('sha256').update(metadata).digest('hex')
    console.log('hash ', hash)

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

  it('should simulate a transaction and validate it', async function () {
    this.timeout(5000) // Extend default Mocha test timeout
    dataTokenContract = new Contract(
      datatokenAddress,
      ERC20Template.abi,
      publisherAccount
    )
    const providerFeeAddress = publisherAddress
    const providerFeeToken = feeToken
    const serviceIndex = 1 // dummy index
    const providerFeeAmount = 0 // fee to be collected on top, requires approval
    const consumeMarketFeeAddress = publisherAddress // marketplace fee Collector
    const consumeMarketFeeAmount = 0 // fee to be collected on top, requires approval
    const consumeMarketFeeToken = feeToken // token address for the feeAmount,
    const providerValidUntil = 0
    // sign provider data
    const providerData = JSON.stringify({ timeout: 0 })
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
    // call the mint function on the dataTokenContract

    let consumerBalance = await dataTokenContract.balanceOf(consumerAddress)
    console.log('consumer datatoken Balance', consumerBalance)
    const mintTx = await dataTokenContract.mint(
      consumerAddress,
      parseUnits('10000000000000000000000000000', 18)
    )
    const txReceipt = await mintTx.wait()
    consumerBalance = await dataTokenContract.balanceOf(consumerAddress)
    console.log('consumer datatoken Balance', consumerBalance)
    const signedMessage = await signMessage(message, publisherAddress)

    try {
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
      const txId = orderTxReceipt.transactionHash
      console.log('txId', txId)
    } catch (error) {
      console.log('error', error)
    }
  })

  // Additional tests and logic as needed
})

// const txReceipt = await mintTx.wait()

// console.log('txReceipt', txReceipt)
// // Simulate a transaction
// // expect(txReceipt).to.exist
// // Use the transaction receipt in validateOrderTransaction
//
//
// const result = await validateOrderTransaction(
//   txId,
//   userAddress,
//   provider,
//   dataNftAddress,
//   datatokenAddress
// )
// expect(result.isValid).to.be.true
// expect(result.message).to.equal('Transaction is valid.')
