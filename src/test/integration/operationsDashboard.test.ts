import { assert } from 'chai'
import { Readable } from 'stream'
import { Signer, JsonRpcProvider, ethers } from 'ethers'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'
import { downloadAsset } from '../data/assets.js'
import { publishAsset } from '../utils/assets.js'
import { homedir } from 'os'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

import {
  ENVIRONMENT_VARIABLES,
  PROTOCOL_COMMANDS,
  getConfiguration
} from '../../utils/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

import { DEVELOPMENT_CHAIN_ID } from '../../utils/address.js'
import {
  AdminReindexChainCommand,
  AdminReindexTxCommand,
  AdminStopNodeCommand
} from '../../@types/commands.js'
import { StopNodeHandler } from '../../components/core/admin/stopNodeHandler.js'
import { ReindexTxHandler } from '../../components/core/admin/reindexTxHandler.js'
import { ReindexChainHandler } from '../../components/core/admin/reindexChainHandler.js'
import { FindDdoHandler } from '../../components/core/handler/ddoHandler.js'
import { streamToObject } from '../../utils/util.js'

describe('Should test admin operations', () => {
  let config: OceanNodeConfig
  let oceanNode: OceanNode
  let publishedDataset: any
  let dbconn: Database
  const currentDate = new Date()
  const expiryTimestamp = new Date(
    currentDate.getFullYear() + 1,
    currentDate.getMonth(),
    currentDate.getDate()
  ).getTime()
  const provider = new JsonRpcProvider('http://127.0.0.1:8545')
  const wallet = new ethers.Wallet(
    '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
    provider
  )

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
          ENVIRONMENT_VARIABLES.ALLOWED_ADMINS,
          ENVIRONMENT_VARIABLES.ADDRESS_FILE
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          'http://localhost:8108/?apiKey=xyz',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          JSON.stringify([await wallet.getAddress()]),
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    config = await getConfiguration(true) // Force reload the configuration
    dbconn = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(dbconn)
  })

  async function getSignature(message: string) {
    return await wallet.signMessage(message)
  }

  it('validation should pass for stop node command', async () => {
    const signature = await getSignature(expiryTimestamp.toString())

    const stopNodeCommand: AdminStopNodeCommand = {
      command: PROTOCOL_COMMANDS.STOP_NODE,
      node: config.keys.peerId.toString(),
      expiryTimestamp,
      signature
    }
    const validationResponse = new StopNodeHandler(oceanNode).validate(stopNodeCommand)
    assert(validationResponse, 'invalid stop node validation response')
    assert(validationResponse.valid === true, 'validation for stop node command failed')
  })

  it('should publish dataset', async () => {
    publishedDataset = await publishAsset(downloadAsset, wallet as Signer)
  })

  it('should pass for reindex tx command', async () => {
    const signature = await getSignature(expiryTimestamp.toString())

    const reindexTxCommand: AdminReindexTxCommand = {
      command: PROTOCOL_COMMANDS.REINDEX_TX,
      node: config.keys.peerId.toString(),
      txId: publishedDataset.trxReceipt.hash,
      chainId: DEVELOPMENT_CHAIN_ID,
      expiryTimestamp,
      signature
    }
    const reindexTxHandler = new ReindexTxHandler(oceanNode)
    const validationResponse = reindexTxHandler.validate(reindexTxCommand)
    assert(validationResponse, 'invalid reindex tx validation response')
    assert(validationResponse.valid === true, 'validation for reindex tx command failed')

    const handlerResponse = await reindexTxHandler.handle(reindexTxCommand)
    assert(handlerResponse, 'handler resp does not exist')
    assert(handlerResponse.status.httpStatus === 200, 'incorrect http status')
    const findDDOTask = {
      command: PROTOCOL_COMMANDS.FIND_DDO,
      id: publishedDataset.ddo.id
    }
    const response = await new FindDdoHandler(oceanNode).handle(findDDOTask)
    const actualDDO = await streamToObject(response.stream as Readable)
    assert(actualDDO[0].id === publishedDataset.ddo.id, 'DDO id not matching')
  })

  it('should pass for reindex chain command', async function () {
    const signature = await getSignature(expiryTimestamp.toString())

    const reindexChainCommand: AdminReindexChainCommand = {
      command: PROTOCOL_COMMANDS.REINDEX_CHAIN,
      node: config.keys.peerId.toString(),
      chainId: DEVELOPMENT_CHAIN_ID,
      expiryTimestamp,
      signature
    }
    const reindexChainHandler = new ReindexChainHandler(oceanNode)
    const validationResponse = reindexChainHandler.validate(reindexChainCommand)
    assert(validationResponse, 'invalid reindex chain validation response')
    assert(
      validationResponse.valid === true,
      'validation for reindex chain command failed'
    )

    const handlerResponse = await reindexChainHandler.handle(reindexChainCommand)
    assert(handlerResponse, 'handler resp does not exist')
    assert(handlerResponse.status.httpStatus === 200, 'incorrect http status')
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})
