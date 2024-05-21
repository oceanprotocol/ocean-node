import { expect, assert } from 'chai'
import {
  JsonRpcProvider,
  Signer,
  Contract,
  ethers,
  hexlify,
  ZeroAddress,
  getAddress,
  toUtf8Bytes
} from 'ethers'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { RPCS } from '../../@types/blockchain.js'
import { getEventFromTx } from '../../utils/util.js'
import { waitToIndex } from './testUtils.js'
import { genericDDO } from '../data/ddo.js'
import { makeDid } from '../../components/core/utils/validateDdoHandler.js'
import { create256Hash } from '../../utils/crypt.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import {
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment,
  OverrideEnvConfig,
  buildEnvOverrideConfig
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES, EVENTS } from '../../utils/constants.js'
import { homedir } from 'os'
import { OceanNode } from '../../OceanNode.js'
import axios from 'axios'

function uploadToIpfs(data: any): Promise<string> {
  return new Promise((resolve, reject) => {
    axios
      .post(
        'http://172.15.0.16:5001/api/v0/add',
        '--------------------------a28d68b1c872c96f\r\nContent-Disposition: form-data; name="file"; filename="ddo.json"\r\nContent-Type: application/octet-stream\r\n\r\n' +
          data +
          '\r\n--------------------------a28d68b1c872c96f--\r\n',
        {
          headers: {
            'Content-Type':
              'multipart/form-data; boundary=------------------------a28d68b1c872c96f'
          }
        }
      )
      .then(function (response: any) {
        resolve(response.data.Hash)
      })
      .catch(function (error: any) {
        reject(error)
      })
  })
}

describe('RemoteDDO: Indexer stores a new metadata events and orders.', () => {
  let database: Database
  // eslint-disable-next-line no-unused-vars
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let nftContract: Contract
  let publisherAccount: Signer
  // eslint-disable-next-line no-unused-vars
  let consumerAccount: Signer
  let nftAddress: string
  let datatokenAddress: string
  let resolvedDDO: Record<string, any>
  // eslint-disable-next-line no-unused-vars
  let genericAsset: any
  let setMetaDataTxReceipt: any
  // eslint-disable-next-line no-unused-vars
  let oceanNode: OceanNode
  const chainId = 8996
  let previousConfiguration: OverrideEnvConfig[]
  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }

    previousConfiguration = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.DB_URL,
          ENVIRONMENT_VARIABLES.ADDRESS_FILE
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          dbConfig.url,
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    database = await new Database(dbConfig)
    indexer = new OceanIndexer(database, mockSupportedNetworks)
    oceanNode = await OceanNode.getInstance(database)
    let artifactsAddresses = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!artifactsAddresses) {
      artifactsAddresses = getOceanArtifactsAdresses().development
    }

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
    genericAsset = genericDDO
    factoryContract = new ethers.Contract(
      artifactsAddresses.ERC721Factory,
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
    const event = getEventFromTx(txReceipt, 'NFTCreated')
    nftAddress = event.args[0]
    assert(nftAddress, 'find nft created failed')
    const datatokenEvent = getEventFromTx(txReceipt, 'TokenCreated')
    datatokenAddress = datatokenEvent.args[0]
    assert(datatokenAddress, 'find datatoken created failed')
  })

  it('should set metadata and save (the remote DDO is encrypted) ', async () => {
    nftContract = new ethers.Contract(nftAddress, ERC721Template.abi, publisherAccount)
    const ddoToPublish = genericDDO
    ddoToPublish.id = makeDid(getAddress(nftAddress), chainId.toString(10))
    const ipfsCID = await uploadToIpfs(JSON.stringify(ddoToPublish))
    const remoteDDO = {
      remote: {
        type: 'ipfs',
        hash: ipfsCID
      }
    }
    const stringDDO = JSON.stringify(remoteDDO)
    const bytes = Buffer.from(stringDDO)
    const metadata = hexlify(bytes)
    // create metadata hash using the original DDO
    const utf8Bytes = toUtf8Bytes(JSON.stringify(ddoToPublish))
    const hash = create256Hash(hexlify(utf8Bytes).toString())

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x01',
      metadata,
      hash,
      []
    )
    setMetaDataTxReceipt = await setMetaDataTx.wait()
    assert(setMetaDataTxReceipt, 'set metada failed')
  })

  it('should store the ddo in the database and return it ', async () => {
    const did = makeDid(getAddress(nftAddress), chainId.toString(10))
    resolvedDDO = await waitToIndex(did, EVENTS.METADATA_CREATED)
    expect(resolvedDDO.ddo.id).to.equal(did)
  })
  after(() => {
    tearDownEnvironment(previousConfiguration)
  })
})
