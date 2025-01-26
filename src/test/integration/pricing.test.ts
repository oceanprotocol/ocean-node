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
import { getEventFromTx } from '../../utils/util.js'
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
  let exchangeId: string
  let dispenserContract: ethers.Contract
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
    exchangeId = freEvent.args[0]
    assert(exchangeId, 'exchangeId not found.')
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
    assert(
      resolvedDDO.indexedMetadata.stats[0].datatokenAddress === datatokenAddress,
      'DT is missing.'
    )
    assert(
      resolvedDDO.indexedMetadata.stats[0].name === (await datatokenContract.name()),
      'Name is missing.'
    )
    assert(
      resolvedDDO.indexedMetadata.stats[0].orders === 0,
      'Number of orders are missing.'
    )
    assert(
      resolvedDDO.indexedMetadata.stats[0].serviceId === '0',
      'Service ID is missing.'
    )
    assert(
      resolvedDDO.indexedMetadata.stats[0].prices.length === 1,
      'Incorrect length of prices'
    )
    assert(
      resolvedDDO.indexedMetadata.stats[0].prices[0].type === 'fixedrate',
      'Type from prices is not present.'
    )
    assert(
      resolvedDDO.indexedMetadata.stats[0].prices[0].token === artifactsAddresses.Ocean,
      'Datatoken from prices is not present.'
    )
    assert(
      resolvedDDO.indexedMetadata.stats[0].prices[0].price === '1.0',
      'Price is not present.'
    )
    assert(
      resolvedDDO.indexedMetadata.stats[0].prices[0].exchangeId === exchangeId,
      'Exchange ID is not present.'
    )
  })

  it('should attach a dispenser', async () => {
    const dtTx = await nftContract.createERC20(
      1,
      ['newERC20', 'newERC20s'],
      [
        await publisherAccount.getAddress(),
        await publisherAccount.getAddress(),
        await publisherAccount.getAddress(),
        datatokenAddress
      ],
      [parseUnits('10000', 18), parseUnits('1', 18)],
      []
    )
    assert(dtTx, 'Cannot create datatoken')
    const dtTxReceipt = await dtTx.wait()
    const dtEvent = getEventFromTx(dtTxReceipt, 'TokenCreated')
    const newdatatokenAddress = dtEvent.args[0]
    const newDtContract = new ethers.Contract(
      newdatatokenAddress,
      ERC20Template.abi,
      publisherAccount
    )
    const tx = await newDtContract.createDispenser(
      artifactsAddresses.Dispenser,
      parseUnits('1', 18),
      parseUnits('1', 18),
      true,
      await publisherAccount.getAddress()
    )
    assert(tx, 'Cannot create dispenser')
    const txReceipt = await tx.wait()
    const dispenserEvent = getEventFromTx(txReceipt, 'NewDispenser')
    const dispenserAddress = dispenserEvent.topics[0]
    assert(dispenserAddress, 'Dispenser contract not retrieved')

    dispenserContract = new ethers.Contract(
      dispenserAddress,
      Dispenser.abi,
      publisherAccount
    )
    assert(dispenserContract)
    genericAsset.services.push({
      id: '1',
      type: 'access',
      description: 'Download service',
      datatokenAddress: newdatatokenAddress,
      files: [
        {
          url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
          contentType: 'text/js',
          encoding: 'UTF-8'
        }
      ],
      serviceEndpoint: 'http://172.15.0.4:8030',
      timeout: 0
    })

    const data = Uint8Array.from(
      Buffer.from(JSON.stringify(genericAsset.services[1].files))
    )
    const encryptedData = await encrypt(data, EncryptMethod.ECIES)
    const encryptedDataString = encryptedData.toString('hex')
    genericAsset.services[1].files = encryptedDataString
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
  })
  it('should store the ddo in the database and return it ', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const { ddo, wasTimeout } = await waitToIndex(
      assetDID,
      EVENTS.METADATA_UPDATED,
      DEFAULT_TEST_TIMEOUT * 6
    )
    const updatedDDO: any = ddo
    if (updatedDDO) {
      console.log(JSON.stringify(updatedDDO.indexedMetadata.stats))
      assert(
        updatedDDO.indexedMetadata.stats.length === 2,
        'the 2 pricing schemas were not captured in the stats'
      )
      assert(
        updatedDDO.indexedMetadata.stats[1].prices[0].type === 'dispenser',
        'type is not dispenser'
      )
      assert(
        updatedDDO.indexedMetadata.stats[1].datatokenAddress ===
          genericAsset.services[1].datatokenAddress,
        'mismatch datatoken address'
      )
      assert(
        updatedDDO.indexedMetadata.stats[1].prices[0].price === '0',
        'price is not 0'
      )
      assert(
        updatedDDO.indexedMetadata.stats[1].prices[0].token ===
          genericAsset.services[1].datatokenAddress,
        'mismatch datatoken address'
      )
    } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
  })

  it('should remove the dispenser from stats', async () => {
    const tx = await dispenserContract.deactivate(
      genericAsset.services[1].datatokenAddress
    )
    assert(tx, 'Cannot create dispenser')
    const txReceipt = await tx.wait()
    const dispenserEvent = getEventFromTx(txReceipt, 'DispenserDeactivated')
    assert(dispenserEvent)
    // const data = Uint8Array.from(
    //   Buffer.from(JSON.stringify(genericAsset.services[1].files))
    // )
    // const encryptedData = await encrypt(data, EncryptMethod.ECIES)
    // const encryptedDataString = encryptedData.toString('hex')
    // genericAsset.services[1].files = encryptedDataString
    // const stringDDO = JSON.stringify(genericAsset)
    // const bytes = Buffer.from(stringDDO)
    // const metadata = hexlify(bytes)
    // const hash = createHash('sha256').update(metadata).digest('hex')

    // const setMetaDataTx = await nftContract.setMetaData(
    //   0,
    //   'http://v4.provider.oceanprotocol.com',
    //   '0x123',
    //   '0x01',
    //   metadata,
    //   '0x' + hash,
    //   []
    // )
    // setMetaDataTxReceipt = await setMetaDataTx.wait()
    // assert(setMetaDataTxReceipt, 'set metada failed')
  })
  it('should store the ddo in the database and return it ', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const { ddo, wasTimeout } = await waitToIndex(
      assetDID,
      EVENTS.DISPENSER_DEACTIVATED,
      DEFAULT_TEST_TIMEOUT * 6
    )
    const updatedDDO: any = ddo
    if (updatedDDO) {
      assert(
        updatedDDO.indexedMetadata.stats.length === 1,
        'the pricing schema removal was not captured in the stats'
      )
    } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    indexer.stopAllThreads()
  })
})
