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
import { RPCS } from '../../@types/blockchain.js'
import { genericDDO } from '../data/ddo.js'
import { getOceanArtifactsAdresses } from '../../utils/address.js'
import { getEventFromTx } from '../../utils/util.js'
import { waitToIndex, expectedTimeoutFailure } from './testUtils.js'
import { encrypt } from '../../utils/crypt.js'
import {
  calculateComputeProviderFee,
  getC2DEnvs
} from '../../components/core/utils/feesHandler.js'
import { ENVIRONMENT_VARIABLES, EVENTS } from '../../utils/constants.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  isRunningContinousIntegrationEnv,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { DDO } from '../../@types/DDO/DDO.js'
import { EncryptMethod } from '../../@types/fileObject.js'

describe('Compute provider fees', () => {
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let nftContract: Contract
  let publisherAccount: Signer
  let nftAddress: string
  const chainId = 8996
  let assetDID: string
  let resolvedDDO: Record<string, any>
  let genericAsset: any
  let datatokenAddress: string
  let computeEnvs: Array<any>

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  const data = getOceanArtifactsAdresses()
  const oceanToken = data.development.Ocean

  let envOverrides: OverrideEnvConfig[]

  before(async () => {
    envOverrides = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [ENVIRONMENT_VARIABLES.RPCS, ENVIRONMENT_VARIABLES.FEE_TOKENS],
        [JSON.stringify(mockSupportedNetworks), JSON.stringify({ 8996: oceanToken })]
      )
    )

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
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
          url: 'https://raw.githubusercontent.com/tbertinmahieux/MSongsDB/master/Tasks_Demos/CoverSongs/shs_dataset_test.txt',
          method: 'GET'
        }
      ]
    }

    const data = Uint8Array.from(Buffer.from(JSON.stringify(files)))
    const encryptedData = await encrypt(data, EncryptMethod.ECIES)
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

  it('should store the ddo in the database and return it ', async function () {
    const { ddo, wasTimeout } = await waitToIndex(
      assetDID,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT
    )
    resolvedDDO = ddo
    if (resolvedDDO) {
      expect(resolvedDDO.id).to.equal(genericAsset.id)
    } else {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    }
  })

  it('should get provider fees for compute', async () => {
    computeEnvs = await getC2DEnvs(resolvedDDO as DDO)
    if (!isRunningContinousIntegrationEnv()) {
      // This fails locally because of connect EHOSTUNREACH to the url http://172.15.0.13:31000
      assert(computeEnvs.length === 0, 'compute envs do not exist locally')
      return
    }
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
    if (!isRunningContinousIntegrationEnv()) {
      // This fails locally because of connect EHOSTUNREACH to the url http://172.15.0.13:31000
      assert(computeEnvs.length === 0, 'compute envs do not exist locally')
      return
    }
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

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
