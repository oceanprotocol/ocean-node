import { expect } from 'chai'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { kadDHT } from '@libp2p/kad-dht'
import type { Libp2p } from '@libp2p/interface'
import {
  addressConfirmation,
  autoTlsState,
  connectionBreakdown,
  dialQueueStats,
  effectivePeerStoreAges,
  relayReservations
} from '../../../components/P2P/observability.js'

/**
 * Every probe in `observability.ts` reads a libp2p internal, because libp2p exposes no
 * public accessor for any of them. That is a real risk and these tests are what convert it
 * from "it silently reports nothing one day" into "a test fails on upgrade".
 *
 * So the shapes are asserted against a **real node**, not a stub: a stub would keep passing
 * after libp2p moved the thing being read, which is the only failure worth catching here.
 * The counting logic is exercised separately with synthetic connections, because producing
 * an inbound relayed connection under a byte limit in a unit test is not worth the machinery
 * when the arithmetic is the part that can be wrong.
 */
describe('P2P observability probes', () => {
  const FORTY_EIGHT_HOURS_MS = 172_800_000
  let node: Libp2p

  before(async () => {
    node = await createLibp2p({
      addresses: { listen: [] },
      transports: [webSockets(), tcp(), circuitRelayTransport()],
      streamMuxers: [yamux()],
      connectionEncrypters: [noise()],
      peerStore: {
        maxAddressAge: FORTY_EIGHT_HOURS_MS,
        maxPeerAge: FORTY_EIGHT_HOURS_MS
      },
      services: {
        identify: identify(),
        ping: ping(),
        dht: kadDHT({ clientMode: true })
      }
    })
    await node.start()
  })

  after(async () => {
    await node?.stop()
  })

  describe('against a real running node', () => {
    it('reads the peer store lifetimes the node is actually applying', () => {
      // Not the configured value — the effective one. The two have come apart before,
      // because these are read once at construction and an env change does nothing until
      // restart.
      expect(effectivePeerStoreAges(node)).to.deep.equal({
        maxAddressAge: FORTY_EIGHT_HOURS_MS,
        maxPeerAge: FORTY_EIGHT_HOURS_MS
      })
    })

    it('finds the dial queue and reports it as empty on an idle node', () => {
      const stats = dialQueueStats(node)
      expect(stats, 'the dial queue accessor must still exist').to.not.equal(undefined)
      expect(stats?.total).to.equal(0)
      expect(stats?.byStatus).to.deep.equal({})
    })

    it('finds the address metadata AutoNAT writes its verdict into', () => {
      const confirmation = addressConfirmation(node)
      expect(confirmation, 'the address metadata accessor must still exist').to.not.equal(
        undefined
      )
      // A node listening on nothing has no addresses to confirm; what is asserted is that
      // the accessor exists and its entries are shaped as expected.
      expect(confirmation?.total).to.equal(0)
      expect(confirmation?.verified).to.equal(0)
      expect(confirmation?.unverified).to.equal(0)
    })

    it('finds the circuit-relay reservation store', () => {
      const reservations = relayReservations(node)
      expect(reservations, 'the reservation store must still be reachable').to.not.equal(
        undefined
      )
      expect(reservations?.held).to.equal(0)
      // No relay *server* is configured on this node, so nothing is granted.
      expect(reservations?.granted).to.equal(undefined)
    })

    it('reports connections as empty rather than failing on an idle node', () => {
      expect(connectionBreakdown(node)).to.deep.equal({
        total: 0,
        byDirection: {},
        byTransport: {},
        limited: 0
      })
    })

    it('reports no autoTLS service rather than inventing one', () => {
      // This node runs no autoTLS, and "not configured" must not look like "no certificate".
      expect(autoTlsState(node)).to.equal(undefined)
    })
  })

  describe('counting', () => {
    /** A libp2p just real enough for the connection probe to walk. */
    function nodeWithConnections(
      connections: Array<{ direction: string; addr: string; limited?: boolean }>
    ): Libp2p {
      return {
        getConnections: () =>
          connections.map((connection) => ({
            direction: connection.direction,
            remoteAddr: { toString: () => connection.addr },
            limits: connection.limited === true ? { bytes: 1n } : undefined
          }))
      } as unknown as Libp2p
    }

    it('splits connections by direction, transport and relay limit', () => {
      const breakdown = connectionBreakdown(
        nodeWithConnections([
          { direction: 'inbound', addr: '/ip4/1.2.3.4/tcp/9000' },
          { direction: 'outbound', addr: '/ip4/5.6.7.8/tcp/9001/ws' },
          { direction: 'outbound', addr: '/ip4/5.6.7.8/tcp/443/tls/ws' },
          { direction: 'outbound', addr: '/dns4/x.example/tcp/443/wss' },
          {
            direction: 'inbound',
            addr: '/ip4/9.9.9.9/tcp/4001/p2p/QmRelay/p2p-circuit',
            limited: true
          }
        ])
      )
      expect(breakdown?.total).to.equal(5)
      expect(breakdown?.byDirection).to.deep.equal({ inbound: 2, outbound: 3 })
      expect(breakdown?.byTransport).to.deep.equal({
        tcp: 1,
        ws: 1,
        wss: 2,
        'circuit-relay': 1
      })
      // The one that matters on its own: a limited connection carries a byte or duration
      // budget, so a node whose connections are all limited looks healthy by count and can
      // carry almost nothing.
      expect(breakdown?.limited).to.equal(1)
    })

    it('classifies a relayed address as relay even when it also names a transport', () => {
      // The circuit-relay check has to come first: every relayed address carries the
      // relay's own `/tcp` or `/wss`, so testing for those first would hide every relayed
      // connection inside the direct counts.
      const breakdown = connectionBreakdown(
        nodeWithConnections([
          {
            direction: 'outbound',
            addr: '/dns4/r.example/tcp/443/wss/p2p/QmR/p2p-circuit'
          }
        ])
      )
      expect(breakdown?.byTransport).to.deep.equal({ 'circuit-relay': 1 })
    })
  })

  describe('when libp2p moves', () => {
    it('reports undefined rather than throwing, for every probe', () => {
      // A library upgrade that renames or removes any of these must degrade the stats
      // endpoint to "not reported", never break it.
      const empty = {
        getConnections: (): never[] => [],
        peerStore: {},
        services: {}
      } as unknown as Libp2p
      expect(dialQueueStats(empty)).to.equal(undefined)
      expect(addressConfirmation(empty)).to.equal(undefined)
      expect(relayReservations(empty)).to.equal(undefined)
      expect(autoTlsState(empty)).to.equal(undefined)
      expect(effectivePeerStoreAges(empty)).to.equal(undefined)

      const hostile = {
        get peerStore(): never {
          throw new Error('moved')
        },
        getConnections: () => {
          throw new Error('moved')
        },
        services: {}
      } as unknown as Libp2p
      expect(connectionBreakdown(hostile)).to.equal(undefined)
      expect(effectivePeerStoreAges(hostile)).to.equal(undefined)
    })

    it('distinguishes an autoTLS service with no certificate from no service at all', () => {
      const configured = {
        services: { autoTLS: {} }
      } as unknown as Libp2p
      expect(autoTlsState(configured)).to.deep.equal({ present: false })
    })

    it('parses the expiry out of a certificate the service is holding', () => {
      // Certificate expiry is the whole reason this probe exists: a node whose autoTLS
      // certificate lapses stops being dialable from a browser and nothing else says so.
      const service = {
        services: { autoTLS: { certificate: { cert: TEST_CERTIFICATE_PEM } } }
      } as unknown as Libp2p
      const state = autoTlsState(service)
      expect(state?.present).to.equal(true)
      expect(state?.notAfter, 'an expiry must be parsed out of the PEM').to.be.a('string')
      expect(new Date(state?.notAfter as string).getUTCFullYear()).to.equal(2036)
      // Derived from the parsed expiry rather than from a fixed date, so the assertion
      // pins the arithmetic and the sign convention without going stale.
      const expected = Math.floor(
        (Date.parse(state?.notAfter as string) - Date.now()) / 86_400_000
      )
      expect(state?.daysRemaining).to.equal(expected)
      expect(state?.daysRemaining).to.be.greaterThan(0)
    })

    it('reports a certificate it cannot parse as present rather than crashing', () => {
      const broken = {
        services: { autoTLS: { certificate: { cert: 'not a certificate' } } }
      } as unknown as Libp2p
      expect(autoTlsState(broken)).to.equal(undefined)
    })
  })
})

/**
 * A self-signed certificate with a 2036 expiry, used only to prove the expiry is read out
 * of the PEM. It is a public certificate, its private key was discarded at generation, and
 * it grants nothing.
 */
const TEST_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUcGMPQbn4VxGDIBcsLjKH9y1128IwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPb2NlYW4tbm9kZS10ZXN0MB4XDTI2MDgyNjIwMDgwMloX
DTM2MDgyMzIwMDgwMlowGjEYMBYGA1UEAwwPb2NlYW4tbm9kZS10ZXN0MIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlcsYLVerVlI58eXcmcE6jmxMx/hc
UZTX14bJAjrhUjG/xCyoKrcaybOjIy+7M3DnJf4jLv5K2i6lBr6FHUrSyFURAZiB
AixZpUulrV7W/r6Odslc268X/qvucciPG15fG+xx5QGtzK3DkTZ+2yLZd+daBj5Z
ZU8+DUyZrFAcV8Xky45ZGImSb4oY83dqRnzM8/STA5eUNhYbSc9XsBUhERsJq+hI
mUwKEc1YkqJKL7yEaGECZljzyQ5+yaBdthLECfFaByA3pBvUvRkiHvyg0DkSeNly
GGHyXHmP0Ytpuym72n4wvb/yJUC5rXIuDC0owgDasj25LjPkO/gEK4I6rQIDAQAB
o1MwUTAdBgNVHQ4EFgQUR4iltW3D1RKjy3GPMPn2j/138fswHwYDVR0jBBgwFoAU
R4iltW3D1RKjy3GPMPn2j/138fswDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEAjEdPzoOgGgtN6x01Z/ukMr/5dE5gN6WGjZ9quMlh6KYWz0Vgtfy/
Xj6oea+Ofhfq35PIH5pZHSbEYyLVH+StSeNcWvq9yHs65tbLNoqVnVIogVk+vmJq
V7HxNF2xLIOYU12xFFFC/yADtxtj1/99nHSPt2cSkMCau+i9R4wYGPC8XPLih9di
Ghnrd3B4sEkst8f3aXwhcmU1TrIUDhW/k7gkq8u9wmn/06ch+Vm9r6TsmRCifK+W
oiQPIsIDcOtTxFteHaEwiNw6IR+NqXM8XQVVe61Dn4cMPvMQeCmH39MPcaai6RpG
VnXUd0Tggju04UhtVrsp18KHs/BY0hWu/g==
-----END CERTIFICATE-----`
