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
  toUtf8Bytes,
  solidityPackedKeccak256,
  parseUnits
} from 'ethers'
import fs from 'fs'
import { homedir } from 'os'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { Database } from '../../src/components/database/index.js'
import { OceanIndexer } from '../../src/components/Indexer/index.js'
import { RPCS } from '../../src/@types/blockchain.js'
import { getEventFromTx } from '../../src/utils/util.js'
import { delay, waitToIndex, signMessage } from './testUtils.js'
import { genericDDO } from '../data/ddo.js'

describe('Indexer stores a new published DDO', () => {
  let database: Database
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let nftContract: Contract
  let datatokenContract: Contract
  let publisherAccount: Signer
  let consumerAccount: Signer
  let nftAddress: string
  let datatokenAddress: string
  const chainId = 8996
  let assetDID: string
  let resolvedDDO: Record<string, any>
  let genericAsset: any
  const timeout = 0
  const feeToken = '0x312213d6f6b5FCF9F56B7B8946A6C727Bf4Bc21f'
  const providerFeeAddress = ZeroAddress // publisherAddress
  const providerFeeToken = feeToken
  const serviceIndex = 0 // dummy index
  const providerFeeAmount = 0 // fee to be collected on top, requires approval
  const consumeMarketFeeAddress = ZeroAddress // marketplace fee Collector
  const consumeMarketFeeAmount = 0 // fee to be collected on top, requires approval
  const consumeMarketFeeToken = feeToken // token address for the feeAmount,
  const providerValidUntil = 0

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
    database = await new Database(dbConfig)
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
    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
    genericAsset = genericDDO
    factoryContract = new ethers.Contract(
      data.development.ERC721Factory,
      ERC721Factory.abi,
      publisherAccount
    )
  })

  it('instance Database', async () => {
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
          ZeroAddress,
          ZeroAddress,
          '0x0000000000000000000000000000000000000000'
        ],
        uints: [1000, 0],
        bytess: []
      }
    )
    const txReceipt = await tx.wait()
    assert(txReceipt, 'transaction failed')
    const event = getEventFromTx(txReceipt, 'NFTCreated')
    nftAddress = event.args[0]
    console.log('NFT created event args: ', event.args)
    assert(nftAddress, 'find nft created failed')
    console.log('nftAddress for OrderStarted test: ', nftAddress)
    const datatokenEvent = getEventFromTx(txReceipt, 'TokenCreated')
    console.log('Token created event args: ', datatokenEvent.args)
    datatokenAddress = datatokenEvent.args[0]
    assert(datatokenAddress, 'find datatoken created failed')
    console.log('datatokenAddress for OrderStarted test: ', datatokenAddress)
  })

  it('should set metadata and save ', async () => {
    nftContract = new ethers.Contract(nftAddress, ERC721Template.abi, publisherAccount)
    genericAsset.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(nftAddress) + chainId.toString(10))
        .digest('hex')
    genericAsset.nftAddress = nftAddress

    assetDID = genericAsset.id
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

  it('should update ddo metadata fields ', async () => {
    resolvedDDO.metadata.name = 'dataset-name-updated'
    resolvedDDO.metadata.description =
      'Updated description for the Ocean protocol test dataset'
    const stringDDO = JSON.stringify(resolvedDDO)
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

  it('should detect update event and store the udpdated ddo in the database', async () => {
    const updatedDDO = await waitToIndex(assetDID, database)
    expect(updatedDDO.metadata.name).to.equal('dataset-name-updated')
    expect(updatedDDO.metadata.description).to.equal(
      'Updated description for the Ocean protocol test dataset'
    )
  })

  it('should change metadata state of the published DDO', async () => {
    const setMetaDataStateTx = await nftContract.setMetaDataState(4)
    const trxReceipt = await setMetaDataStateTx.wait()
    assert(trxReceipt, 'set metada state failed')
  })

  delay(50000)

  it('should get the updated state', async () => {
    const result = await nftContract.getMetaData()
    const retrievedDDO = await waitToIndex(assetDID, database)
    console.log('retrievedDDO', retrievedDDO)
    expect(retrievedDDO.nft).to.not.equal(undefined)
    expect(retrievedDDO).to.have.nested.property('nft.state')
    // Expect the result from contract
    expect(retrievedDDO.nft.state).to.equal(parseInt(result[2].toString()))
  })

  it('should get OrderStarted event', async function () {
    this.timeout(15000) // Extend default Mocha test timeout
    const publisherAddress = await publisherAccount.getAddress()
    const consumerAddress = await consumerAccount.getAddress()
    const dataTokenContract = new Contract(
      datatokenAddress,
      ERC20Template.abi,
      publisherAccount
    )
    // const paymentCollector = await dataTokenContract.getPaymentCollector()
    // assert(paymentCollector === publisherAddress, 'paymentCollector not correct')

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
    console.log('solidityPackedKeccak256 message: ', message)
    const signedMessage = await signMessage(message, publisherAddress, provider)
    console.log('signedMessage: ', signedMessage)

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
    console.log('orderTx: ', orderTx)

    const orderTxReceipt = await orderTx.wait()
    assert(orderTxReceipt, 'order transaction failed')
    const orderTxId = orderTxReceipt.hash
    assert(orderTxId, 'transaction id not found')

    const event = getEventFromTx(orderTxReceipt, 'OrderStarted')
    expect(event.args[1]).to.equal(publisherAddress) // payer
    expect(event.args[3]).to.equal(serviceIndex) // serviceIndex
  })
})
