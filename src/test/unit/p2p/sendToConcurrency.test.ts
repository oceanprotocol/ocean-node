import { expect } from 'chai'
import { streamPair } from '@libp2p/utils'
import type { Connection, Stream } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { Readable } from 'stream'
import { OceanP2P } from '../../../components/P2P/index.js'
import { handleProtocolCommands } from '../../../components/P2P/handleProtocolCommands.js'
import { sendToLimiterStats } from '../../../components/P2P/sendToLimiter.js'
import { P2P_TIMEOUTS } from '../../../components/P2P/timeouts.js'
import { resetPeerResolutionCache } from '../../../components/P2P/peerResolutionCache.js'
import { resetP2PCounters } from '../../../components/P2P/counters.js'
import { OceanNodeP2PConfigSchema } from '../../../utils/config/schemas.js'
import { SENDTO_MAX_CONCURRENCY_CAP } from '../../../components/P2P/timeouts.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { ENVIRONMENT_VARIABLES } from '../../../utils/constants.js'
import {
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment,
  OverrideEnvConfig
} from '../../utils/utils.js'

/**
 * A `sendTo` holds a slot in libp2p's dial queue for its whole setup phase, and two paths fan
 * out without a bound of their own - FindDDO's provider queries and the indexer's decrypt loop.
 * Without a ceiling they can put more dials in flight than the dial queue runs, at which point
 * unrelated traffic queues behind them.
 *
 * The peak is measured rather than asserted from the limiter's configuration, because the thing
 * that matters is how many exchanges are actually in flight at once, not what number the limiter
 * was handed.
 */

const PEER = '16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP'
const ADDR = '/ip4/10.3.3.3/tcp/9000'

function responderFor(handle: () => Promise<P2PCommandResponse>): OceanP2P {
  return {
    getConfig: () => ({
      denyList: { peers: [] as string[], ips: [] as string[] },
      rateLimit: 1_000_000,
      maxConnections: 1_000_000
    }),
    getCoreHandlers: () => ({ getHandler: () => ({ handle }) })
  } as unknown as OceanP2P
}

let seq = 0

function sender(handle: () => Promise<P2PCommandResponse>): OceanP2P {
  const peerId = peerIdFromString(PEER)
  return {
    _protocol: '/ocean/nodes/1.0.0',
    send: OceanP2P.prototype.send,
    normalizeMultiaddrs: OceanP2P.prototype.normalizeMultiaddrs,
    resolvePeer: OceanP2P.prototype.resolvePeer,
    _libp2p: {
      getConnections: (): Connection[] => [],
      peerStore: {
        get: () => Promise.resolve({ addresses: [{ multiaddr: multiaddr(ADDR) }] }),
        merge: () => Promise.resolve()
      },
      peerRouting: { findPeer: () => Promise.reject(new Error('not in the DHT')) },
      dial: async (): Promise<Connection> => {
        seq++
        const [client, server] = await streamPair()
        const incoming = {
          remotePeer: { toString: () => `12D3KooConcurrencyPeer${seq}` },
          remoteAddr: { toString: () => `/ip4/10.253.0.${seq % 250}/tcp/1` }
        } as unknown as Connection
        void handleProtocolCommands.call(responderFor(handle), server, incoming)
        return {
          id: `concurrency-connection-${seq}`,
          remotePeer: peerId,
          newStream: (): Promise<Stream> => Promise.resolve(client),
          close: (): Promise<void> => Promise.resolve()
        } as unknown as Connection
      }
    }
  } as unknown as OceanP2P
}

describe('outbound sends are capped', () => {
  beforeEach(() => {
    resetP2PCounters()
    resetPeerResolutionCache()
  })

  describe('with the ceiling set to 3', () => {
    let envOverrides: OverrideEnvConfig[]
    before(async () => {
      envOverrides = await setupEnvironment(
        null,
        buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.P2P_SENDTO_MAX_CONCURRENCY], ['3'])
      )
    })
    after(async () => {
      await tearDownEnvironment(envOverrides)
    })

    it('never runs more exchanges at once than the ceiling allows', async () => {
      expect(P2P_TIMEOUTS.sendToMaxConcurrency).to.equal(3)

      let inFlight = 0
      let peak = 0
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })

      const node = sender(async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await held
        inFlight--
        return { status: { httpStatus: 200 }, stream: Readable.from(['payload']) }
      })

      const sends = Array.from({ length: 9 }, () =>
        OceanP2P.prototype.sendTo.call(node, PEER, JSON.stringify({ command: 'x' }))
      )

      // Give every send that can start a chance to start before the responders are released.
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(peak, 'more exchanges were in flight than the ceiling allows').to.equal(3)
      expect(
        sendToLimiterStats().queued,
        'the rest must be queued, not running'
      ).to.equal(6)

      release()
      const results = await Promise.all(sends)
      for (const result of results) {
        expect(result.status.httpStatus).to.equal(200)
        if (result.stream) {
          for await (const chunk of result.stream) {
            expect(chunk).to.not.equal(undefined)
          }
        }
      }
      expect(peak).to.equal(3)
    })
  })

  describe('with a ceiling above the cap', () => {
    let envOverrides: OverrideEnvConfig[]
    before(async () => {
      envOverrides = await setupEnvironment(
        null,
        buildEnvOverrideConfig(
          [ENVIRONMENT_VARIABLES.P2P_SENDTO_MAX_CONCURRENCY],
          ['100000']
        )
      )
    })
    after(async () => {
      await tearDownEnvironment(envOverrides)
    })

    it('clamps a ceiling that would stop being a ceiling, on both halves', () => {
      expect(P2P_TIMEOUTS.sendToMaxConcurrency).to.equal(SENDTO_MAX_CONCURRENCY_CAP)
      expect(
        OceanNodeP2PConfigSchema.parse({ sendToMaxConcurrency: '100000' })
          .sendToMaxConcurrency
      ).to.equal(SENDTO_MAX_CONCURRENCY_CAP)
    })
  })
})
