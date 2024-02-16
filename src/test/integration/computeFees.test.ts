import { expect, assert } from 'chai'
import { createHash } from 'crypto'
import {
  JsonRpcProvider,
  Signer,
  Contract,
  ethers,
  getAddress,
  hexlify,
  ZeroAddress
} from 'ethers'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { RPCS } from '../../@types/blockchain.js'
import { genericDDO } from '../data/ddo.js'
import { getOceanArtifactsAdresses } from '../../utils/address.js'
import { getEventFromTx } from '../../utils/util.js'
import { waitToIndex, delay, expectedTimeoutFailure } from './testUtils.js'
import { encrypt } from '../../utils/crypt.js'
import {
  calculateComputeProviderFee,
  getC2DEnvs
} from '../../components/core/utils/feesHandler.js'
import { ENVIRONMENT_VARIABLES, EVENTS } from '../../utils/constants.js'
import {
  DEFAULT_TEST_TIMEOUT,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment
} from '../utils/utils.js'
import { DDO } from '../../@types/DDO/DDO.js'

describe('Compute provider fees', async () => {
  let database: Database
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let nftContract: Contract
  let publisherAccount: Signer
  let nftAddress: string
  const chainId = 8996
  let assetDID: string
  let resolvedDDO: Record<string, any>
  let genericAsset: any
  let publisherAddress: string
  let consumerAccount: Signer
  let consumerAddress: string
  let datatokenAddress: string
  let computeEnvs: Array<any>

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  const data = getOceanArtifactsAdresses()
  const oceanToken = data.development.Ocean

  await setupEnvironment(
    null,
    buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.RPCS, ENVIRONMENT_VARIABLES.FEE_TOKENS],
      [JSON.stringify(mockSupportedNetworks), JSON.stringify({ 8996: oceanToken })]
    )
  )

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
    indexer = new OceanIndexer(database, mockSupportedNetworks)

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    consumerAccount = (await provider.getSigner(1)) as Signer
    publisherAccount = (await provider.getSigner(0)) as Signer
    publisherAddress = await publisherAccount.getAddress()
    consumerAddress = await consumerAccount.getAddress()
    genericAsset = genericDDO
    factoryContract = new ethers.Contract(
      data.development.ERC721Factory,
      ERC721Factory.abi,
      publisherAccount
    )
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
    const nftEvent = getEventFromTx(txReceipt, 'NFTCreated')
    const erc20Event = getEventFromTx(txReceipt, 'TokenCreated')

    nftAddress = nftEvent.args[0]
    datatokenAddress = erc20Event.args[0]
    console.log('### datatokenAddress', datatokenAddress)

    assert(nftAddress, 'find nft created failed')
    assert(datatokenAddress, 'find datatoken created failed')
  })

  it('should set metadata and save ', async () => {
    // Encrypt the files
    const files = {
      datatokenAddress: '0x0',
      nftAddress: '0x0',
      files: [
        {
          type: 'url',
          url: 'https://github.com/datablist/sample-csv-files/raw/main/files/organizations/organizations-100.csv',
          method: 'GET'
        }
      ]
    }

    const data = Uint8Array.from(Buffer.from(JSON.stringify(files)))
    const encryptedData = await encrypt(data, 'ECIES')
    // const encryptedDataString = encryptedData.toString('base64')

    nftContract = new ethers.Contract(nftAddress, ERC721Template.abi, publisherAccount)
    genericAsset.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(nftAddress) + chainId.toString(10))
        .digest('hex')
    genericAsset.nftAddress = nftAddress
    genericAsset.services[0].datatokenAddress = datatokenAddress
    genericAsset.services[0].files = encryptedData

    assetDID = genericAsset.id
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
    const trxReceipt = await setMetaDataTx.wait()
    assert(trxReceipt, 'set metada failed')
  })

  // delay(1000)
  it('should store the ddo in the database and return it ', async function () {
    resolvedDDO = await waitToIndex(
      assetDID,
      EVENTS.METADATA_CREATED,
      (ddo: any, wasTimeout: boolean) => {
        if (ddo) {
          expect(ddo.id).to.equal(genericAsset.id)
        } else {
          expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
        }
      },
      DEFAULT_TEST_TIMEOUT
    )
    if (resolvedDDO) {
      expect(resolvedDDO.id).to.equal(genericAsset.id)
    }
  })

  it('should get provider fees for compute', async () => {
    computeEnvs = await getC2DEnvs(resolvedDDO as DDO)
    assert(computeEnvs, 'compute envs could not be retrieved')
    const envs =
      computeEnvs[0][
        'http://172.15.0.13:31000/api/v1/operator/environments?chain_id=8996'
      ]
    // expect 2 envs
    expect(envs.length === 2, 'incorrect length')
    const filteredEnv = envs.filter((env: any) => env.priceMin !== 0)[0]
    const providerFees = await calculateComputeProviderFee(
      resolvedDDO as DDO,
      0,
      filteredEnv.id,
      resolvedDDO.services[0],
      provider
    )
    assert(providerFees, 'provider fees were not fetched')
    assert(providerFees.providerFeeToken === oceanToken)
    assert(providerFees.providerFeeAmount, 'provider fee amount is not fetched')
  })

  it('should get free provider fees for compute', async () => {
    computeEnvs = await getC2DEnvs(resolvedDDO as DDO)
    assert(computeEnvs, 'compute envs could not be retrieved')
    const envs =
      computeEnvs[0][
        'http://172.15.0.13:31000/api/v1/operator/environments?chain_id=8996'
      ]
    const filteredEnv = envs.filter((env: any) => env.priceMin === 0)[0]
    const providerFees = await calculateComputeProviderFee(
      resolvedDDO as DDO,
      0,
      filteredEnv.id,
      resolvedDDO.services[0],
      provider
    )
    assert(providerFees, 'provider fees were not fetched')
    console.log('provider fees: ', providerFees)
    assert(providerFees.providerFeeToken === oceanToken)
    assert(providerFees.providerFeeAmount === 0n, 'provider fee amount is not fetched')
  })
})
