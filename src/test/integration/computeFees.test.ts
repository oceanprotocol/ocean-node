import { expect, assert } from 'chai'
import { Readable } from 'stream'
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
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { RPCS } from '../../@types/blockchain.js'
import { genericDDO } from '../data/ddo.js'
import { getOceanArtifactsAdresses } from '../../utils/address.js'
import { DownloadHandler } from '../../components/core/downloadHandler.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { getEventFromTx, sleep } from '../../utils/util.js'
import { waitToIndex, delay } from './testUtils.js'
import { getConfiguration } from '../../utils/config.js'
import { ProviderFeeData } from '../../@types/Fees.js'
import { encrypt } from '../../utils/crypt.js'
import {
  calculateComputeProviderFee,
  createFee,
  getC2DEnvs
} from '../../components/core/utils/feesHandler.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { OceanNode } from '../../OceanNode.js'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { DDO } from '../../@types/DDO/DDO.js'
import { env } from 'process'

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
  let orderTxId: string
  let dataTokenContractWithNewSigner: any
  let feeTx: string
  let feeData: ProviderFeeData | undefined
  let computeEnvs: Array<any>

  const feeToken = '0x312213d6f6b5FCF9F56B7B8946A6C727Bf4Bc21f'
  const serviceId = '0' // dummy index
  const consumeMarketFeeAddress = ZeroAddress // marketplace fee Collector
  const consumeMarketFeeAmount = 0 // fee to be collected on top, requires approval
  const consumeMarketFeeToken = feeToken // token address for the feeAmount,

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  let previousConfiguration: OverrideEnvConfig[]

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
    indexer = new OceanIndexer(database, mockSupportedNetworks)

    const data = getOceanArtifactsAdresses()

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
    previousConfiguration = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [ENVIRONMENT_VARIABLES.RPCS],
        [JSON.stringify(mockSupportedNetworks)]
      )
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

  delay(35000)
  it('should store the ddo in the database and return it ', async () => {
    resolvedDDO = await waitToIndex(assetDID, database)
    expect(resolvedDDO.id).to.equal(genericAsset.id)
  })

  it('should get compute envs', async () => {
    computeEnvs = await getC2DEnvs(resolvedDDO as DDO)
    assert(computeEnvs, 'compute envs could not be retrieved')
    const envs =
      computeEnvs[0][
        'http://172.15.0.13:31000/api/v1/operator/environments?chain_id=8996'
      ]
    // expect 2 envs
    expect(envs.length === 2)
    console.log('env: ', envs[0])
    console.log('ddo: ', resolvedDDO)
    const providerFees = await calculateComputeProviderFee(
      resolvedDDO as DDO,
      0,
      envs[0].id,
      resolvedDDO.services[0],
      provider
    )
    console.log('provide fee: ', providerFees)
  })
})
