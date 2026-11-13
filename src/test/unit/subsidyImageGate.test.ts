import { expect } from 'chai'
import { getAddress } from 'ethers'
import {
  filterSubsidyByAllowedImages,
  hasUserSuppliedAlgorithm,
  imageReferenceMatches
} from '../../components/core/utils/subsidyProviders.js'

// Pure-logic unit test of the SUBSIDY_PROVIDER_ALLOWED_IMAGES gate: the two-state semantics
// (unset/{} → no gating; populated → per-address restriction), the image-reference matching
// (tag vs sha256 digest, default :latest), and the "custom entrypoint/cmd disqualifies" rule.
describe('filterSubsidyByAllowedImages / imageReferenceMatches', () => {
  // lowercase on purpose, to prove the gate checksums the effective addresses before lookup
  const A = '0x1111111111111111111111111111111111111111'
  const B = '0x2222222222222222222222222222222222222222'
  const C = '0x3333333333333333333333333333333333333333'
  const IMAGE = 'oceanprotocol/algo'
  const TAG = '1.0'
  const DIGEST = 'sha256:' + 'a'.repeat(64)

  describe('imageReferenceMatches', () => {
    it('matches image:tag', () => {
      expect(
        imageReferenceMatches({ image: IMAGE, tag: TAG }, `${IMAGE}:${TAG}`)
      ).to.equal(true)
    })

    it('matches image@sha256 digest', () => {
      expect(
        imageReferenceMatches({ image: IMAGE, checksum: DIGEST }, `${IMAGE}@${DIGEST}`)
      ).to.equal(true)
    })

    it('with both tag and checksum, matches ONLY the digest (checksum wins, like the engine)', () => {
      // Security: the engine runs `image@checksum` and ignores the tag, so matching the tag entry
      // would subsidize a different image than the one that runs (bypass).
      const c = { image: IMAGE, tag: TAG, checksum: DIGEST }
      expect(imageReferenceMatches(c, `${IMAGE}@${DIGEST}`)).to.equal(true)
      expect(imageReferenceMatches(c, `${IMAGE}:${TAG}`)).to.equal(false)
    })

    it('never matches when a dockerfile is present (user-built synthetic image)', () => {
      // dockerfile has top priority in resolveServiceImage → the real image is a synthetic build,
      // never a trusted operator image, even if image/tag are also supplied.
      const c = { image: IMAGE, tag: TAG, dockerfile: 'FROM alpine\nRUN miner' }
      expect(imageReferenceMatches(c, `${IMAGE}:${TAG}`)).to.equal(false)
      expect(imageReferenceMatches(c, `${IMAGE}:latest`)).to.equal(false)
    })

    it('a whitespace-only dockerfile still never matches (engine builds on any truthy value)', () => {
      // resolveServiceImage / the build path use a truthy `if (dockerfile)` check, so '   ' triggers
      // a dockerfile build there — the gate must reject it too (a trimmed check would let it match
      // image:tag and subsidize a different, user-built image).
      const c = { image: IMAGE, tag: TAG, dockerfile: '   ' }
      expect(imageReferenceMatches(c, `${IMAGE}:${TAG}`)).to.equal(false)
    })

    it('defaults to image:latest when neither tag nor checksum is given', () => {
      expect(imageReferenceMatches({ image: IMAGE }, `${IMAGE}:latest`)).to.equal(true)
      expect(imageReferenceMatches({ image: IMAGE }, `${IMAGE}:1.0`)).to.equal(false)
    })

    it('trims the allowlist entry before comparing', () => {
      expect(
        imageReferenceMatches({ image: IMAGE, tag: TAG }, `  ${IMAGE}:${TAG}  `)
      ).to.equal(true)
    })

    it('never matches a container with no image name (e.g. dockerfile-built)', () => {
      expect(imageReferenceMatches({ tag: TAG }, `${IMAGE}:${TAG}`)).to.equal(false)
      expect(imageReferenceMatches(null, `${IMAGE}:${TAG}`)).to.equal(false)
    })

    describe('wildcard tag `name:*`', () => {
      it('matches any tag of the same image', () => {
        expect(
          imageReferenceMatches({ image: IMAGE, tag: 'latest' }, `${IMAGE}:*`)
        ).to.equal(true)
        expect(
          imageReferenceMatches({ image: IMAGE, tag: 'v1.2' }, `${IMAGE}:*`)
        ).to.equal(true)
        // no tag/checksum → resolves to :latest → still matches the wildcard
        expect(imageReferenceMatches({ image: IMAGE }, `${IMAGE}:*`)).to.equal(true)
      })

      it('matches any digest of the same image (full flexibility for a controlled repo)', () => {
        expect(
          imageReferenceMatches({ image: IMAGE, checksum: DIGEST }, `${IMAGE}:*`)
        ).to.equal(true)
      })

      it('does not match a different image', () => {
        expect(
          imageReferenceMatches({ image: 'evil/miner', tag: 'latest' }, `${IMAGE}:*`)
        ).to.equal(false)
      })

      it('does not match a dockerfile-built image even with a wildcard', () => {
        expect(
          imageReferenceMatches(
            { image: IMAGE, tag: TAG, dockerfile: 'FROM alpine\nRUN miner' },
            `${IMAGE}:*`
          )
        ).to.equal(false)
      })

      it('a bare `:*` (empty name) matches nothing', () => {
        expect(imageReferenceMatches({ image: IMAGE, tag: TAG }, ':*')).to.equal(false)
      })

      it('matches a registry-qualified name with a port', () => {
        const reg = 'localhost:5000/team/algo'
        expect(imageReferenceMatches({ image: reg, tag: 'x' }, `${reg}:*`)).to.equal(true)
      })
    })
  })

  describe('hasUserSuppliedAlgorithm (compute workload disqualifier)', () => {
    it('inline rawcode → true', () => {
      expect(hasUserSuppliedAlgorithm({ meta: { rawcode: 'print(1)' } })).to.equal(true)
    })
    it('user-supplied algorithm fileObject → true', () => {
      expect(
        hasUserSuppliedAlgorithm({ fileObject: { type: 'url', url: 'http://x' } })
      ).to.equal(true)
    })
    it('published documentId → true (a miner can be published as an algorithm DDO)', () => {
      expect(
        hasUserSuppliedAlgorithm({ documentId: 'did:op:abc', serviceId: '0' } as any)
      ).to.equal(true)
    })
    it('serviceId alone → true', () => {
      expect(hasUserSuppliedAlgorithm({ serviceId: '0' } as any)).to.equal(true)
    })
    it('self-contained image, no algorithm of any kind → false', () => {
      // Only a truly self-contained image qualifies: empty entrypoint handled by the caller, and
      // here no rawcode / fileObject / documentId / serviceId at all.
      expect(
        hasUserSuppliedAlgorithm({ meta: { container: { image: IMAGE } } } as any)
      ).to.equal(false)
    })
    it('empty/whitespace fields and no code source → false', () => {
      expect(hasUserSuppliedAlgorithm({ meta: { rawcode: '   ' } })).to.equal(false)
      expect(hasUserSuppliedAlgorithm({ documentId: '  ' } as any)).to.equal(false)
      expect(hasUserSuppliedAlgorithm({})).to.equal(false)
      expect(hasUserSuppliedAlgorithm(null)).to.equal(false)
    })
  })

  describe('gate OFF (legacy)', () => {
    it('unset → all kept, none dropped', () => {
      const r = filterSubsidyByAllowedImages(
        [A, B],
        { image: IMAGE, tag: TAG },
        false,
        null
      )
      expect(r.kept).to.deep.equal([A, B])
      expect(r.dropped).to.deep.equal([])
    })

    it('{} (zero keys) → all kept, none dropped', () => {
      const r = filterSubsidyByAllowedImages(
        [A, B],
        { image: IMAGE, tag: TAG },
        false,
        {}
      )
      expect(r.kept).to.deep.equal([A, B])
      expect(r.dropped).to.deep.equal([])
    })
  })

  describe('gate ON', () => {
    it('keyed addr + matching image:tag + no entrypoint → kept', () => {
      const r = filterSubsidyByAllowedImages([A], { image: IMAGE, tag: TAG }, false, {
        [getAddress(A)]: [`${IMAGE}:${TAG}`]
      })
      expect(r.kept).to.deep.equal([A])
      expect(r.dropped).to.deep.equal([])
    })

    it('lowercase map KEY still matches a checksummed effective address (casing-robust lookup)', () => {
      // A is lowercase; use it directly as the map key (not getAddress(A)) to prove the gate
      // normalizes keys before lookup — a mis-cased key must not silently leak a subsidy.
      const r = filterSubsidyByAllowedImages([A], { image: IMAGE, tag: TAG }, false, {
        [A]: [`${IMAGE}:${TAG}`]
      })
      expect(r.kept).to.deep.equal([A])
      expect(r.dropped).to.deep.equal([])
    })

    it('lowercase map KEY on a non-matching image still drops (no accidental pass-through)', () => {
      const r = filterSubsidyByAllowedImages(
        [A],
        { image: 'miner/x', tag: 'v1' },
        false,
        {
          [A]: [`${IMAGE}:${TAG}`]
        }
      )
      expect(r.kept).to.deep.equal([])
      expect(r.dropped).to.deep.equal([A])
    })

    it('wildcard entry `image:*` keeps the address for any tag', () => {
      const r = filterSubsidyByAllowedImages(
        [A],
        { image: IMAGE, tag: 'v9.9.9' },
        false,
        { [getAddress(A)]: [`${IMAGE}:*`] }
      )
      expect(r.kept).to.deep.equal([A])
      expect(r.dropped).to.deep.equal([])
    })

    it('wildcard entry still drops on a custom entrypoint', () => {
      const r = filterSubsidyByAllowedImages([A], { image: IMAGE, tag: 'v1' }, true, {
        [getAddress(A)]: [`${IMAGE}:*`]
      })
      expect(r.dropped).to.deep.equal([A])
    })

    it('same image but a custom entrypoint → dropped', () => {
      const r = filterSubsidyByAllowedImages(
        [A],
        { image: IMAGE, tag: TAG },
        true, // hasCustomEntrypoint
        { [getAddress(A)]: [`${IMAGE}:${TAG}`] }
      )
      expect(r.kept).to.deep.equal([])
      expect(r.dropped).to.deep.equal([A])
    })

    it('matching sha256 digest → kept', () => {
      const r = filterSubsidyByAllowedImages(
        [A],
        { image: IMAGE, checksum: DIGEST },
        false,
        { [getAddress(A)]: [`${IMAGE}@${DIGEST}`] }
      )
      expect(r.kept).to.deep.equal([A])
      expect(r.dropped).to.deep.equal([])
    })

    it('non-matching image → dropped', () => {
      const r = filterSubsidyByAllowedImages(
        [A],
        { image: 'evil/miner', tag: 'latest' },
        false,
        { [getAddress(A)]: [`${IMAGE}:${TAG}`] }
      )
      expect(r.kept).to.deep.equal([])
      expect(r.dropped).to.deep.equal([A])
    })

    it('unlisted addr passes through even when the map is populated', () => {
      // B is not a key in the map → the gate does not apply to it; A is keyed and matches.
      const r = filterSubsidyByAllowedImages([A, B], { image: IMAGE, tag: TAG }, false, {
        [getAddress(A)]: [`${IMAGE}:${TAG}`]
      })
      expect(r.kept).to.deep.equal([A, B])
      expect(r.dropped).to.deep.equal([])
    })

    it('mixed: keyed+matching kept, keyed+non-matching dropped, unlisted kept', () => {
      const r = filterSubsidyByAllowedImages(
        [A, B, C],
        { image: IMAGE, tag: TAG },
        false,
        {
          [getAddress(A)]: [`${IMAGE}:${TAG}`], // matches → kept
          [getAddress(B)]: ['other/image:9'] // no match → dropped
          // C not a key → kept
        }
      )
      expect(r.kept).to.deep.equal([A, C])
      expect(r.dropped).to.deep.equal([B])
    })

    it('service cmd-override (no entrypoint) still disqualifies a keyed addr', () => {
      // The caller passes hasCustomEntrypoint=true when EITHER dockerEntrypoint OR dockerCmd is
      // set; this proves a keyed address with a matching image is dropped on that signal alone.
      const r = filterSubsidyByAllowedImages([A], { image: IMAGE, tag: TAG }, true, {
        [getAddress(A)]: [`${IMAGE}:${TAG}`]
      })
      expect(r.dropped).to.deep.equal([A])
    })

    it('dockerfile-built image on an allowed name → dropped (C1 bypass closed)', () => {
      // { image: <allowed>, dockerfile: <miner> } must NOT be subsidized even though the name
      // matches an allowlist entry — the engine builds and runs the user's Dockerfile.
      const r = filterSubsidyByAllowedImages(
        [A],
        { image: IMAGE, tag: TAG, dockerfile: 'FROM alpine\nRUN miner' },
        false,
        { [getAddress(A)]: [`${IMAGE}:${TAG}`] }
      )
      expect(r.kept).to.deep.equal([])
      expect(r.dropped).to.deep.equal([A])
    })

    it('allowed tag but an attacker-controlled digest → dropped (C2 bypass closed)', () => {
      // The entry pins the trusted tag, but the job also carries a digest → the engine runs the
      // digest. The gate must follow the engine and drop it.
      const attackerDigest = 'sha256:' + 'b'.repeat(64)
      const r = filterSubsidyByAllowedImages(
        [A],
        { image: IMAGE, tag: TAG, checksum: attackerDigest },
        false,
        { [getAddress(A)]: [`${IMAGE}:${TAG}`] }
      )
      expect(r.kept).to.deep.equal([])
      expect(r.dropped).to.deep.equal([A])
    })

    it('checksums the effective address before lookup (keyed by checksummed form)', () => {
      // A is lowercase in the effective list but the map key is checksummed.
      const r = filterSubsidyByAllowedImages([A], { image: IMAGE, tag: TAG }, false, {
        [getAddress(A)]: [`${IMAGE}:${TAG}`]
      })
      expect(r.kept).to.deep.equal([A])
    })

    it('an empty image list [] for a keyed addr blocks it (nothing can match)', () => {
      const r = filterSubsidyByAllowedImages([A, B], { image: IMAGE, tag: TAG }, false, {
        [getAddress(A)]: []
      })
      expect(r.kept).to.deep.equal([B])
      expect(r.dropped).to.deep.equal([A])
    })

    it("whitespace-only/absent entrypoint flag is the caller's job; hasCustomEntrypoint=true always drops, even with digest match", () => {
      const r = filterSubsidyByAllowedImages(
        [A],
        { image: IMAGE, checksum: DIGEST },
        true,
        { [getAddress(A)]: [`${IMAGE}@${DIGEST}`] }
      )
      expect(r.kept).to.deep.equal([])
      expect(r.dropped).to.deep.equal([A])
    })
  })
})
