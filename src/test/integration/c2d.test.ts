import {
  checkEnvironmentExists,
  getAlgoChecksums,
  validateAlgoForDataset,
  validateConsumerParameters
} from '../../components/c2d/index.js'
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
import { delay, waitToIndex } from './testUtils.js'
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { getConfiguration, PROTOCOL_COMMANDS } from '../../utils/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { UrlFileObject } from '../../@types/fileObject.js'
import { FileInfoHandler } from '../../components/core/fileInfoHandler.js'
import { OceanNode } from '../../OceanNode.js'

describe('C2D functions', async () => {
  let config: OceanNodeConfig
  let database: Database
  let oceanNode: OceanNode
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let publisherAccount: Signer
  let publisherAddress: string
  let factoryContract: Contract
  let algoDDO: any
  let datasetDDO: any

  const chainId = 8996
  const mockSupportedNetworks: RPCS = {
    '8996': {
      chainId: 8996,
      network: 'development',
      rpc: 'http://127.0.0.1:8545',
      chunkSize: 100
    }
  }

  before(async () => {
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
    process.env.PRIVATE_KEY =
      '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58'
    process.env.RPCS = JSON.stringify(mockSupportedNetworks)
    process.env.AUTHORIZED_DECRYPTERS = JSON.stringify([publisherAddress])
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    config = await getConfiguration(true)
    database = await new Database(dbConfig)
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
      type: 'url' as 'url'
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
    algoDDO.services[0].files = await encrypt(filesData, 'ECIES')

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
    datasetDDO.services[0].files = await encrypt(filesData, 'ECIES')

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

  it('should getAlgoChecksums', async () => {
    const algoDDOTest = await waitToIndex(algoDDO.id, database)
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
  })

  it('should validateAlgoForDataset', async () => {
    const algoDDOTest = await waitToIndex(algoDDO.id, database)
    const algoChecksums = await getAlgoChecksums(
      algoDDOTest.id,
      algoDDOTest.services[0].id,
      oceanNode
    )
    const datasetDDOTest = await waitToIndex(datasetDDO.id, database)
    const result = await validateAlgoForDataset(
      algoDDOTest.id,
      algoChecksums,
      datasetDDOTest.id,
      datasetDDOTest.services[0].id,
      oceanNode
    )
    expect(result).to.equal(true)
  })

  it('should validateConsumerParameters', async () => {
    const consumerParameters = [
      {
        name: 'hometown',
        type: 'text',
        label: 'Hometown',
        required: true,
        description: 'What is your hometown?',
        default: 'Nowhere'
      },
      {
        name: 'age',
        type: 'number',
        label: 'Age',
        required: false,
        description: 'Please fill your age',
        default: 0
      },
      {
        name: 'developer',
        type: 'boolean',
        label: 'Developer',
        required: false,
        description: 'Are you a developer?',
        default: false
      },
      {
        name: 'languagePreference',
        type: 'select',
        label: 'Language',
        required: false,
        description: 'Do you like NodeJs or Python',
        default: 'nodejs',
        options: [
          {
            nodejs: 'I love NodeJs'
          },
          {
            python: 'I love Python'
          }
        ]
      }
    ]
    const result = await validateConsumerParameters(consumerParameters)
    expect(result.valid).to.equal(true)
  })

  it('should checkEnvironmentExists', async () => {
    const envId =
      '0x12c67122f93c331b9dba0d25465d358c65d31f67a58c4675916ef1c7bbf4588d-ocean-compute'
    const result = await checkEnvironmentExists(envId, oceanNode)
    expect(result).to.equal(true)
  })
})
