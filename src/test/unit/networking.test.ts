import { ENVIRONMENT_VARIABLES, getConfiguration } from '../../utils/index.js'
import { expect } from 'chai'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

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
        [JSON.stringify(['p2p'])]
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
        [JSON.stringify(['http'])]
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

// describe('Test rate limitations and blacklist', () => {
//   new
// })
