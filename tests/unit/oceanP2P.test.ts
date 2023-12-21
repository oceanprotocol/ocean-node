import { assert } from 'chai'
import { Database } from '../../components/database/index.js'
import { getConfig } from '../../utils/config.js'
import { OceanP2P } from '../../components/P2P/index.js'

describe('OceanP2P Test', () => {
  it('Start instance of OceanP2P', async () => {
    const config = await getConfig()
    const db = await new Database(config.dbConfig)
    const p2pNode = new OceanP2P(config, db)
    assert(p2pNode, 'Failed to create P2P Node instance')
  })
  it('Start instance of OceanP2P without a database', async () => {
    const config = await getConfig()
    const p2pNode = new OceanP2P(config)
    assert(p2pNode, 'Failed to create P2P Node instance')
  })
  it('Start instance of OceanP2P without a database URL', async () => {
    const config = await getConfig()
    const p2pNode = new OceanP2P(config)
    assert(p2pNode, 'Failed to create P2P Node instance')
  })
})
