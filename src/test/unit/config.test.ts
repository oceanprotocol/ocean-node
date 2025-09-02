import { expect } from 'chai'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { getConfiguration } from '../../utils/config.js'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_PATH,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

let envOverrides: OverrideEnvConfig[]
let config: OceanNodeConfig
describe('Should validate configuration from JSON', () => {
  before(async () => {
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_PATH, envOverrides)
    config = await getConfiguration(true)
  })

  it('should get indexer networks from config', () => {
    console.log(`config: ${JSON.stringify(config)}`)
    expect(Object.keys(config.indexingNetworks).length).to.be.equal(1)
    expect(Object.keys(config.indexingNetworks)[0]).to.be.equal('8996')
  })

  it('should have indexer', () => {
    expect(config.hasIndexer).to.be.equal(true)
    expect(Object.keys(config.indexingNetworks)[0]).to.be.equal('8996')
  })

  it('should have indexer', () => {
    expect(config.hasIndexer).to.be.equal(true)
    expect(config.dbConfig).to.be.not(null)
    expect(config.dbConfig.dbType).to.be.not('elasticsearch')
    expect(config.dbConfig.url).to.be.not('http://localhost:9200')
  })

  it('should have HTTP', () => {
    expect(config.hasHttp).to.be.equal(true)
    expect(config.httpPort).to.be.equal(8081)
    expect(config.httpPort).to.be.instanceOf(Number)
  })

  it('should have P2P', () => {
    const bootstrapNodes = [
      '/dns4/node1.oceanprotocol.com/tcp/9000/p2p/16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP',
      '/dns4/node1.oceanprotocol.com/tcp/9001/ws/p2p/16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP',
      '/dns6/node1.oceanprotocol.com/tcp/9002/p2p/16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP',
      '/dns6/node1.oceanprotocol.com/tcp/9003/ws/p2p/16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP',
      '/dns4/node2.oceanprotocol.com/tcp/9000/p2p/16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4',
      '/dns4/node2.oceanprotocol.com/tcp/9001/ws/p2p/16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4',
      '/dns6/node2.oceanprotocol.com/tcp/9002/p2p/16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4',
      '/dns6/node2.oceanprotocol.com/tcp/9003/ws/p2p/16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4',
      '/dns4/node3.oceanprotocol.com/tcp/9000/p2p/16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U',
      '/dns4/node3.oceanprotocol.com/tcp/9001/ws/p2p/16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U',
      '/dns6/node3.oceanprotocol.com/tcp/9002/p2p/16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U',
      '/dns6/node3.oceanprotocol.com/tcp/9003/ws/p2p/16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U',
      '/dns4/node4.oceanprotocol.com/tcp/9000/p2p/16Uiu2HAmSTVTArioKm2wVcyeASHYEsnx2ZNq467Z4GMDU4ErEPom',
      '/dns4/node4.oceanprotocol.com/tcp/9001/ws/p2p/16Uiu2HAmSTVTArioKm2wVcyeASHYEsnx2ZNq467Z4GMDU4ErEPom',
      '/dns6/node4.oceanprotocol.com/tcp/9002/p2p/16Uiu2HAmSTVTArioKm2wVcyeASHYEsnx2ZNq467Z4GMDU4ErEPom',
      '/dns6/node4.oceanprotocol.com/tcp/9003/ws/p2p/16Uiu2HAmSTVTArioKm2wVcyeASHYEsnx2ZNq467Z4GMDU4ErEPom'
    ]
    expect(config.hasP2P).to.be.equal(true)
    expect(config.p2pConfig).to.be.not(null)
    expect(config.p2pConfig.bootstrapNodes).to.be.not(null)
    expect(config.p2pConfig.bootstrapNodes.length).to.be.not('0')
    expect(config.p2pConfig.bootstrapNodes).to.be.equal(bootstrapNodes)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
