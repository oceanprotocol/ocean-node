import { expect } from 'chai'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { getConfiguration, loadConfigFromFile } from '../../utils/config.js'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_PATH,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import {
  DEFAULT_DB_INIT_MAX_ATTEMPTS,
  DEFAULT_DB_INIT_MAX_RETRY_DELAY,
  DEFAULT_DB_INIT_RETRY_DELAY
} from '../../utils/config/constants.js'

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

describe('Should validate database init retry configuration', () => {
  const DB_ENV_VARS = [ENVIRONMENT_VARIABLES.DB_TYPE, ENVIRONMENT_VARIABLES.DB_URL]
  const DB_ENV_VALUES = ['typesense', 'http://localhost:8108/?apiKey=xyz']

  // returns the config built with the given DB_INIT_* values, or the thrown error
  async function configWith(values: {
    attempts?: string
    delay?: string
    maxDelay?: string
  }): Promise<{ config?: OceanNodeConfig; error?: Error }> {
    const envVars = [...DB_ENV_VARS]
    const envValues = [...DB_ENV_VALUES]
    if (values.attempts !== undefined) {
      envVars.push(ENVIRONMENT_VARIABLES.DB_INIT_MAX_ATTEMPTS)
      envValues.push(values.attempts)
    }
    if (values.delay !== undefined) {
      envVars.push(ENVIRONMENT_VARIABLES.DB_INIT_RETRY_DELAY)
      envValues.push(values.delay)
    }
    if (values.maxDelay !== undefined) {
      envVars.push(ENVIRONMENT_VARIABLES.DB_INIT_MAX_RETRY_DELAY)
      envValues.push(values.maxDelay)
    }
    // setupEnvironment() reloads the configuration itself, so an invalid value already throws
    // there — it must be inside the try. The override array records the original values as it
    // goes, so it is still usable for the teardown after a throw.
    const overrides = buildEnvOverrideConfig(envVars, envValues)
    try {
      await setupEnvironment(TEST_ENV_CONFIG_PATH, overrides)
      return { config: await getConfiguration(true) }
    } catch (error) {
      return { error }
    } finally {
      await tearDownEnvironment(overrides)
    }
  }

  it('should apply the documented defaults when the variables are not set', async () => {
    const { config: conf, error } = await configWith({})
    expect(error).to.be.equal(undefined)
    expect(conf.dbInitMaxAttempts).to.be.equal(DEFAULT_DB_INIT_MAX_ATTEMPTS)
    expect(conf.dbInitRetryDelay).to.be.equal(DEFAULT_DB_INIT_RETRY_DELAY)
    expect(conf.dbInitMaxRetryDelay).to.be.equal(DEFAULT_DB_INIT_MAX_RETRY_DELAY)
  })

  it('should coerce the environment variables to numbers', async () => {
    const { config: conf, error } = await configWith({
      attempts: '3',
      delay: '500',
      maxDelay: '5000'
    })
    expect(error).to.be.equal(undefined)
    expect(conf.dbInitMaxAttempts).to.be.equal(3)
    expect(conf.dbInitRetryDelay).to.be.equal(500)
    expect(conf.dbInitMaxRetryDelay).to.be.equal(5000)
  })

  // 0 attempts would never enter the retry loop, so Database.init() would not be called at
  // all and the node would silently boot without any database
  it('should refuse to start when the number of attempts is zero or negative', async () => {
    for (const attempts of ['0', '-1']) {
      const { config: conf, error } = await configWith({ attempts })
      expect(conf, `attempts=${attempts} should not produce a config`).to.be.equal(
        undefined
      )
      expect(error?.message).to.be.equal('Configuration validation failed')
    }
  })

  it('should refuse to start on a non-numeric value', async () => {
    const { config: conf, error } = await configWith({ attempts: 'abc' })
    expect(conf).to.be.equal(undefined)
    expect(error?.message).to.be.equal('Configuration validation failed')
  })

  it('should refuse to start when a delay is zero', async () => {
    const { config: conf, error } = await configWith({ delay: '0' })
    expect(conf).to.be.equal(undefined)
    expect(error?.message).to.be.equal('Configuration validation failed')
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
