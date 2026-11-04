import {
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  // DEFAULT_MAX_CONNECTIONS_PER_MINUTE,
  ENVIRONMENT_VARIABLES,
  PROTOCOL_COMMANDS,
  getConfiguration,
  CONNECTION_HISTORY_DELETE_THRESHOLD,
  CONNECTIONS_RATE_INTERVAL
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
import { KeyManager } from '../../components/KeyManager/index.js'
import { OceanP2P } from '../../components/P2P/index.js'

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
    const keyManager = new KeyManager(config)
    const p2pNode = new OceanP2P(config, keyManager)
    await p2pNode.start()

    node = OceanNode.getInstance(config, null, p2pNode, null, null, null, null, true)
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
    const statusHandler: StatusHandler = node
      .getP2PNode()
      .getCoreHandlers()
      .getHandler(PROTOCOL_COMMANDS.STATUS)

    const rate = await statusHandler.checkRateLimit('127.0.0.2')
    const rateLimitResponses = []
    expect(rate).to.be.equal(true)
    for (let i = 0; i < 4; i++) {
      // 4 responses, at least one should be blocked
      const rateResp = await statusHandler.checkRateLimit('127.0.0.2')
      rateLimitResponses.push(rateResp)
    }
    const filtered = rateLimitResponses.filter((r) => r === false)
    expect(filtered.length).to.be.gte(1)
  })

  it('Test rate limit per IP, on handler, different IPs', async () => {
    // need to set it here, on a running node is done at request/middleware level
    // none will be blocked, since its always another caller
    const ips = ['127.0.0.3', '127.0.0.4', '127.0.0.5', '127.0.0.6']
    const rateLimitResponses = []
    const statusHandler: StatusHandler = node
      .getP2PNode()
      .getCoreHandlers()
      .getHandler(PROTOCOL_COMMANDS.STATUS)

    for (let i = 0; i < ips.length; i++) {
      const rateResp = await statusHandler.checkRateLimit(ips[i])
      rateLimitResponses.push(rateResp)
    }
    const filtered = rateLimitResponses.filter((r) => r === true)
    // should have 4 valid responses
    expect(filtered.length).to.be.equal(ips.length)
  })

  it('handler window is ~60s, not ~17ms (MAX_REQ_PER_MINUTE actually enforced)', () => {
    // Regression for ON-08: the old `(Δms / 1000) * 60` arithmetic reset the "1 minute" window
    // after ~17ms, so MAX_REQ_PER_MINUTE was effectively unenforced. Drive checkRequestData with
    // controlled timestamps to prove the window is a real 60s and the limit trips.
    const statusHandler: StatusHandler = node
      .getP2PNode()
      .getCoreHandlers()
      .getHandler(PROTOCOL_COMMANDS.STATUS)
    const requestMap = node.getRequestMap()
    const caller = 'window-test-caller'
    const ratePerMinute = 3
    const t0 = 1_000_000
    requestMap.set(caller, { requester: caller, lastRequestTime: t0, numRequests: 1 })

    // 20ms later: well past the old buggy ~17ms reset, but far inside a real 60s window. Must
    // count as the SAME window (numRequests -> 2), NOT reset to 1.
    const r1 = statusHandler.checkRequestData(caller, t0 + 20, ratePerMinute)
    expect(r1.updatedRequestData.numRequests).to.equal(2)
    expect(r1.valid).to.equal(true)

    // another request ~1s later, still the same window -> 3, still within the limit
    const r2 = statusHandler.checkRequestData(caller, t0 + 1000, ratePerMinute)
    expect(r2.updatedRequestData.numRequests).to.equal(3)
    expect(r2.valid).to.equal(true)

    // 4th request within the window exceeds ratePerMinute -> invalid (limit is enforced)
    const r3 = statusHandler.checkRequestData(caller, t0 + 2000, ratePerMinute)
    expect(r3.updatedRequestData.numRequests).to.equal(4)
    expect(r3.valid).to.equal(false)

    // past the 60s window boundary: counter resets to 1 and the request is valid again
    const r4 = statusHandler.checkRequestData(
      caller,
      t0 + CONNECTIONS_RATE_INTERVAL + 1,
      ratePerMinute
    )
    expect(r4.updatedRequestData.numRequests).to.equal(1)
    expect(r4.valid).to.equal(true)

    requestMap.delete(caller)
  })

  it('evicts stale/oldest and does NOT wipe an active caller on flood (handler level)', async function () {
    // Regression for ON-08: the old code cleared the WHOLE map at the threshold, so an attacker
    // could reset everyone's counters by sending CONNECTION_HISTORY_DELETE_THRESHOLD distinct
    // callers. The new eviction keeps the map bounded WITHOUT wiping live counters.
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const statusHandler: StatusHandler = node
      .getP2PNode()
      .getCoreHandlers()
      .getHandler(PROTOCOL_COMMANDS.STATUS)
    const requestMap = node.getRequestMap()

    // An established, actively-rate-limited caller: a PAST window start (realistic — an attacker
    // floods AFTER the victim's traffic, so the victim is NOT the newest entry) and a high request
    // count. Eviction must keep it precisely because it is active (high numRequests), not because
    // it happens to be recent. A future/newest timestamp would make this test pass trivially and
    // prove nothing, which is the bug this rewrite fixes.
    const victim = 'victim-active-caller'
    const victimCount = 10
    requestMap.set(victim, {
      requester: victim,
      lastRequestTime: Date.now() - 1000, // within the 60s window, but older than the flood
      numRequests: victimCount
    })

    // Flood with well over the hard cap of DISTINCT callers, each sending a single request
    // (numRequests = 1) at ~now — i.e. newer than the victim. Under the old age-based eviction the
    // victim (oldest window start) would be evicted; under count-based eviction the singletons go
    // first and the victim survives.
    const aboveLimit = 20
    for (let i = 0; i < CONNECTION_HISTORY_DELETE_THRESHOLD + aboveLimit; i++) {
      await statusHandler.checkRateLimit(`flood-caller-${i}`)
    }

    // Map stays bounded by the hard cap (NOT cleared to ~0, NOT grown unbounded).
    expect(node.getRequestMapSize()).to.be.lessThanOrEqual(
      CONNECTION_HISTORY_DELETE_THRESHOLD
    )
    // The active caller survived the flood AND its counter was not reset.
    const stillThere = requestMap.get(victim)
    expect(stillThere, 'active caller must survive the flood').to.not.equal(undefined)
    expect(stillThere.numRequests).to.equal(victimCount)

    requestMap.delete(victim)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
