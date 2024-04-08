import { getAlgoChecksums, validateAlgoForDataset } from '../../components/c2d/index.js'

import {
  Contract,
  ethers,
  getAddress,
  hexlify,
  JsonRpcProvider,
  Signer,
  ZeroAddress
} from 'ethers'
import { assert, expect } from 'chai'
import { getEventFromTx, streamToObject } from '../../utils/util.js'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import { RPCS } from '../../@types/blockchain.js'
import { getOceanArtifactsAdresses } from '../../utils/address.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { publishAlgoDDO, publishDatasetDDO } from '../data/ddo.js'
import { createHash } from 'crypto'
import { encrypt } from '../../utils/crypt.js'
import { delay, expectedTimeoutFailure, waitToIndex } from './testUtils.js'
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import {
  ENVIRONMENT_VARIABLES,
  EVENTS,
  getConfiguration,
  PROTOCOL_COMMANDS
} from '../../utils/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { EncryptMethod, FileObjectType, UrlFileObject } from '../../@types/fileObject.js'
import { FileInfoHandler } from '../../components/core/fileInfoHandler.js'
import { OceanNode } from '../../OceanNode.js'

import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

describe('C2D functions', () => {
  let config: OceanNodeConfig
  let database: Database
  let oceanNode: OceanNode
  // eslint-disable-next-line no-unused-vars
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let publisherAccount: Signer
  let publisherAddress: string
  let factoryContract: Contract
  let algoDDO: any
  let datasetDDO: any

  const chainId = 8996
  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  let previousConfiguration: OverrideEnvConfig[]

  before(async () => {
    // override and save configuration (always before calling getConfig())
    previousConfiguration = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.DB_URL
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          'http://localhost:8108/?apiKey=xyz'
        ]
      )
    )
    const artifactsAddresses = getOceanArtifactsAdresses()
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    publisherAddress = await publisherAccount.getAddress()
    algoDDO = { ...publishAlgoDDO }
    datasetDDO = { ...publishDatasetDDO }
    factoryContract = new ethers.Contract(
      artifactsAddresses.development.ERC721Factory,
      ERC721Factory.abi,
      publisherAccount
    )
    config = await getConfiguration(true)
    database = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(database)
    indexer = new OceanIndexer(database, mockSupportedNetworks)
  })

  it('should get file info before publishing', async () => {
    const urlFile: UrlFileObject = {
      type: 'url',
      url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
      method: 'get'
    }
    const fileInfoTask = {
      command: PROTOCOL_COMMANDS.FILE_INFO,
      file: urlFile,
      type: FileObjectType.URL
    }
    const response = await new FileInfoHandler(oceanNode).handle(fileInfoTask)

    assert(response)
    assert(response.stream, 'stream not present')
    assert(response.status.httpStatus === 200, 'http status not 200')
    expect(response.stream).to.be.instanceOf(Readable)

    const fileInfo = await streamToObject(response.stream as Readable)

    assert(fileInfo[0].valid, 'File info is valid')
    expect(fileInfo[0].contentLength).to.equal('946')
    expect(fileInfo[0].contentType).to.equal('text/plain; charset=utf-8')
    expect(fileInfo[0].name).to.equal('algo.js')
    expect(fileInfo[0].type).to.equal('url')
  })

  it('should publish AlgoDDO', async () => {
    const tx = await (factoryContract as any).createNftWithErc20(
      {
        name: '72120Bundle',
        symbol: '72Bundle',
        templateIndex: 1,
        tokenURI: 'https://oceanprotocol.com/nft/',
        transferable: true,
        owner: publisherAddress
      },
      {
        strings: ['ERC20B1', 'ERC20DT1Symbol'],
        templateIndex: 1,
        addresses: [publisherAddress, ZeroAddress, ZeroAddress, ZeroAddress],
        uints: [1000, 0],
        bytess: []
      }
    )
    const txFactoryContract = await tx.wait()
    assert(txFactoryContract, 'transaction failed')
    const nftEvent = getEventFromTx(txFactoryContract, 'NFTCreated')
    const erc20Event = getEventFromTx(txFactoryContract, 'TokenCreated')
    const dataNftAddress = nftEvent.args[0]
    const datatokenAddress = erc20Event.args[0]
    assert(dataNftAddress, 'find nft created failed')
    assert(datatokenAddress, 'find datatoken created failed')

    const nftContract = new ethers.Contract(
      dataNftAddress,
      ERC721Template.abi,
      publisherAccount
    )
    algoDDO.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(dataNftAddress) + chainId.toString(10))
        .digest('hex')
    algoDDO.nftAddress = dataNftAddress
    algoDDO.services[0].datatokenAddress = datatokenAddress

    const files = {
      datatokenAddress: '0x0',
      nftAddress: '0x0',
      files: [
        {
          type: 'url',
          url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
          method: 'get'
        }
      ]
    }
    const filesData = Uint8Array.from(Buffer.from(JSON.stringify(files)))
    algoDDO.services[0].files = await encrypt(filesData, EncryptMethod.ECIES)

    const metadata = hexlify(Buffer.from(JSON.stringify(algoDDO)))
    const hash = createHash('sha256').update(metadata).digest('hex')

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x00',
      metadata,
      '0x' + hash,
      []
    )
    const txReceipt = await setMetaDataTx.wait()
    assert(txReceipt, 'set metadata failed')
  })

  it('should publish DatasetDDO', async () => {
    const tx = await (factoryContract as any).createNftWithErc20(
      {
        name: '72120Bundle',
        symbol: '72Bundle',
        templateIndex: 1,
        tokenURI: 'https://oceanprotocol.com/nft/',
        transferable: true,
        owner: publisherAddress
      },
      {
        strings: ['ERC20B1', 'ERC20DT1Symbol'],
        templateIndex: 1,
        addresses: [publisherAddress, ZeroAddress, ZeroAddress, ZeroAddress],
        uints: [1000, 0],
        bytess: []
      }
    )
    const txFactoryContract = await tx.wait()
    assert(txFactoryContract, 'transaction failed')
    const nftEvent = getEventFromTx(txFactoryContract, 'NFTCreated')
    const erc20Event = getEventFromTx(txFactoryContract, 'TokenCreated')
    const dataNftAddress = nftEvent.args[0]
    const datatokenAddress = erc20Event.args[0]
    assert(dataNftAddress, 'find nft created failed')
    assert(datatokenAddress, 'find datatoken created failed')

    const nftContract = new ethers.Contract(
      dataNftAddress,
      ERC721Template.abi,
      publisherAccount
    )
    datasetDDO.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(dataNftAddress) + chainId.toString(10))
        .digest('hex')
    datasetDDO.nftAddress = dataNftAddress
    datasetDDO.services[0].datatokenAddress = datatokenAddress

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
    const filesData = Uint8Array.from(Buffer.from(JSON.stringify(files)))
    datasetDDO.services[0].files = await encrypt(filesData, EncryptMethod.ECIES)

    datasetDDO.services[0].compute = {
      allowRawAlgorithm: false,
      allowNetworkAccess: true,
      publisherTrustedAlgorithmPublishers: [publisherAddress],
      publisherTrustedAlgorithms: [
        {
          did: algoDDO.id,
          filesChecksum:
            'f6a7b95e4a2e3028957f69fdd2dac27bd5103986b2171bc8bfee68b52f874dcd',
          containerSectionChecksum:
            'ba8885fcc7d366f058d6c3bb0b7bfe191c5f85cb6a4ee3858895342436c23504'
        }
      ]
    }

    const metadata = hexlify(Buffer.from(JSON.stringify(datasetDDO)))
    const hash = createHash('sha256').update(metadata).digest('hex')

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x00',
      metadata,
      '0x' + hash,
      []
    )
    const txReceipt = await setMetaDataTx.wait()
    assert(txReceipt, 'set metadata failed')
  })

  delay(50000)

  it('should getAlgoChecksums', async function () {
    const { ddo, wasTimeout } = await waitToIndex(
      algoDDO.id,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT
    )
    const algoDDOTest = ddo
    if (algoDDOTest) {
      const algoChecksums = await getAlgoChecksums(
        algoDDOTest.id,
        algoDDOTest.services[0].id,
        oceanNode
      )
      expect(algoChecksums.files).to.equal(
        'f6a7b95e4a2e3028957f69fdd2dac27bd5103986b2171bc8bfee68b52f874dcd'
      )
      expect(algoChecksums.container).to.equal(
        'ba8885fcc7d366f058d6c3bb0b7bfe191c5f85cb6a4ee3858895342436c23504'
      )
    } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
  })

  it('should validateAlgoForDataset', async function () {
    const { ddo, wasTimeout } = await waitToIndex(
      algoDDO.id,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT
    )

    const algoDDOTest = ddo
    if (algoDDOTest) {
      const algoChecksums = await getAlgoChecksums(
        algoDDOTest.id,
        algoDDOTest.services[0].id,
        oceanNode
      )
      const { ddo, wasTimeout } = await waitToIndex(
        datasetDDO.id,
        EVENTS.METADATA_CREATED,
        DEFAULT_TEST_TIMEOUT
      )

      const datasetDDOTest = ddo
      if (datasetDDOTest) {
        const result = await validateAlgoForDataset(
          algoDDOTest.id,
          algoChecksums,
          datasetDDOTest.id,
          datasetDDOTest.services[0].id,
          oceanNode
        )
        expect(result).to.equal(true)
      } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
  })

  it('should validateAlgoForDataset if trusted algos are empty', async function () {
    const { ddo, wasTimeout } = await waitToIndex(
      algoDDO.id,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT
    )

    const algoDDOTest = ddo
    if (algoDDOTest) {
      const algoChecksums = await getAlgoChecksums(
        algoDDOTest.id,
        algoDDOTest.services[0].id,
        oceanNode
      )
      const { ddo, wasTimeout } = await waitToIndex(
        datasetDDO.id,
        EVENTS.METADATA_CREATED,
        DEFAULT_TEST_TIMEOUT
      )

      const datasetDDOTest = ddo
      if (datasetDDOTest) {
        const result = await validateAlgoForDataset(
          algoDDOTest.id,
          algoChecksums,
          datasetDDOTest.id,
          datasetDDOTest.services[0].id,
          oceanNode
        )
        expect(result).to.equal(true)
      } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})
