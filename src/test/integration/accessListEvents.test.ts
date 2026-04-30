import { expect } from 'chai'
import { JsonRpcProvider, Signer } from 'ethers'
import { homedir } from 'os'
import { Readable } from 'stream'
import AccessListFactory from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessListFactory.sol/AccessListFactory.json' with { type: 'json' }
import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' with { type: 'json' }
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { OceanNode } from '../../OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { getConfiguration } from '../../utils/config.js'
import { streamToString } from '../../utils/util.js'
import {
  buildEnvOverrideConfig,
  DEFAULT_TEST_TIMEOUT,
  getMockSupportedNetworks,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { deployAccessListContract, getContract } from '../utils/contracts.js'
import { waitForCondition } from './testUtils.js'
import {
  GetAccessListHandler,
  SearchAccessListHandler
} from '../../components/core/handler/accessListHandler.js'

describe('**********         AccessList event indexing', function () {
  this.timeout(DEFAULT_TEST_TIMEOUT * 4)

  let database: Database
  let oceanNode: OceanNode
  let provider: JsonRpcProvider
  let owner: Signer
  let factoryAddress: string
  let indexer: OceanIndexer
  const chainId = DEVELOPMENT_CHAIN_ID
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
          JSON.stringify([DEVELOPMENT_CHAIN_ID]),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    const config = await getConfiguration(true)
    database = await Database.init(config.dbConfig)

    const oldIndexer = OceanNode.getInstance(config, database).getIndexer()
    if (oldIndexer) {
      await oldIndexer.stopAllChainIndexers()
    }
    oceanNode = OceanNode.getInstance(
      config,
      database,
      null,
      null,
      null,
      null,
      null,
      true
    )
    let artifactsAddresses = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!artifactsAddresses) {
      artifactsAddresses = getOceanArtifactsAdresses().development
    }
    factoryAddress = artifactsAddresses.AccessListFactory

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    owner = (await provider.getSigner(0)) as Signer

    // Skip historical replay: the hardhat chain accumulates AccessList events
    // across test runs. Pin the indexer to the current head so it only sees
    // events emitted by THIS suite.
    const headBlock = await provider.getBlockNumber()
    await database.indexer.update(chainId, headBlock)

    indexer = new OceanIndexer(database, config, oceanNode.blockchainRegistry)
    oceanNode.addIndexer(indexer)
  })

  after(async () => {
    if (oceanNode) await oceanNode.tearDownAll()
    await tearDownEnvironment(previousConfiguration)
  })

  it('factory deploy with no initial users creates an indexed document', async () => {
    const deployedAddr = await deployAccessListContract(
      owner,
      factoryAddress,
      AccessListFactory.abi,
      'EmptyList',
      'EMPTY',
      false,
      await owner.getAddress(),
      [],
      []
    )
    expect(deployedAddr, 'deployment failed').to.be.a('string')

    const doc: any = await waitForCondition(async () => {
      return await database.accessList.retrieve(chainId, deployedAddr!)
    }, DEFAULT_TEST_TIMEOUT * 2)

    expect(doc, 'document was not indexed in time').to.not.equal(null)
    expect(doc.contractAddress).to.equal(deployedAddr!.toLowerCase())
    expect(doc.factoryDeployed).to.equal(true)
    expect(doc.transferable).to.equal(false)
    expect(Array.isArray(doc.users)).to.equal(true)
    expect(doc.users.length).to.equal(0)
  })

  it('factory deploy with initial users records every AddressAdded', async () => {
    const wallets = [
      await (await provider.getSigner(2)).getAddress(),
      await (await provider.getSigner(3)).getAddress(),
      await (await provider.getSigner(4)).getAddress()
    ]
    const tokenURIs = wallets.map(() => 'https://oceanprotocol.com/nft/')
    const deployedAddr = await deployAccessListContract(
      owner,
      factoryAddress,
      AccessListFactory.abi,
      'PrefilledList',
      'PRE',
      false,
      await owner.getAddress(),
      wallets,
      tokenURIs
    )
    expect(deployedAddr, 'deployment failed').to.be.a('string')

    const doc: any = await waitForCondition(async () => {
      const d = await database.accessList.retrieve(chainId, deployedAddr!)
      return d && d.users && d.users.length === wallets.length ? d : null
    }, DEFAULT_TEST_TIMEOUT * 3)
    expect(doc, 'doc with all initial users not indexed in time').to.not.equal(null)

    const indexedWallets = doc.users.map((u: any) => u.wallet)
    for (const w of wallets) {
      expect(indexedWallets).to.include(w.toLowerCase())
    }
    for (const u of doc.users) {
      expect(u.tokenId).to.be.a('number')
      expect(u.block).to.be.a('number').and.greaterThan(0)
      expect(u.txId).to.be.a('string')
    }
  })

  it('mint adds a user; burn removes by tokenId', async () => {
    const deployedAddr = await deployAccessListContract(
      owner,
      factoryAddress,
      AccessListFactory.abi,
      'MutableList',
      'MUT',
      false,
      await owner.getAddress(),
      [],
      []
    )
    expect(deployedAddr).to.be.a('string')

    await waitForCondition(async () => {
      return await database.accessList.retrieve(chainId, deployedAddr!)
    }, DEFAULT_TEST_TIMEOUT * 2)

    const accessListContract = getContract(deployedAddr!, AccessList.abi, owner)
    const newWalletSigner = await provider.getSigner(5)
    const newWallet = await newWalletSigner.getAddress()

    const mintTx = await accessListContract.mint(newWallet, 'https://example/nft')
    await mintTx.wait()

    const docAfterMint: any = await waitForCondition(async () => {
      const d: any = await database.accessList.retrieve(chainId, deployedAddr!)
      return d && d.users.some((u: any) => u.wallet === newWallet.toLowerCase())
        ? d
        : null
    }, DEFAULT_TEST_TIMEOUT * 2)
    expect(docAfterMint).to.not.equal(null)
    const minted = docAfterMint.users.find(
      (u: any) => u.wallet === newWallet.toLowerCase()
    )
    expect(minted).to.not.equal(undefined)
    const { tokenId } = minted

    const burnTx = await accessListContract.burn(tokenId)
    await burnTx.wait()

    const docAfterBurn: any = await waitForCondition(async () => {
      const d: any = await database.accessList.retrieve(chainId, deployedAddr!)
      return d && !d.users.some((u: any) => u.tokenId === tokenId) ? d : null
    }, DEFAULT_TEST_TIMEOUT * 2)
    expect(docAfterBurn).to.not.equal(null)
    expect(docAfterBurn.users.some((u: any) => u.tokenId === tokenId)).to.equal(false)
  })

  it('searchByWallet returns AccessLists containing the wallet', async () => {
    const wallet = await (await provider.getSigner(6)).getAddress()
    const deployedAddr = await deployAccessListContract(
      owner,
      factoryAddress,
      AccessListFactory.abi,
      'SearchableList',
      'SCH',
      false,
      await owner.getAddress(),
      [wallet],
      ['https://example/nft']
    )
    expect(deployedAddr).to.be.a('string')

    await waitForCondition(async () => {
      const d: any = await database.accessList.retrieve(chainId, deployedAddr!)
      return d && d.users.length === 1 ? d : null
    }, DEFAULT_TEST_TIMEOUT * 3)

    const results = await database.accessList.searchByWallet(wallet, chainId)
    const matched = results.find(
      (r: any) => r.contractAddress === deployedAddr!.toLowerCase()
    )
    expect(matched, 'wallet not found in any access list').to.not.equal(null)
  })

  it('addUser is idempotent when the same tokenId is replayed', async () => {
    const deployedAddr = await deployAccessListContract(
      owner,
      factoryAddress,
      AccessListFactory.abi,
      'IdempotentList',
      'IDM',
      false,
      await owner.getAddress(),
      [],
      []
    )
    expect(deployedAddr).to.be.a('string')

    await waitForCondition(async () => {
      return await database.accessList.retrieve(chainId, deployedAddr!)
    }, DEFAULT_TEST_TIMEOUT * 2)

    const sameUser = {
      wallet: '0x' + 'a'.repeat(40),
      tokenId: 999,
      block: 1,
      txId: '0xdeadbeef'
    }

    await database.accessList.addUser(chainId, deployedAddr!, sameUser)
    await database.accessList.addUser(chainId, deployedAddr!, sameUser)

    const doc: any = await database.accessList.retrieve(chainId, deployedAddr!)
    const matches = doc.users.filter((u: any) => u.tokenId === sameUser.tokenId)
    expect(matches.length).to.equal(1)
  })

  it('transferable: true is recorded on the doc', async () => {
    const deployedAddr = await deployAccessListContract(
      owner,
      factoryAddress,
      AccessListFactory.abi,
      'TransferableList',
      'TRF',
      true,
      await owner.getAddress(),
      [],
      []
    )
    expect(deployedAddr).to.be.a('string')

    const doc: any = await waitForCondition(async () => {
      return await database.accessList.retrieve(chainId, deployedAddr!)
    }, DEFAULT_TEST_TIMEOUT * 2)
    expect(doc).to.not.equal(null)
    expect(doc.transferable).to.equal(true)
  })

  it('lastIndexedBlock advances after access list events', async () => {
    const before = await database.indexer.retrieve(chainId)
    const beforeBlock = before?.lastIndexedBlock ?? 0

    const deployedAddr = await deployAccessListContract(
      owner,
      factoryAddress,
      AccessListFactory.abi,
      'CursorList',
      'CUR',
      false,
      await owner.getAddress(),
      [],
      []
    )
    expect(deployedAddr).to.be.a('string')

    await waitForCondition(async () => {
      return await database.accessList.retrieve(chainId, deployedAddr!)
    }, DEFAULT_TEST_TIMEOUT * 2)

    const after = await waitForCondition(async () => {
      const cur = await database.indexer.retrieve(chainId)
      return cur && cur.lastIndexedBlock > beforeBlock ? cur : null
    }, DEFAULT_TEST_TIMEOUT * 2)
    expect(after, 'indexer cursor did not advance').to.not.equal(null)
    expect(after.lastIndexedBlock).to.be.greaterThan(beforeBlock)
  })

  it('GetAccessListHandler returns the indexed doc', async () => {
    const deployedAddr = await deployAccessListContract(
      owner,
      factoryAddress,
      AccessListFactory.abi,
      'HandlerGetList',
      'HGET',
      false,
      await owner.getAddress(),
      [],
      []
    )
    expect(deployedAddr).to.be.a('string')

    await waitForCondition(async () => {
      return await database.accessList.retrieve(chainId, deployedAddr!)
    }, DEFAULT_TEST_TIMEOUT * 2)

    const result = await new GetAccessListHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.GET_ACCESS_LIST,
      chainId,
      contractAddress: deployedAddr!
    })
    expect(result.status.httpStatus).to.equal(200)
    expect(result.stream).to.not.equal(null)
    const doc = JSON.parse(await streamToString(result.stream as Readable))
    expect(doc.contractAddress).to.equal(deployedAddr!.toLowerCase())
    expect(doc.factoryDeployed).to.equal(true)
  })

  it('GetAccessListHandler returns 404 for an unknown contract', async () => {
    const result = await new GetAccessListHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.GET_ACCESS_LIST,
      chainId,
      contractAddress: '0x' + 'd'.repeat(40)
    })
    expect(result.status.httpStatus).to.equal(404)
    expect(result.stream).to.equal(null)
  })

  it('SearchAccessListHandler without chainId returns matches across all chains', async () => {
    const wallet = await (await provider.getSigner(9)).getAddress()
    const deployedAddr = await deployAccessListContract(
      owner,
      factoryAddress,
      AccessListFactory.abi,
      'CrossChainList',
      'CCL',
      false,
      await owner.getAddress(),
      [wallet],
      ['https://example/nft']
    )
    expect(deployedAddr).to.be.a('string')

    await waitForCondition(async () => {
      const d: any = await database.accessList.retrieve(chainId, deployedAddr!)
      return d && d.users.length === 1 ? d : null
    }, DEFAULT_TEST_TIMEOUT * 3)

    const result = await new SearchAccessListHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.SEARCH_ACCESS_LIST,
      wallet
    })
    expect(result.status.httpStatus).to.equal(200)
    const docs = JSON.parse(await streamToString(result.stream as Readable))
    expect(Array.isArray(docs)).to.equal(true)
    const matched = docs.find(
      (d: any) => d.contractAddress === deployedAddr!.toLowerCase()
    )
    expect(matched, 'wallet not found via cross-chain handler').to.not.equal(undefined)
  })

  it('SearchAccessListHandler returns docs containing a wallet', async () => {
    const wallet = await (await provider.getSigner(8)).getAddress()
    const deployedAddr = await deployAccessListContract(
      owner,
      factoryAddress,
      AccessListFactory.abi,
      'HandlerSearchList',
      'HSRC',
      false,
      await owner.getAddress(),
      [wallet],
      ['https://example/nft']
    )
    expect(deployedAddr).to.be.a('string')

    await waitForCondition(async () => {
      const d: any = await database.accessList.retrieve(chainId, deployedAddr!)
      return d && d.users.length === 1 ? d : null
    }, DEFAULT_TEST_TIMEOUT * 3)

    const result = await new SearchAccessListHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.SEARCH_ACCESS_LIST,
      wallet,
      chainId
    })
    expect(result.status.httpStatus).to.equal(200)
    const docs = JSON.parse(await streamToString(result.stream as Readable))
    expect(Array.isArray(docs)).to.equal(true)
    const matched = docs.find(
      (d: any) => d.contractAddress === deployedAddr!.toLowerCase()
    )
    expect(matched, 'wallet not found via handler').to.not.equal(undefined)
  })
})
