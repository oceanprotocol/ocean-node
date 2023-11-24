import { expect } from 'chai'
import { createHash } from 'crypto'
import { JsonRpcProvider, Signer, Provider, Contract, ethers, Indexed } from 'ethers'
import fs from 'fs'
import { homedir } from 'os'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { Database } from '../../src/components/database/index.js'
import { OceanIndexer } from '../../src/components/Indexer/index.js'
import { RPCS } from '../../src/@types/blockchain.js'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const genericAsset = {
  '@context': ['https://w3id.org/did/v1'],
  id: '',
  version: '4.1.0',
  chainId: 4,
  nftAddress: '0x0',
  metadata: {
    created: '2021-12-20T14:35:20Z',
    updated: '2021-12-20T14:35:20Z',
    type: 'dataset',
    name: 'dataset-name',
    description: 'Ocean protocol test dataset description',
    author: 'oceanprotocol-team',
    license: 'MIT',
    tags: ['white-papers'],
    additionalInformation: { 'test-key': 'test-value' },
    links: ['http://data.ceda.ac.uk/badc/ukcp09/']
  },
  services: [
    {
      id: 'testFakeId',
      type: 'access',
      description: 'Download service',
      files: '',
      datatokenAddress: '0x0',
      serviceEndpoint: 'http://172.15.0.4:8030',
      timeout: 0
    }
  ]
}

describe('Indexer stores a new published DDO', () => {
  let database: Database
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let nftContract: Contract
  let publisherAccount: Signer
  let nftAddress: string

  const mockSupportedNetworks: RPCS = {
    '8996': {
      chainId: 8996,
      network: 'development',
      rpc: 'http://127.0.0.1:8545',
      chunkSize: 1000
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

    publisherAccount = (await provider.getSigner(0)) as Signer

    factoryContract = new ethers.Contract(
      data.development.ERC721Factory,
      ERC721Factory.abi,
      provider
    )
  })

  it('instance Database', async () => {
    expect(database).to.be.instanceOf(Database)
  })

  it('should publish a dataset', async () => {
    const nftParams = {
      name: 'testNftDispenser',
      symbol: 'TSTD',
      templateIndex: 1,
      tokenURI: '',
      transferable: true,
      owner: await publisherAccount.getAddress()
    }

    const datatokenParams = {
      templateIndex: 1,
      cap: '100000',
      feeAmount: '0',
      paymentCollector: ZERO_ADDRESS,
      feeToken: ZERO_ADDRESS,
      minter: await publisherAccount.getAddress(),
      mpFeeAddress: ZERO_ADDRESS
    }

    const createTx = await factoryContract.createNftWithErc20(nftParams, datatokenParams)
    const txReceipt = await createTx.wait()
    console.log('trxReceipt ==', txReceipt)
    nftAddress = txReceipt?.events?.filter((log) => {
      return log.event === 'NFTCreated'
    })[0].args.newTokenAddress
    expect(txReceipt.hash).to.be('string')
  })

  it('should set ', async () => {
    nftContract = new ethers.Contract(nftAddress, ERC721Template.abi, provider)

    const stringDDO = JSON.stringify(genericAsset)
    const hash = createHash('sha256').update(stringDDO).digest('hex')

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x02',
      stringDDO,
      hash,
      []
    )
    const trxReceipt = await setMetaDataTx.wait()
    console.log('trxReceipt ==', trxReceipt)
    expect(trxReceipt.hash).to.be('string')
  })
})
