import { expect } from 'chai'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { getConfiguration } from '../../utils/config.js'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_PATH,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { homedir } from 'os'

let envOverrides: OverrideEnvConfig[]
let config: OceanNodeConfig
describe('Should validate configuration from JSON', () => {
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.CONFIG_PATH],
      [`${homedir}/config.json`]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_PATH, envOverrides)
    config = await getConfiguration(true)
  })

  it('should get indexer networks from config', () => {
    expect(config.indexingNetworks.length).to.be.equal(1)
    expect(config.indexingNetworks[0]).to.be.equal(8996)
    expect(config.supportedNetworks['8996'].chainId).to.be.equal(8996)
    expect(config.supportedNetworks['8996'].rpc).to.be.equal('http://127.0.0.1:8545')
    expect(config.supportedNetworks['8996'].network).to.be.equal('development')
    expect(config.supportedNetworks['8996'].chunkSize).to.be.equal(100)
  })

  it('should have indexer', () => {
    expect(config.hasIndexer).to.be.equal(true)
    expect(config.dbConfig).to.not.be.equal(null)
    expect(config.dbConfig.dbType).to.be.equal('elasticsearch')
    expect(config.dbConfig.url).to.be.equal('http://localhost:9200')
  })

  it('should have HTTP', () => {
    expect(config.hasHttp).to.be.equal(true)
    expect(config.httpPort).to.be.equal(8001)
  })

  it('should have P2P', () => {
    expect(config.hasP2P).to.be.equal(true)
    expect(config.p2pConfig).to.not.be.equal(null)
    expect(config.p2pConfig.bootstrapNodes).to.not.be.equal(null)
    expect(config.p2pConfig.bootstrapNodes.length).to.be.equal('0')
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
