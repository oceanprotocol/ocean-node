import { expect } from 'chai'
import type { Connection } from '@libp2p/interface'
import { OceanP2P } from '../../../components/P2P/index.js'
import { P2P_TIMEOUT_DEFAULTS, P2P_TIMEOUTS } from '../../../components/P2P/timeouts.js'
import { OceanNodeP2PConfigSchema } from '../../../utils/config/schemas.js'
import { ENVIRONMENT_VARIABLES } from '../../../utils/constants.js'
import {
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment,
  OverrideEnvConfig
} from '../../utils/utils.js'

/**
 * "P2P is enabled" and "P2P can do anything" are different questions, and only the first one was
 * answerable from outside the process.
 *
 * The gate is the DHT routing table, not the connection count. Queries are refused outright
 * against an empty table (`allowQueryWithZeroPeers` is `false`), and a connection to a peer that
 * has not completed identify, or that does not speak the DHT protocol at all, is not a peer a
 * query can start from - so a node can hold connections and still resolve nothing.
 */

function nodeWith(options: {
  routingTableSize?: number
  connections?: number
  dhtMode?: string
}): OceanP2P {
  const services: Record<string, any> = {}
  if (options.routingTableSize !== undefined || options.dhtMode !== undefined) {
    services.dht = {
      routingTable:
        options.routingTableSize === undefined
          ? undefined
          : { size: options.routingTableSize },
      getMode: options.dhtMode === undefined ? undefined : () => options.dhtMode
    }
  }
  return {
    getDhtRoutingTableSize: OceanP2P.prototype.getDhtRoutingTableSize,
    getP2PStatus: OceanP2P.prototype.getP2PStatus,
    _libp2p: {
      services,
      getConnections: (): Connection[] =>
        Array.from({ length: options.connections ?? 0 }, () => ({}) as Connection)
    }
  } as unknown as OceanP2P
}

describe('P2P readiness is gated on the routing table', () => {
  const required = P2P_TIMEOUTS.dhtReadyMinPeers

  it('is not ready with an empty routing table, however many connections there are', () => {
    // The state a freshly started node is in: connected to bootstrap peers, routing table not
    // yet populated, and unable to resolve anything.
    const status = OceanP2P.prototype.getP2PStatus.call(
      nodeWith({ routingTableSize: 0, connections: 12 })
    )

    expect(status.ready).to.equal(false)
    expect(status.routingTablePeers).to.equal(0)
    expect(status.connections, 'connections are reported, but do not decide').to.equal(12)
    expect(status.requiredRoutingTablePeers).to.equal(required)
  })

  it('is not ready one peer below the threshold, and ready at it', () => {
    expect(
      OceanP2P.prototype.getP2PStatus.call(nodeWith({ routingTableSize: required - 1 }))
        .ready
    ).to.equal(false)
    expect(
      OceanP2P.prototype.getP2PStatus.call(nodeWith({ routingTableSize: required })).ready
    ).to.equal(true)
  })

  it('reports not-ready with no count when the DHT service cannot be reached', () => {
    // Not knowing is not the same as knowing the table is empty, and the two have to be
    // distinguishable by whoever reads the endpoint.
    const status = OceanP2P.prototype.getP2PStatus.call(nodeWith({}))
    expect(status.ready).to.equal(false)
    expect(status.routingTablePeers).to.equal(undefined)
  })

  it('surfaces the DHT mode alongside it', () => {
    // kad-dht promotes and demotes itself as reachability changes, so the mode is part of the
    // answer to "can this node serve DHT queries".
    const status = OceanP2P.prototype.getP2PStatus.call(
      nodeWith({ routingTableSize: 20, dhtMode: 'server' })
    )
    expect(status.dhtMode).to.equal('server')
    expect(status.ready).to.equal(true)
  })

  describe('honours an operator threshold on both config halves', () => {
    let envOverrides: OverrideEnvConfig[]
    before(async () => {
      envOverrides = await setupEnvironment(
        null,
        buildEnvOverrideConfig(
          [ENVIRONMENT_VARIABLES.P2P_READY_MIN_ROUTING_PEERS],
          ['10']
        )
      )
    })
    after(async () => {
      await tearDownEnvironment(envOverrides)
    })

    it('applies to the getter, the schema and the readiness gate', () => {
      expect(P2P_TIMEOUTS.dhtReadyMinPeers).to.equal(10)
      expect(
        OceanNodeP2PConfigSchema.parse({ readyMinRoutingPeers: '10' })
          .readyMinRoutingPeers
      ).to.equal(10)
      expect(
        OceanP2P.prototype.getP2PStatus.call(nodeWith({ routingTableSize: 9 })).ready
      ).to.equal(false)
    })
  })
})

describe('the first DHT self-query runs after bootstrap connections can exist', () => {
  it('waits longer than bootstrap discovery plus the dial it triggers', () => {
    // kad-dht runs this query once and then not again for five minutes, so it has to land after
    // there is something to walk from. Its own default of 1s lands before bootstrap discovery
    // has even emitted, against an empty routing table, where the query fails outright.
    const { bootstrapTimeout } = OceanNodeP2PConfigSchema.parse({})
    const dialBudget = P2P_TIMEOUTS.discoveryDialMs

    expect(P2P_TIMEOUT_DEFAULTS.initialQuerySelfMs).to.be.at.least(
      bootstrapTimeout + dialBudget
    )
    // The value kad-dht would have used on its own, for contrast.
    expect(P2P_TIMEOUT_DEFAULTS.initialQuerySelfMs).to.be.greaterThan(1_000)
  })

  describe('is overridable, and the two config halves agree on the override', () => {
    let envOverrides: OverrideEnvConfig[]
    before(async () => {
      envOverrides = await setupEnvironment(
        null,
        buildEnvOverrideConfig(
          [ENVIRONMENT_VARIABLES.P2P_INITIAL_QUERY_SELF_MS],
          ['30000']
        )
      )
    })
    after(async () => {
      await tearDownEnvironment(envOverrides)
    })

    it('reaches both the getter and the schema', () => {
      expect(P2P_TIMEOUTS.initialQuerySelfMs).to.equal(30000)
      expect(
        OceanNodeP2PConfigSchema.parse({ initialQuerySelfTimeout: '30000' })
          .initialQuerySelfTimeout
      ).to.equal(30000)
    })
  })
})
