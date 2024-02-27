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
import { Readable } from 'stream'
import { streamToObject, getEventFromTx } from '../../utils/util.js'
import {
  PROTOCOL_COMMANDS,
  ENVIRONMENT_VARIABLES,
  EVENTS
} from '../../utils/constants.js'
import {
  InitializeComputeCommand,
  ComputeAsset,
  ComputeAlgorithm
} from '../../@types/C2D.js'
import {
  InitializeComputeHandler,
  GetEnvironmentsHandler
} from '../../components/core/compute.js'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { RPCS } from '../../@types/blockchain.js'
import { genericComputeDDO, genericAlgorithm } from '../data/ddo.js'
import { getOceanArtifactsAdresses } from '../../utils/address.js'
import { waitToIndex, expectedTimeoutFailure } from './testUtils.js'
import { encrypt } from '../../utils/crypt.js'
import {
  calculateComputeProviderFee,
  getC2DEnvs
} from '../../components/core/utils/feesHandler.js'
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
import { ProviderFeeData } from '../../@types/Fees.js'
import { OceanNode } from '../../OceanNode.js'
import { EncryptMethod } from '../../@types/fileObject.js'

describe('Compute provider fees', async () => {
  let database: Database
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let nftContract: Contract
  let nftAlgoContract: Contract
  let publisherAccount: Signer
  let nftAddress: string
  let nftAddressAlgo: string
  const chainId = 8996
  let assetDID: string
  let algoDID: string
  let resolvedDDO: Record<string, any>
  let resolvedAlgo: Record<string, any>
  let genericAsset: any
  let genericAlgo: any
  let publisherAddress: string
  let consumerAccount: Signer
  let consumerAddress: string
  let datatokenAddress: string
  let datatokenAddressAlgo: string
  let computeEnvs: Array<any>
  let computeProviderFess: ProviderFeeData
  let oceanNode: OceanNode

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
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
    indexer = new OceanIndexer(database, mockSupportedNetworks)
    oceanNode = await OceanNode.getInstance(database)

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    consumerAccount = (await provider.getSigner(1)) as Signer
    publisherAccount = (await provider.getSigner(0)) as Signer
    publisherAddress = await publisherAccount.getAddress()
    consumerAddress = await consumerAccount.getAddress()
    genericAsset = genericComputeDDO
    genericAlgo = genericAlgorithm
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

  it('should publish a algorithm', async () => {
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

    nftAddressAlgo = nftEvent.args[0]
    datatokenAddressAlgo = erc20Event.args[0]
    console.log('### datatokenAddress', datatokenAddress)

    assert(nftAddressAlgo, 'find nft created failed')
    assert(datatokenAddressAlgo, 'find datatoken created failed')
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

    nftAlgoContract = new ethers.Contract(
      nftAddressAlgo,
      ERC721Template.abi,
      publisherAccount
    )
    genericAlgo.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(nftAddressAlgo) + chainId.toString(10))
        .digest('hex')
    genericAlgo.nftAddress = nftAddressAlgo
    genericAlgo.services[0].datatokenAddress = datatokenAddressAlgo
    genericAlgo.services[0].files = encryptedData

    algoDID = genericAlgo.id

    const stringAlgo = JSON.stringify(genericAlgo)
    const bytesAlgo = Buffer.from(stringAlgo)
    const metadataAlgo = hexlify(bytesAlgo)
    const hashAlgo = createHash('sha256').update(metadata).digest('hex')

    const setMetaDataTxAlgo = await nftAlgoContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x01',
      metadataAlgo,
      '0x' + hashAlgo,
      []
    )
    const trxReceiptAlgo = await setMetaDataTxAlgo.wait()
    assert(trxReceiptAlgo, 'set metada failed')
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

  it('should store the algo in the database and return it ', async function () {
    const { ddo, wasTimeout } = await waitToIndex(
      algoDID,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT
    )
    resolvedAlgo = ddo
    if (resolvedAlgo) {
      expect(resolvedAlgo.id).to.equal(genericAlgo.id)
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
    computeProviderFess = await calculateComputeProviderFee(
      resolvedDDO as DDO,
      0,
      filteredEnv.id,
      resolvedDDO.services[0],
      provider
    )
    assert(computeProviderFess, 'provider fees were not fetched')
    assert(computeProviderFess.providerFeeToken === oceanToken)
    assert(computeProviderFess.providerFeeAmount, 'provider fee amount is not fetched')
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
    computeProviderFess = await calculateComputeProviderFee(
      resolvedDDO as DDO,
      0,
      filteredEnv.id,
      resolvedDDO.services[0],
      provider
    )
    assert(computeProviderFess, 'provider fees were not fetched')
    assert(computeProviderFess.providerFeeToken === oceanToken)
    assert(
      computeProviderFess.providerFeeAmount === 0n,
      'provider fee amount is not fetched'
    )
  })

  it('Initialize compute without transaction IDs', async () => {
    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.GET_COMPUTE_ENVIRONMENTS,
      chainId: 8996
    }
    const response = await new GetEnvironmentsHandler(oceanNode).handle(
      getEnvironmentsTask
    )

    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)

    const computeEnvironments = await streamToObject(response.stream as Readable)
    const firstEnv = computeEnvironments[0].id
    const { consumerAddress } = computeEnvironments[0]
    const dataset: ComputeAsset = {
      documentId: resolvedDDO.id,
      serviceId: resolvedDDO.services[0].id
    }
    const algorithm: ComputeAlgorithm = {
      documentId: resolvedAlgo.id,
      serviceId: resolvedAlgo.services[0].id
    }
    const currentDate = new Date()
    const initializeComputeTask: InitializeComputeCommand = {
      datasets: [dataset],
      algorithm,
      compute: {
        env: firstEnv,
        validUntil: new Date(
          currentDate.getFullYear() + 1,
          currentDate.getMonth(),
          currentDate.getDate()
        ).getTime()
      },
      consumerAddress,
      command: PROTOCOL_COMMANDS.INITIALIZE_COMPUTE,
      chainId: 8996
    }
    const resp = await new InitializeComputeHandler(oceanNode).handle(
      initializeComputeTask
    )

    assert(resp, 'Failed to get response')
    assert(resp.status.httpStatus === 200, 'Failed to get 200 response')
    assert(resp.stream, 'Failed to get stream')
    expect(resp.stream).to.be.instanceOf(Readable)

    let receivedData = ''

    // Consume the stream
    resp.stream.on('data', (chunk) => {
      receivedData += chunk.toString()
    })

    resp.stream.on('end', () => {
      console.log('Received data:', receivedData)
      try {
        const receivedDataParsed = JSON.parse(receivedData)
        console.log('Parsed data:', receivedDataParsed)
        assert(receivedDataParsed.algorithm, 'algorithm does not exist')
        assert(
          receivedDataParsed.algorithm.providerFeeAddress,
          'algorithm providerFeeAddress does not exist'
        )
        assert(
          receivedDataParsed.algorithm.providerFeeToken,
          'algorithm providerFeeToken does not exist'
        )
        assert(
          receivedDataParsed.algorithm.providerFeeAmount === 0,
          'algorithm providerFeeToken does not exist'
        ) // it uses the free env
        assert(
          receivedDataParsed.algorithm.providerFeeData,
          'algorithm providerFeeData does not exist'
        )

        assert(
          receivedDataParsed.algorithm.validUntil ===
            initializeComputeTask.compute.validUntil / 1000,
          'algorithm providerFeeData does not exist'
        )

        assert(receivedDataParsed.datasets.length > 0, 'datasets key does not exist')
        assert(
          receivedDataParsed.datasets[0].providerFeeAddress,
          'algorithm providerFeeAddress does not exist'
        )
        assert(
          receivedDataParsed.datasets[0].providerFeeToken,
          'algorithm providerFeeToken does not exist'
        )
        assert(
          receivedDataParsed.datasets[0].providerFeeAmount === 0,
          'algorithm providerFeeToken does not exist'
        ) // it uses the free env
        assert(
          receivedDataParsed.datasets[0].providerFeeData,
          'algorithm providerFeeData does not exist'
        )

        assert(
          receivedDataParsed.datasets[0].validUntil ===
            initializeComputeTask.compute.validUntil / 1000,
          'algorithm providerFeeData does not exist'
        )
      } catch (error) {
        console.error('Error parsing JSON:', error)
      }
    })
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
