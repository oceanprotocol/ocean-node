import { assert } from 'chai'
import { Database } from '../../components/database/index.js'
import { getConfig } from '../../utils/config.js'
import { OceanP2P } from '../../components/P2P/index.js'
import { OceanNodeConfig } from '../../@types'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../utils/index.js'
import {
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

function getEnvOverrides(): OverrideEnvConfig[] {
  return [
    {
      name: ENVIRONMENT_VARIABLES.DB_URL.name,
      newValue: '',
      override: true,
      originalValue: ENVIRONMENT_VARIABLES.DB_URL.value
    }
  ]
}

describe('OceanP2P Test', () => {
  it('Start instance of OceanP2P', async () => {
    const config = await getConfig()
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    const db = await new Database(dbConfig)
    const p2pNode = new OceanP2P(config, db)
    assert(p2pNode, 'Failed to create P2P Node instance')
  })
  it('Start instance of OceanP2P without a database', async () => {
    const config = await getConfig()
    const p2pNode = new OceanP2P(config)
    assert(p2pNode, 'Failed to create P2P Node instance')
  })
})

describe('OceanP2P Test without DB_URL set', () => {
  let originalDBURL: string | undefined

  before(async () => {
    originalDBURL = process.env.DB_URL
    process.env.DB_URL = ''
  })
  it('Start instance of OceanP2P without a database URL', async () => {
    const config = await getConfig()
    assert(config.dbConfig.url === '', 'DB URL should not be set')
    const p2pNode = new OceanP2P(config)
    assert(p2pNode, 'Failed to create P2P Node instance')
    const p2pConfig = p2pNode.getConfig()
    assert(p2pConfig, 'Failed to get P2P Node config')
    assert(p2pConfig.dbConfig.url === '', 'P2P Node config should not have DB URL set')
    assert(p2pConfig.hasIndexer === false, 'P2P Node should not have indexer enabled')
    assert(p2pConfig.hasProvider === false, 'P2P Node should not have provider enabled')
  })
  after(async () => {
    process.env.DB_URL = originalDBURL
  })
})
