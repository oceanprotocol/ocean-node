import { assert } from 'chai'
import { Database } from '../../src/components/database/index.js'
import { getConfig } from '../../src/utils/config.js'
import { OceanP2P } from '../../src/components/P2P/index.js'

describe('OceanP2P Test', () => {
  it('Start instance of OceanP2P', async () => {
    const config = await getConfig()
    const db = await new Database(config.dbConfig)
    const p2pNode = new OceanP2P(db, config)
    assert(p2pNode, 'Failed to create P2P Node instance')
  })
})
