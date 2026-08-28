import { expect } from 'chai'
import sinon from 'sinon'
import {
  c2dBucketFor,
  c2dCapabilityContent
} from '../../../components/P2P/c2dCapability.js'
import { translateC2DStringToBucket } from '../../../components/httpRoutes/dids.js'
import { p2pAnnounceC2D } from '../../../utils/cronjobs/p2pAnnounceC2D.js'

/**
 * Golden vectors for the compute-capability content string and its bucketing rule.
 *
 * A cooperating implementation of this same format lives in a separate package that this
 * repository does not depend on — the query side of a search runs there, and the announce
 * side runs here. Both derive the same content id from the same three inputs (`free`,
 * `resource`, `value`) via independently written code, so these tables are the contract
 * between the two: if either side ever disagrees with a row here, a search silently returns
 * zero providers instead of failing loudly, which is exactly why the bytes are pinned down
 * explicitly, row for row, identically in both repositories.
 *
 * The tables are append-only. Adding a row for a resource that isn't covered yet is routine
 * — that's the whole point of an open, ungated resource string. Editing or removing an
 * existing row changes what bytes get hashed for everything already relying on it, which is
 * a breaking format change, not a routine update.
 */
describe('C2D capability format: golden vectors', () => {
  describe('serialization', () => {
    const vectors: Array<{
      free: boolean
      resource: string
      value: number
      expected: string
    }> = [
      {
        free: false,
        resource: 'cpu',
        value: 1,
        expected: '{"c2d":{"free":false,"cpu":1}}'
      },
      {
        free: false,
        resource: 'cpu',
        value: 4,
        expected: '{"c2d":{"free":false,"cpu":4}}'
      },
      {
        free: false,
        resource: 'disk',
        value: 1,
        expected: '{"c2d":{"free":false,"disk":1}}'
      },
      {
        free: true,
        resource: 'ram',
        value: 8,
        expected: '{"c2d":{"free":true,"ram":8}}'
      },
      {
        free: true,
        resource: 'cpu',
        value: 1,
        expected: '{"c2d":{"free":true,"cpu":1}}'
      },
      {
        free: false,
        resource: 'gpu',
        value: 2,
        expected: '{"c2d":{"free":false,"gpu":2}}'
      },
      {
        free: false,
        resource: 'fpga',
        value: 4,
        expected: '{"c2d":{"free":false,"fpga":4}}'
      },
      {
        free: true,
        resource: 'pcie',
        value: 1,
        expected: '{"c2d":{"free":true,"pcie":1}}'
      }
    ]

    for (const { free, resource, value, expected } of vectors) {
      it(`{free: ${free}, resource: '${resource}', value: ${value}} -> ${expected}`, () => {
        expect(c2dCapabilityContent({ free, resource, value })).to.equal(expected)
      })
    }

    // Rows 1 and 3 above are the two examples published in docs/API.md for
    // POST /getProvidersForStrings - freezing this format breaks neither.
    it('matches the documented HTTP API examples byte-for-byte', () => {
      expect(c2dCapabilityContent({ free: false, resource: 'disk', value: 1 })).to.equal(
        '{"c2d":{"free":false,"disk":1}}'
      )
      expect(c2dCapabilityContent({ free: false, resource: 'cpu', value: 1 })).to.equal(
        '{"c2d":{"free":false,"cpu":1}}'
      )
    })

    // These two exist specifically to prove the generic serialization path works for
    // resources this package has no built-in knowledge of - 'fpga' and 'pcie' get no special
    // casing anywhere and still produce byte-exact output.
    it('serializes a resource the package has never heard of, with no special casing', () => {
      expect(c2dCapabilityContent({ free: false, resource: 'fpga', value: 4 })).to.equal(
        '{"c2d":{"free":false,"fpga":4}}'
      )
      expect(c2dCapabilityContent({ free: true, resource: 'pcie', value: 1 })).to.equal(
        '{"c2d":{"free":true,"pcie":1}}'
      )
    })
  })

  describe('bucketing', () => {
    const vectors: Array<{ resource: string; value: number; bucket: number }> = [
      { resource: 'cpu', value: 1, bucket: 1 },
      { resource: 'cpu', value: 2, bucket: 2 },
      { resource: 'cpu', value: 3, bucket: 2 },
      { resource: 'cpu', value: 4, bucket: 4 },
      { resource: 'cpu', value: 7, bucket: 4 },
      { resource: 'cpu', value: 8, bucket: 8 },
      { resource: 'cpu', value: 100, bucket: 64 },
      { resource: 'ram', value: 8, bucket: 8 },
      { resource: 'disk', value: 500, bucket: 256 },
      { resource: 'disk', value: 4096, bucket: 4096 },
      { resource: 'fpga', value: 3, bucket: 2 },
      { resource: 'pcie', value: 1, bucket: 1 }
    ]

    for (const { resource, value, bucket } of vectors) {
      it(`${resource}: ${value} -> ${bucket}`, () => {
        expect(c2dBucketFor(resource, value)).to.equal(bucket)
      })
    }

    // 'fpga' and 'pcie' use exactly the same doubling ladder as 'cpu', with no per-resource
    // entry anywhere in the bucketing table (it ships empty) - that's what makes a brand new
    // resource type need no release of this package to bucket correctly.
    it('buckets an unknown resource with the same default ladder as a known one', () => {
      expect(c2dBucketFor('fpga', 3)).to.equal(c2dBucketFor('cpu', 3))
      expect(c2dBucketFor('pcie', 100)).to.equal(c2dBucketFor('cpu', 100))
    })
  })

  describe('required negative test: no qualifier can influence the serialized string', () => {
    // A capability's typed shape is exactly {free, resource, value} - there is nowhere to put
    // a model, kind, description or other qualifier, so this asserts the property at the type
    // level (nothing extra can be passed in) and, for belt-and-braces, that two capabilities
    // built from unrelated "extra" data - as if a caller had spread in metadata that has no
    // business affecting the hash - still serialize identically as long as the three real
    // fields match. This is exactly what deletes the old GPU-model bug class: a plain
    // {"c2d":{"free":false,"gpu":N}} and a model-qualified variant used to be two different
    // announced strings; here there is only ever one.
    it('produces the same string regardless of any extra model/kind/description data nearby', () => {
      const withoutMetadata = c2dCapabilityContent({
        free: false,
        resource: 'gpu',
        value: 2
      })

      const gpuModelA = { free: false, resource: 'gpu', value: 2, model: 'A100' } as const
      const gpuModelB = {
        free: false,
        resource: 'gpu',
        value: 2,
        model: 'RTX 4090',
        kind: 'consumer',
        description: 'high-end gaming card'
      } as const

      // Only {free, resource, value} are ever read; extra fields on the object are ignored.
      expect(c2dCapabilityContent(gpuModelA)).to.equal(withoutMetadata)
      expect(c2dCapabilityContent(gpuModelB)).to.equal(withoutMetadata)
      expect(c2dCapabilityContent(gpuModelA)).to.equal(c2dCapabilityContent(gpuModelB))
    })
  })
})

describe('POST /getProvidersForStrings exact-to-bucket translation', () => {
  it('leaves the two documented API.md examples resolving to themselves (already buckets)', () => {
    expect(translateC2DStringToBucket('{"c2d":{"free":false,"disk":1}}')).to.equal(
      '{"c2d":{"free":false,"disk":1}}'
    )
    expect(translateC2DStringToBucket('{"c2d":{"free":false,"cpu":1}}')).to.equal(
      '{"c2d":{"free":false,"cpu":1}}'
    )
  })

  it('translates a value that is not itself a bucket to the bucket that covers it', () => {
    // cpu: 3 is not a power of two - a fleet that only announces buckets has nothing at
    // "cpu":3, but does have "cpu":2 (the bucket a max of 3 would announce).
    expect(translateC2DStringToBucket('{"c2d":{"free":false,"cpu":3}}')).to.equal(
      '{"c2d":{"free":false,"cpu":2}}'
    )
  })

  it('passes a plain DID string through untouched', () => {
    const did = 'did:op:9bba46584cb98498b3e3aa27deba1a1beedafe14'
    expect(translateC2DStringToBucket(did)).to.equal(did)
  })

  it('passes non-C2D JSON through untouched', () => {
    const other = '{"foo":"bar"}'
    expect(translateC2DStringToBucket(other)).to.equal(other)
  })
})

/**
 * The acceptance test for the whole format: a resource type nobody has heard of - here 'fpga'
 * - must announce correctly with no code change anywhere, given only a compute engine that
 * reports it with an integer max. This is the design goal the frozen format exists to satisfy.
 */
describe('p2pAnnounceC2D: unknown resource type end to end (fpga acceptance test)', () => {
  afterEach(() => sinon.restore())

  function buildFakeNode(environments: any[]) {
    const advertised: string[] = []
    const advertiseString = sinon.stub().callsFake((content: string) => {
      advertised.push(content)
      return Promise.resolve(true)
    })
    const node: any = {
      getC2DEngines: () => ({
        fetchEnvironments: sinon.stub().resolves(environments)
      }),
      getP2PNode: () => ({ advertiseString })
    }
    return { node, advertised, advertiseString }
  }

  it('announces bucketed strings for an fpga resource nothing in this codebase special-cases', async () => {
    const { node, advertised } = buildFakeNode([
      {
        id: 'fpga-env',
        resources: [
          // 'fpga' appears nowhere in src/ outside test fixtures - the announce loop has no
          // switch case, no enum member, no special string anywhere for it.
          { id: 'fpga0', type: 'fpga', max: 3, min: 1 }
        ]
      }
    ])

    await p2pAnnounceC2D(node)

    // max=3 -> buckets 1, 2 (the doubling ladder never emits 3, since 3 isn't a bucket).
    expect(advertised.sort()).to.deep.equal(
      ['{"c2d":{"free":false,"fpga":1}}', '{"c2d":{"free":false,"fpga":2}}'].sort()
    )
  })

  it('announces a free fpga resource with free:true and no crossover with the paid string', async () => {
    const { node, advertised } = buildFakeNode([
      {
        id: 'fpga-env',
        resources: [{ id: 'fpga0', type: 'fpga', max: 4, min: 1 }],
        free: {
          resources: [{ id: 'fpga0', type: 'fpga', max: 2, min: 1 }]
        }
      }
    ])

    await p2pAnnounceC2D(node)

    expect(advertised.sort()).to.deep.equal(
      [
        '{"c2d":{"free":false,"fpga":1}}',
        '{"c2d":{"free":false,"fpga":2}}',
        '{"c2d":{"free":false,"fpga":4}}',
        '{"c2d":{"free":true,"fpga":1}}',
        '{"c2d":{"free":true,"fpga":2}}'
      ].sort()
    )
  })

  it('logs and skips (does not silently drop) a resource with no usable max, for any resource name', async () => {
    const { node, advertised } = buildFakeNode([
      {
        id: 'broken-env',
        resources: [
          { id: 'pcie0', type: 'pcie', max: 0 }, // below 1
          { id: 'pcie1', type: 'pcie' }, // missing max
          { id: 'pcie2', type: 'pcie', max: 1.5 }, // non-integer
          { id: 'pcie3', type: 'pcie', max: 2 } // valid - proves the others were rejected on
          // their own merits, not because the whole env was skipped
        ]
      }
    ])

    await p2pAnnounceC2D(node)

    expect(advertised.sort()).to.deep.equal(
      ['{"c2d":{"free":false,"pcie":1}}', '{"c2d":{"free":false,"pcie":2}}'].sort()
    )
  })

  it('never announces ram/disk in bytes: an operator-configured GB max iterates in GB, not bytes', async () => {
    // This is the live bug the frozen format eliminates: the engine publishes ram/disk in GB,
    // and a loop that steps in bytes (GB = 1024**3) never reaches a max of 64 and announces
    // nothing at all. Iterating in the resource's own unit means ram:64 announces normally.
    const { node, advertised } = buildFakeNode([
      {
        id: 'ram-env',
        resources: [{ id: 'ram', type: 'ram', max: 64, min: 1 }]
      }
    ])

    await p2pAnnounceC2D(node)

    expect(advertised.sort()).to.deep.equal(
      [
        '{"c2d":{"free":false,"ram":1}}',
        '{"c2d":{"free":false,"ram":2}}',
        '{"c2d":{"free":false,"ram":4}}',
        '{"c2d":{"free":false,"ram":8}}',
        '{"c2d":{"free":false,"ram":16}}',
        '{"c2d":{"free":false,"ram":32}}',
        '{"c2d":{"free":false,"ram":64}}'
      ].sort()
    )
  })

  it('drops a GPU model qualifier: exactly one string per (free, bucket), never two for the same value', async () => {
    // The old code pushed the same object reference twice after mutating it (once plain, once
    // with a model/description field bolted on), so the plain string was never actually
    // announced. With the model gone from the format entirely, there is nothing left to
    // duplicate: a gpu resource with a model/kind/description set still produces exactly one
    // string per bucket.
    const { node, advertised } = buildFakeNode([
      {
        id: 'gpu-env',
        resources: [
          {
            id: 'gpu0',
            type: 'gpu',
            max: 2,
            min: 1,
            kind: 'discrete',
            description: 'NVIDIA A100'
          }
        ]
      }
    ])

    await p2pAnnounceC2D(node)

    expect(advertised.sort()).to.deep.equal(
      ['{"c2d":{"free":false,"gpu":1}}', '{"c2d":{"free":false,"gpu":2}}'].sort()
    )
  })
})
