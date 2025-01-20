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
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import Dispenser from '@oceanprotocol/contracts/artifacts/contracts/pools/dispenser/Dispenser.sol/Dispenser.json' assert { type: 'json' }
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { RPCS } from '../../@types/blockchain.js'
import { getEventFromTx, getEventFromTxByHash } from '../../utils/util.js'
import { waitToIndex, expectedTimeoutFailure } from './testUtils.js'
import { genericDDO } from '../data/ddo.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES, EVENTS } from '../../utils/constants.js'
import { homedir } from 'os'
import { OceanNode } from '../../OceanNode.js'
import { getConfiguration } from '../../utils/config.js'
import { encrypt } from '../../utils/crypt.js'
import { EncryptMethod } from '../../@types/fileObject.js'

describe('Publish pricing scehmas and assert ddo stats - FRE & Dispenser', () => {
  let database: Database
  let oceanNode: OceanNode
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let nftContract: Contract
  let datatokenContract: Contract
  let publisherAccount: Signer
  let nftAddress: string
  let datatokenAddress: string
  const chainId = 8996
  let assetDID: string
  let resolvedDDO: Record<string, any> = {}
  let genericAsset: any
  let setMetaDataTxReceipt: any
  let indexer: OceanIndexer
  let artifactsAddresses: any
  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  let previousConfiguration: OverrideEnvConfig[]

  before(async () => {
    previousConfiguration = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.INDEXER_NETWORKS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.ADDRESS_FILE
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          JSON.stringify([8996]),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    const config = await getConfiguration(true)
    database = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance()
    indexer = new OceanIndexer(database, mockSupportedNetworks)
    oceanNode.addIndexer(indexer)
    artifactsAddresses = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!artifactsAddresses) {
      artifactsAddresses = getOceanArtifactsAdresses().development
    }
    console.log(artifactsAddresses.FixedPrice)

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    genericAsset = JSON.parse(JSON.stringify(genericDDO))
    factoryContract = new ethers.Contract(
      artifactsAddresses.ERC721Factory,
      ERC721Factory.abi,
      publisherAccount
    )
  })

  it('instance Database', () => {
    expect(database).to.be.instanceOf(Database)
  })

  it('should publish a dataset w fre', async () => {
    console.log(`fixed price address: ${artifactsAddresses.FixedPrice}`)
    const tx = await factoryContract.createNftWithErc20WithFixedRate(
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
      },
      {
        fixedPriceAddress: artifactsAddresses.FixedPrice,
        addresses: [
          artifactsAddresses.Ocean,
          await publisherAccount.getAddress(),
          await publisherAccount.getAddress(),
          ZeroAddress
        ],
        uints: [18, 18, parseUnits('1', 18).toString(), parseUnits('0', 18).toString(), 1]
      }
    )
    const txReceipt = await tx.wait()
    assert(txReceipt, 'transaction failed')
    const event = getEventFromTx(txReceipt, 'NFTCreated')
    nftAddress = event.args[0]
    assert(nftAddress, 'find nft created failed')
    const datatokenEvent = getEventFromTx(txReceipt, 'TokenCreated')
    datatokenAddress = datatokenEvent.args[0]
    assert(datatokenAddress, 'find datatoken created failed')
    datatokenContract = new ethers.Contract(
      datatokenAddress,
      ERC20Template.abi,
      publisherAccount
    )
    assert(datatokenContract)
    const freEvent = getEventFromTx(txReceipt, 'NewFixedRate')
    const exchangeId = freEvent.args[0]
    assert(exchangeId, 'exchangeId not found.')
    console.log('exchange id: ', exchangeId)
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
    // create proper service.files string
    genericAsset.services[0].datatokenAddress = datatokenAddress
    genericAsset.nftAddress = nftAddress
    // let's call node to encrypt

    const data = Uint8Array.from(
      Buffer.from(JSON.stringify(genericAsset.services[0].files))
    )
    const encryptedData = await encrypt(data, EncryptMethod.ECIES)
    const encryptedDataString = encryptedData.toString('hex')
    genericAsset.services[0].files = encryptedDataString
    const stringDDO = JSON.stringify(genericAsset)
    const bytes = Buffer.from(stringDDO)
    const metadata = hexlify(bytes)
    const hash = createHash('sha256').update(metadata).digest('hex')

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x01',
      metadata,
      '0x' + hash,
      []
    )
    setMetaDataTxReceipt = await setMetaDataTx.wait()
    assert(setMetaDataTxReceipt, 'set metada failed')
    // for testing purpose
    genericAsset.event.tx = setMetaDataTxReceipt.transactionHash
    genericAsset.event.block = setMetaDataTxReceipt.blockNumber
    genericAsset.event.from = setMetaDataTxReceipt.from
    genericAsset.event.contract = setMetaDataTxReceipt.contractAddress
    genericAsset.event.datetime = '2023-02-15T16:42:22'

    genericAsset.nft.address = nftAddress
    genericAsset.nft.owner = setMetaDataTxReceipt.from
    genericAsset.nft.state = 0
    genericAsset.nft.created = '2022-12-30T08:40:43'
  })

  it('should store the ddo in the database and return it ', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const { ddo, wasTimeout } = await waitToIndex(
      assetDID,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT * 6
    )
    if (ddo) {
      resolvedDDO = ddo
      expect(resolvedDDO.id).to.equal(genericAsset.id)
    } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
  })

  it('should get stats for fre', async function () {
    assert(resolvedDDO.indexedMetadata, 'No stats available')
    assert(resolvedDDO.indexedMetadata.stats.length === 1)
    assert(resolvedDDO.indexedMetadata.stats[0].datatokenAddress === datatokenAddress)
    assert(resolvedDDO.indexedMetadata.stats[0].name === (await datatokenContract.name()))
    assert(resolvedDDO.indexedMetadata.stats[0].orders === 0)
    assert(resolvedDDO.indexedMetadata.stats[0].serviceId === '0')
    // assert(resolvedDDO.indexedMetadata.stats[0].prices === '1')
  })

  it('should attach a dispenser', async () => {
    const dtTx = await nftContract.createERC20()
    const tx = await datatokenContract.createDispenser(
      artifactsAddresses.Dispenser,
      ethers.parseUnits('1', 'ether'),
      ethers.parseUnits('1', 'ether'),
      true,
      ZeroAddress
    )
    assert(tx, 'Cannot create dispenser')
    console.log('tx for dipenser: ', JSON.stringify(tx))
    const txReceipt = await tx.wait()
    console.log('txReceipt for dipenser: ', JSON.stringify(txReceipt))
    const dispenserEvent = getEventFromTxByHash(
      txReceipt,
      '0x7d0aa581e6eb87e15f58588ff20c39ff6622fc796ec9bb664df6ed3eb02442c9' // DispenserCreated
    )
    assert(
      dispenserEvent.args[0] === datatokenAddress,
      'Datatoken addresses do not match for dispenser event'
    )
    const dispenserContract = new ethers.Contract(
      artifactsAddresses.Dispenser,
      Dispenser.abi,
      publisherAccount
    )
    const activationTx = await dispenserContract.activate(
      datatokenAddress,
      ethers.parseUnits('1', 'ether'),
      ethers.parseUnits('1', 'ether')
    )
    assert(tx, 'Cannot activate dispenser')
    const activationReceipt = await activationTx.wait()
    const activationEvent = getEventFromTxByHash(
      activationReceipt,
      '0xe9372084cb52c5392afee4b9d79d131e04b1e65676088d50a8f39fffb16a8745' // DispenserActivated
    )
    assert(
      activationEvent.args[0] === datatokenAddress,
      'Datatoken addresses do not match for dispenser event'
    )
    assert(
      (await dispenserContract.status(datatokenAddress))[0] === true,
      'dispenser not active'
    )
    const { ddo } = await waitToIndex(
      assetDID,
      EVENTS.DISPENSER_ACTIVATED,
      DEFAULT_TEST_TIMEOUT,
      true
    )
    console.log(`JSON stringified ddo w dispenser: ${JSON.stringify(ddo)}`)
    assert(ddo.indexedMetadata.stats)
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    indexer.stopAllThreads()
  })
})
