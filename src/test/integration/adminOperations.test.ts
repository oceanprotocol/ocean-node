import { assert } from 'chai'
import {
  JsonRpcProvider,
  JsonRpcSigner,
  Signer,
  sha256,
  toUtf8Bytes,
  getBytes
} from 'ethers'
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { OceanNode } from '../../OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'
import { downloadAsset } from '../data/assets.js'
import { publishAsset } from '../utils/assets.js'
// import { waitToIndex } from './testUtils.js'
import {
  //   DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

import {
  //   EVENTS,
  ENVIRONMENT_VARIABLES,
  PROTOCOL_COMMANDS,
  getConfiguration
} from '../../utils/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import {
  ReindexChainCommand,
  ReindexTxCommand,
  StopNodeCommand
} from '../../@types/commands.js'
import {
  ReindexChainHandler,
  ReindexTxHandler,
  StopNodeHandler
} from '../../components/core/adminOperations.js'

describe('Should run a complete node flow.', () => {
  let config: OceanNodeConfig
  let oceanNode: OceanNode
  //   let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let publisherAccount: Signer
  let consumerAccount: Signer
  let consumerAddress: string
  let publishedDataset: any
  const currentDate = new Date()
  const expiryTimestamp = new Date(
    currentDate.getFullYear() + 1,
    currentDate.getMonth(),
    currentDate.getDate()
  ).getTime()

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
          ENVIRONMENT_VARIABLES.DB_URL,
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS,
          ENVIRONMENT_VARIABLES.ALLOWED_ADMINS
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          'http://localhost:8108/?apiKey=xyz',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260'])
        ]
      )
    )

    config = await getConfiguration(true) // Force reload the configuration
    const dbconn = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(dbconn)
    //  eslint-disable-next-line no-unused-vars
    const indexer = new OceanIndexer(dbconn, mockSupportedNetworks)

    let network = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!network) {
      network = getOceanArtifactsAdresses().development
    }

    provider = new JsonRpcProvider('http://127.0.0.1:8545')

    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
    consumerAddress = await consumerAccount.getAddress()
  })

  async function getSignature() {
    const message = sha256(toUtf8Bytes(expiryTimestamp.toString()))
    // signing method for ganache
    const jsonRpcSigner = new JsonRpcSigner(provider, await publisherAccount.getAddress())
    console.log(`json rpc signer: ${await jsonRpcSigner.getAddress()}`)
    return await jsonRpcSigner._legacySignMessage(getBytes(message))
  }

  it('validation should pass for stop node command', async () => {
    console.log(`consumer addr: ${consumerAddress}`)
    console.log(`publisher addr: ${await publisherAccount.getAddress()}`)

    // Sign the original message directly
    const signature = await getSignature()

    console.log(`signature: ${signature}`)

    const stopNodeCommand: StopNodeCommand = {
      command: PROTOCOL_COMMANDS.REINDEX_CHAIN,
      node: config.keys.peerId.toString(),
      expiryTimestamp,
      signature
    }
    const validationResponse = new StopNodeHandler(oceanNode).validate(stopNodeCommand)
    console.log(`validation resp for stop node handler: ${validationResponse}`)
    assert(validationResponse, 'invalid stop node validation response')
    assert(validationResponse.valid === true, 'validation for stop node command failed')
  })

  it('should publish compute datasets & algos', async () => {
    publishedDataset = await publishAsset(downloadAsset, publisherAccount)
  })

  it('should pass for reindex tx command', async () => {
    console.log(`consumer addr: ${consumerAddress}`)
    console.log(`publisher addr: ${await publisherAccount.getAddress()}`)
    const signature = await getSignature()

    const reindexTxCommand: ReindexTxCommand = {
      command: PROTOCOL_COMMANDS.REINDEX_CHAIN,
      node: config.keys.peerId.toString(),
      txId: publishedDataset.txReceipt.hash,
      chainId: DEVELOPMENT_CHAIN_ID,
      expiryTimestamp,
      signature
    }
    const reindexTxHandler = new ReindexTxHandler(oceanNode)
    const validationResponse = reindexTxHandler.validate(reindexTxCommand)
    console.log(`validation resp for reindex tx handler: ${validationResponse}`)
    assert(validationResponse, 'invalid reindex tx validation response')
    assert(validationResponse.valid === true, 'validation for reindex tx command failed')

    const handlerResponse = await reindexTxHandler.handle(reindexTxCommand)
    assert(handlerResponse, 'handler resp does not exist')
    assert(handlerResponse.status.httpStatus === 200, 'incorrect http status')
  })

  it('validation should pass for reindex chain command', async () => {
    console.log(`consumer addr: ${consumerAddress}`)
    console.log(`publisher addr: ${await publisherAccount.getAddress()}`)
    const signature = await getSignature()

    const reindexChainCommand: ReindexChainCommand = {
      command: PROTOCOL_COMMANDS.REINDEX_CHAIN,
      node: config.keys.peerId.toString(),
      chainId: DEVELOPMENT_CHAIN_ID,
      expiryTimestamp,
      signature
    }
    const reindexChainHandler = new ReindexChainHandler(oceanNode)
    const validationResponse = reindexChainHandler.validate(reindexChainCommand)
    console.log(`validation resp for reindex chain handler: ${validationResponse}`)
    assert(validationResponse, 'invalid reindex chain validation response')
    assert(
      validationResponse.valid === true,
      'validation for reindex chain command failed'
    )
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})
