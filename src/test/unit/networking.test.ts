import {
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  // DEFAULT_MAX_CONNECTIONS_PER_MINUTE,
  ENVIRONMENT_VARIABLES,
  PROTOCOL_COMMANDS,
  getConfiguration,
  CONNECTION_HISTORY_DELETE_THRESHOLD
} from '../../utils/index.js'
import { expect } from 'chai'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { OceanNode } from '../../OceanNode.js'
import { StatusHandler } from '../../components/core/handler/statusHandler.js'
import { CoreHandlersRegistry } from '../../components/core/handler/coreHandlersRegistry.js'

let envOverrides: OverrideEnvConfig[]

describe('Test available network interfaces', () => {
  before(async () => {
    envOverrides = buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.INTERFACES], ['ftp']) // put wrong stuff on purpose
    await setupEnvironment(null, envOverrides)
  })
  // because of this
  it('should exist both interfaces by default, or respect config', async () => {
    const envSet = process.env.INTERFACES
    const config = await getConfiguration(true)
    const { hasP2P, hasHttp } = config
    if (!envSet) {
      expect(hasP2P).to.be.equal(true)
      expect(hasHttp).to.be.equal(true)
    } else {
      try {
        let interfaces = JSON.parse(envSet) as string[]
        interfaces = interfaces.map((iface: string) => {
          return iface.toUpperCase()
        })
        interfaces.includes('HTTP')
          ? expect(hasHttp).to.be.equal(true)
          : expect(hasHttp).to.be.equal(false)

        interfaces.includes('P2P')
          ? expect(hasP2P).to.be.equal(true)
          : expect(hasP2P).to.be.equal(false)
      } catch (ex) {} // just ignore it
    }
  })

  // some additional checks to try other values
  it('should exist both interfaces with empty array', async () => {
    const before = await setupEnvironment(
      null,
      buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.INTERFACES], ['[]'])
    )
    const { hasP2P, hasHttp } = await getConfiguration(true)
    const interfaces = JSON.parse(process.env.INTERFACES) as string[]
    // 0 from the env
    expect(interfaces).to.be.length(0, 'interfaces should be empty')
    // 2 from the config
    expect(hasP2P).to.be.equal(true)
    expect(hasHttp).to.be.equal(true)
    tearDownEnvironment(before)
  })

  it('should exist only P2P interface', async () => {
    const before = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [ENVIRONMENT_VARIABLES.INTERFACES],
        [JSON.stringify(['P2P'])]
      )
    )
    const interfaces = JSON.parse(process.env.INTERFACES) as string[]
    expect(interfaces).to.be.length(1, 'available interface should be only p2p')
    const { hasP2P, hasHttp } = await getConfiguration(true)
    expect(hasP2P).to.be.equal(true)
    expect(hasHttp).to.be.equal(false)
    tearDownEnvironment(before)
  })

  it('should exist both interfaces with empty array', async () => {
    const before = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [ENVIRONMENT_VARIABLES.INTERFACES],
        [JSON.stringify(['HTTP'])]
      )
    )
    const interfaces = JSON.parse(process.env.INTERFACES) as string[]
    expect(interfaces).to.be.length(1, 'available interface should be only http')
    const { hasP2P, hasHttp } = await getConfiguration(true)
    expect(hasP2P).to.be.equal(false)
    expect(hasHttp).to.be.equal(true)
    tearDownEnvironment(before)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})

describe('Test rate limitations and deny list defaults', () => {
  // To make sure we do not forget to register anything on supported commands
  // const node: OceanNode = OceanNode.getInstance()
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.RATE_DENY_LIST, ENVIRONMENT_VARIABLES.MAX_REQ_PER_MINUTE],
      [undefined, undefined]
    )
    await setupEnvironment(null, envOverrides)
  })

  it('should check that configuration has some defaults', async () => {
    const config = await getConfiguration(true)
    expect(config.denyList.ips).to.be.length(0)
    expect(config.denyList.peers).to.be.length(0)
    expect(config.rateLimit).to.be.equal(DEFAULT_RATE_LIMIT_PER_MINUTE)
  })

  // put it back
  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})

describe('Test rate limitations and deny list settings', () => {
  let node: OceanNode
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [
        ENVIRONMENT_VARIABLES.PRIVATE_KEY,
        ENVIRONMENT_VARIABLES.RATE_DENY_LIST,
        ENVIRONMENT_VARIABLES.MAX_REQ_PER_MINUTE
      ],
      [
        '0xcb345bd2b11264d523ddaf383094e2675c420a17511c3102a53817f13474a7ff',
        JSON.stringify({
          peers: ['16Uiu2HAm7YHuXeBpoFoKHyAieKDAsdg3RNmCUEVgNxffByRS7Hdt'], // node 2
          ips: ['127.0.0.1']
        }),
        3
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    const config = await getConfiguration(true)
    node = OceanNode.getInstance(config)
  })

  it('should read deny list of other peers and ips', async () => {
    // Start instance of node 1
    const config1 = await getConfiguration(true)
    expect(config1.denyList.peers.length).to.be.equal(1)
    expect(config1.denyList.peers[0]).to.be.equal(
      '16Uiu2HAm7YHuXeBpoFoKHyAieKDAsdg3RNmCUEVgNxffByRS7Hdt'
    ) // node 2 id
    expect(config1.denyList.ips.length).to.be.equal(1)
    expect(config1.denyList.ips[0]).to.be.equal('127.0.0.1') // node 2 id
    expect(config1.rateLimit).to.be.equal(3)
  })

  it('Test rate limit per IP, on handler', async () => {
    // need to set it here, on a running node is done at request/middleware level
    node.setRemoteCaller('127.0.0.1')
    const statusHandler: StatusHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.STATUS)

    const rate = await statusHandler.checkRateLimit()
    const rateLimitResponses = []
    expect(rate).to.be.equal(true)
    for (let i = 0; i < 4; i++) {
      // 4 responses, at least one should be blocked
      const rateResp = await statusHandler.checkRateLimit()
      rateLimitResponses.push(rateResp)
    }
    const filtered = rateLimitResponses.filter((r) => r === false)
    expect(filtered.length).to.be.gte(1)
  })

  it('Test rate limit per IP, on handler, different IPs', async () => {
    // need to set it here, on a running node is done at request/middleware level
    // none will be blocked, since its always another caller
    const ips = ['127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5']
    const rateLimitResponses = []
    const statusHandler: StatusHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.STATUS)

    for (let i = 0; i < ips.length; i++) {
      node.setRemoteCaller(ips[i])
      const rateResp = await statusHandler.checkRateLimit()
      rateLimitResponses.push(rateResp)
    }
    const filtered = rateLimitResponses.filter((r) => r === true)
    // should have 4 valid responses
    expect(filtered.length).to.be.equal(ips.length)
  })

  it('Test global rate limit, clear map after MAX (handler level) ', async function () {
    // after more than CONNECTION_HISTORY_DELETE_THRESHOLD connections the map will be cleared
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)
    let originalIPPiece = '127.0.'

    const rateLimitResponses = []

    const statusHandler: StatusHandler = CoreHandlersRegistry.getInstance(
      node
    ).getHandler(PROTOCOL_COMMANDS.STATUS)

    const aboveLimit = 20
    for (let i = 0, x = 0; i < CONNECTION_HISTORY_DELETE_THRESHOLD + aboveLimit; i++) {
      const ip = originalIPPiece + x // start at 127.0.0.2
      node.setRemoteCaller(ip)
      const rateResp = await statusHandler.checkRateLimit()
      rateLimitResponses.push(rateResp)
      x++
      // start back
      if (x > 254) {
        x = 0
        originalIPPiece = '127.0.0.' // next piece
      }
    }
    // it should clear the history after CONNECTION_HISTORY_DELETE_THRESHOLD
    expect(statusHandler.getOceanNode().getRequestMapSize()).to.be.lessThanOrEqual(
      aboveLimit
    )
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
