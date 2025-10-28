import { expect } from 'chai'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { getConfiguration, loadConfigFromFile } from '../../utils/config.js'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_PATH,
  buildEnvOverrideConfig,
  setupEnvironment
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'

let config: OceanNodeConfig
describe('Should validate configuration from JSON', () => {
  let envOverrides: OverrideEnvConfig[]
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.DB_TYPE, ENVIRONMENT_VARIABLES.DB_URL],
      ['typesense', 'http://localhost:8108/?apiKey=xyz']
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_PATH, envOverrides)
    config = await getConfiguration(true)
  })

  it('should get indexer networks from config', () => {
    expect(Object.keys(config.indexingNetworks).length).to.be.equal(1)
    expect(config.indexingNetworks['8996']).to.not.equal(undefined)
    expect(config.indexingNetworks['8996'].chainId).to.be.equal(8996)
    expect(config.indexingNetworks['8996'].rpc).to.be.equal('http://127.0.0.1:8545')
    expect(config.indexingNetworks['8996'].network).to.be.equal('development')
    expect(config.indexingNetworks['8996'].chunkSize).to.be.equal(100)
  })

  it('should have indexer', () => {
    expect(config.hasIndexer).to.be.equal(true)
    expect(config.dbConfig).to.not.be.equal(null)
    // it is exported in the env vars, so it should overwrite the config.json
    expect(config.dbConfig.dbType).to.be.equal('typesense')
    const configFile = loadConfigFromFile(process.env.CONFIG_PATH)
    expect(config.dbConfig.dbType).to.not.be.equal(configFile.dbConfig.dbType)
    expect(config.dbConfig.url).to.be.equal('http://localhost:8108/?apiKey=xyz')
  })

  it('should have HTTP', () => {
    expect(config.hasHttp).to.be.equal(true)
    expect(config.httpPort).to.be.equal(8001)
  })

  it('should have P2P', () => {
    expect(config.hasP2P).to.be.equal(true)
    expect(config.p2pConfig).to.not.be.equal(null)
    expect(config.p2pConfig.bootstrapNodes).to.not.be.equal(null)
    expect(config.p2pConfig.bootstrapNodes.length).to.be.equal(0)
  })
  it('should have defaults set', () => {
    expect(config.isBootstrap).to.be.equal(false)
    expect(config.validateUnsignedDDO).to.be.equal(true)
  })
  after(() => {
    delete process.env.CONFIG_PATH
    delete process.env.PRIVATE_KEY
  })
})

describe('Should validate P2P config from environment variables', () => {
  let config: OceanNodeConfig
  let envOverrides: OverrideEnvConfig[]

  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [
        ENVIRONMENT_VARIABLES.DB_TYPE,
        ENVIRONMENT_VARIABLES.DB_URL,
        ENVIRONMENT_VARIABLES.P2P_ipV4BindAddress,
        ENVIRONMENT_VARIABLES.P2P_ipV4BindTcpPort,
        ENVIRONMENT_VARIABLES.P2P_ipV6BindAddress,
        ENVIRONMENT_VARIABLES.P2P_MIN_CONNECTIONS,
        ENVIRONMENT_VARIABLES.P2P_MAX_CONNECTIONS
      ],
      [
        'typesense',
        'http://localhost:8108/?apiKey=xyz',
        '127.0.0.1',
        '9999',
        '::2',
        '5',
        '500'
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_PATH, envOverrides)
    config = await getConfiguration(true)
  })

  it('should override P2P config values from environment variables', () => {
    expect(config.p2pConfig).to.not.be.equal(null)
    expect(config.p2pConfig.ipV4BindAddress).to.be.equal('127.0.0.1')
    expect(config.p2pConfig.ipV4BindTcpPort).to.be.equal(9999)
    expect(config.p2pConfig.ipV6BindAddress).to.be.equal('::2')
    expect(config.p2pConfig.minConnections).to.be.equal(5)
    expect(config.p2pConfig.maxConnections).to.be.equal(500)
  })

  it('should maintain non-overridden P2P config values from config.json', () => {
    expect(config.p2pConfig.enableIPV4).to.be.equal(true)
    expect(config.p2pConfig.enableIPV6).to.be.equal(true)
    expect(config.p2pConfig.upnp).to.be.equal(true)
    expect(config.p2pConfig.autoNat).to.be.equal(true)
    expect(config.p2pConfig.bootstrapNodes).to.not.be.equal(null)
  })

  after(() => {
    delete process.env.CONFIG_PATH
    delete process.env.PRIVATE_KEY
    delete process.env[ENVIRONMENT_VARIABLES.P2P_ipV4BindAddress.name]
    delete process.env[ENVIRONMENT_VARIABLES.P2P_ipV4BindTcpPort.name]
    delete process.env[ENVIRONMENT_VARIABLES.P2P_ipV6BindAddress.name]
    delete process.env[ENVIRONMENT_VARIABLES.P2P_MIN_CONNECTIONS.name]
    delete process.env[ENVIRONMENT_VARIABLES.P2P_MAX_CONNECTIONS.name]
  })
})
