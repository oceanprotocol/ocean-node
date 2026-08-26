import { expect } from 'chai'
import { createLibp2p, type Libp2p } from 'libp2p'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import {
  P2P_TIMEOUTS,
  P2P_TIMEOUT_DEFAULTS,
  peerStoreAgeLimits
} from '../../../components/P2P/timeouts.js'
import { OceanNodeP2PConfigSchema } from '../../../utils/config/schemas.js'

/**
 * libp2p expires peer addresses after an hour and peer records after six, while a DHT provider
 * record stays valid for 48 hours - so the network kept returning providers whose addresses
 * this node had already thrown away. The node now configures both limits to the
 * provider-record lifetime.
 *
 * What these tests refuse to take on trust is that libp2p *honours* the setting. The effective
 * limits are read back off a started node rather than off the options object, and the
 * behavioural difference is demonstrated against a real peer store at a simulated age past the
 * library's own one-hour cut-off, with a default-configured node alongside as the control.
 */

const ADDRESS_AGE_KEY = 'P2P_PEERSTORE_MAX_ADDRESS_AGE_MS'
const PEER_AGE_KEY = 'P2P_PEERSTORE_MAX_PEER_AGE_MS'
const FORTY_EIGHT_HOURS_MS = 172_800_000
const ONE_HOUR_MS = 3_600_000

/** The peer store's own view of its limits, which is the only view that decides anything. */
function effectiveLimits(node: Libp2p): { maxAddressAge: number; maxPeerAge: number } {
  const { store } = node.peerStore as unknown as {
    store: { maxAddressAge: number; maxPeerAge: number }
  }
  return { maxAddressAge: store.maxAddressAge, maxPeerAge: store.maxPeerAge }
}

/** Runs `fn` with `Date.now()` moved forward by `ms`, and puts the clock back afterwards. */
async function atSimulatedAge<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now
  Date.now = () => realNow.call(Date) + ms
  try {
    return await fn()
  } finally {
    Date.now = realNow
  }
}

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[key]
  try {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
    fn()
  } finally {
    if (previous === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = previous
    }
  }
}

describe('peer store address lifetime', () => {
  describe('the configured values', () => {
    it('matches the 48h validity of a DHT provider record on both limits', () => {
      expect(P2P_TIMEOUT_DEFAULTS.peerStoreMaxAddressAgeMs).to.equal(FORTY_EIGHT_HOURS_MS)
      expect(P2P_TIMEOUT_DEFAULTS.peerStoreMaxPeerAgeMs).to.equal(FORTY_EIGHT_HOURS_MS)
      expect(peerStoreAgeLimits()).to.deep.equal({
        maxAddressAge: FORTY_EIGHT_HOURS_MS,
        maxPeerAge: FORTY_EIGHT_HOURS_MS
      })
    })

    it('never lets the peer record expire before the addresses it carries', () => {
      withEnv(PEER_AGE_KEY, '60000', () => {
        const limits = peerStoreAgeLimits()
        expect(limits.maxAddressAge).to.equal(FORTY_EIGHT_HOURS_MS)
        // an operator who lowers only this one would otherwise have the record - and with it
        // the addresses - evicted after a minute, silently undoing the address lifetime
        expect(limits.maxPeerAge).to.equal(limits.maxAddressAge)
      })
    })

    it('honours a deliberate override', () => {
      withEnv(ADDRESS_AGE_KEY, '7200000', () => {
        withEnv(PEER_AGE_KEY, '9000000', () => {
          expect(peerStoreAgeLimits()).to.deep.equal({
            maxAddressAge: 7_200_000,
            maxPeerAge: 9_000_000
          })
        })
      })
    })

    // the two halves that must agree: the getter the running code consults and the schema
    // that validates the configuration
    const rejected = ['', '   ', 'two days', 'NaN', '0', '-1', '10']
    for (const raw of rejected) {
      it(`falls back to the default on both halves for "${raw}"`, () => {
        withEnv(ADDRESS_AGE_KEY, raw, () => {
          const fromGetter = P2P_TIMEOUTS.peerStoreMaxAddressAgeMs
          const fromSchema = OceanNodeP2PConfigSchema.parse({
            peerStoreMaxAddressAge: raw
          }).peerStoreMaxAddressAge
          expect(fromGetter).to.equal(FORTY_EIGHT_HOURS_MS)
          expect(fromSchema).to.equal(fromGetter)
        })
        withEnv(PEER_AGE_KEY, raw, () => {
          const fromGetter = P2P_TIMEOUTS.peerStoreMaxPeerAgeMs
          const fromSchema = OceanNodeP2PConfigSchema.parse({
            peerStoreMaxPeerAge: raw
          }).peerStoreMaxPeerAge
          expect(fromGetter).to.equal(FORTY_EIGHT_HOURS_MS)
          expect(fromSchema).to.equal(fromGetter)
        })
      })
    }

    it('does not refuse to boot over a malformed value', () => {
      expect(() =>
        OceanNodeP2PConfigSchema.parse({
          peerStoreMaxAddressAge: 'two days',
          peerStoreMaxPeerAge: true
        })
      ).to.not.throw()
    })
  })

  describe('what libp2p actually does with them', () => {
    let configured: Libp2p
    let control: Libp2p

    before(async () => {
      configured = await createLibp2p({ peerStore: peerStoreAgeLimits() })
      // the same node with the option left off - i.e. the library defaults - so the
      // difference below is attributable to the setting and to nothing else
      control = await createLibp2p({})
    })

    after(async () => {
      await configured?.stop()
      await control?.stop()
    })

    it('reports the configured limits back off a started node', () => {
      expect(configured.status).to.equal('started')
      expect(effectiveLimits(configured)).to.deep.equal({
        maxAddressAge: FORTY_EIGHT_HOURS_MS,
        maxPeerAge: FORTY_EIGHT_HOURS_MS
      })
      // the library's own defaults, stated here so the comparison is visible rather than claimed
      expect(effectiveLimits(control)).to.deep.equal({
        maxAddressAge: ONE_HOUR_MS,
        maxPeerAge: 21_600_000
      })
    })

    it('still resolves an address observed more than an hour ago, where the default drops it', async () => {
      const otherPeer = peerIdFromPrivateKey(await generateKeyPair('Ed25519'))
      const address = multiaddr('/ip4/10.9.8.7/tcp/9000')

      await configured.peerStore.merge(otherPeer, { multiaddrs: [address] })
      await control.peerStore.merge(otherPeer, { multiaddrs: [address] })

      // both stores hold it now
      expect((await configured.peerStore.get(otherPeer)).addresses).to.have.lengthOf(1)
      expect((await control.peerStore.get(otherPeer)).addresses).to.have.lengthOf(1)

      // two hours later - past the library's one-hour address lifetime, far inside the
      // 48h validity of the provider record that would be pointing at this peer
      await atSimulatedAge(2 * ONE_HOUR_MS, async () => {
        const kept = (await configured.peerStore.get(otherPeer)).addresses
        expect(kept.map(({ multiaddr: ma }) => ma.toString())).to.deep.equal([
          address.toString()
        ])

        const dropped = (await control.peerStore.get(otherPeer)).addresses
        expect(
          dropped,
          'the library default expires the address after an hour'
        ).to.have.lengthOf(0)
      })
    })
  })
})
