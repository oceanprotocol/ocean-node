import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { getConfiguration } from '../../../utils/index.js'
import { expect } from 'chai'
import { HDNodeWallet, Wallet } from 'ethers'
import { Auth } from '../../../components/Auth/index.js'
import { AuthTokenDatabase } from '../../../components/database/AuthTokenDatabase.js'
import { OceanP2P } from '../../../components/P2P/index.js'
import { Readable } from 'node:stream'
import { createHashForSignature, safeSign } from '../../utils/signature.js'

describe('Auth Token Tests', () => {
  let wallet: Wallet
  let authTokenDatabase: AuthTokenDatabase
  let config: OceanNodeConfig
  let auth: Auth

  before(async () => {
    config = await getConfiguration(true)
    authTokenDatabase = await AuthTokenDatabase.create(config.dbConfig)
    wallet = new Wallet(process.env.PRIVATE_KEY)
    auth = new Auth(authTokenDatabase, config)
  })

  const getRandomNonce = () => {
    return Math.floor(Math.random() * 1000000).toString()
  }

  it('should create and validate a token', async () => {
    const jwtToken = await auth.getJWTToken(wallet.address, getRandomNonce(), Date.now())
    await auth.insertToken(wallet.address, jwtToken, Date.now() + 1000, Date.now())

    const result = await auth.validateAuthenticationOrToken({ token: jwtToken })
    expect(result.valid).to.be.equal(true)
  })

  it('should fail validation with invalid token', async () => {
    const result = await auth.validateAuthenticationOrToken({ token: 'invalid-token' })
    expect(result.valid).to.be.equal(false)
  })

  it('should fail validation with invalid signature', async () => {
    const invalidSignature = '0x' + '0'.repeat(130)

    const result = await auth.validateAuthenticationOrToken({
      signature: invalidSignature,
      nonce: getRandomNonce(),
      address: wallet.address
    })
    expect(result.valid).to.be.equal(false)
  })

  it('should respect token expiry', async () => {
    const jwtToken = await auth.getJWTToken(wallet.address, getRandomNonce(), Date.now())
    await auth.insertToken(wallet.address, jwtToken, Date.now() + 1000, Date.now())

    await new Promise((resolve) => setTimeout(resolve, 1500))

    const validationResult = await auth.validateToken(jwtToken)
    expect(validationResult).to.be.equal(null)
  })

  it('should invalidate a token', async () => {
    const jwtToken = await auth.getJWTToken(wallet.address, getRandomNonce(), Date.now())
    await auth.insertToken(wallet.address, jwtToken, Date.now() + 1000, Date.now())

    await auth.invalidateToken(jwtToken)

    const validationResult = await auth.validateToken(jwtToken)
    expect(validationResult).to.be.equal(null)
  })
})

describe('Auth cross-node delegated validation', () => {
  let config: OceanNodeConfig
  let authTokenDatabase: AuthTokenDatabase
  let consumer: HDNodeWallet

  const ISSUER_PEER_ID = '12D3KooWJxrSgqyrknCAdLwZ8ZjAGmS7vC38QaCT8sLRfLxtxxmM'
  const SELF_PEER_ID = '12D3KooWLPYsaVTn8W1n1hKmhZt5zS3AMCN7hdaAZkKm94wKrDsa'

  function makeFakeP2P(opts: {
    verdict?: unknown
    httpStatus?: number
    isSelf?: boolean
  }) {
    const tracker = { calls: 0 }
    const p2p = {
      getPeerId: () => SELF_PEER_ID,
      isTargetPeerSelf: (id: string) => (opts.isSelf ? true : id === SELF_PEER_ID),
      // eslint-disable-next-line require-await
      sendTo: async (_peer: string, _msg: string) => {
        tracker.calls++
        const httpStatus = opts.httpStatus ?? 200
        if (httpStatus !== 200) {
          return { status: { httpStatus } }
        }
        return {
          status: { httpStatus: 200 },
          stream: Readable.from(JSON.stringify(opts.verdict))
        }
      }
    } as unknown as OceanP2P
    return { p2p, tracker }
  }

  async function mintToken(
    auth: Auth,
    signWith: HDNodeWallet,
    claimAddress: string,
    opts: { nonce?: string; issuerPeerId?: string } = {}
  ): Promise<string> {
    const nonce = opts.nonce ?? '12345'
    const signature = await safeSign(
      signWith,
      createHashForSignature(
        claimAddress,
        nonce,
        'createAuthToken',
        opts.issuerPeerId ?? ISSUER_PEER_ID
      )
    )
    return auth.getJWTToken(
      claimAddress,
      nonce,
      Date.now(),
      signature,
      opts.issuerPeerId ?? ISSUER_PEER_ID
    )
  }

  before(async () => {
    const baseConfig = await getConfiguration(true)
    config = { ...baseConfig, supportedNetworks: {} }
    authTokenDatabase = await AuthTokenDatabase.create(baseConfig.dbConfig)
    consumer = Wallet.createRandom()
  })

  it('accepts when the signature matches AND the issuer says valid', async () => {
    const { p2p, tracker } = makeFakeP2P({
      verdict: { valid: true, validUntil: Date.now() + 60_000 }
    })
    const auth = new Auth(authTokenDatabase, config, () => p2p)
    const token = await mintToken(auth, consumer, consumer.address)

    const result = await auth.validateToken(token)
    expect(result).to.not.equal(null)
    expect(result.address).to.equal(consumer.address)
    expect(result.isValid).to.equal(true)
    expect(tracker.calls).to.equal(1)
  })

  it('rejects a signature from a different address BEFORE asking the issuer', async () => {
    const attacker = Wallet.createRandom()
    const { p2p, tracker } = makeFakeP2P({ verdict: { valid: true } })
    const auth = new Auth(authTokenDatabase, config, () => p2p)
    const token = await mintToken(auth, attacker, consumer.address)

    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
    expect(tracker.calls).to.equal(0)
  })

  it('rejects when the issuer says invalid (expired/revoked)', async () => {
    const { p2p, tracker } = makeFakeP2P({ verdict: { valid: false } })
    const auth = new Auth(authTokenDatabase, config, () => p2p)
    const token = await mintToken(auth, consumer, consumer.address)

    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
    expect(tracker.calls).to.equal(1)
  })

  it('rejects when the issuer is unreachable', async () => {
    const { p2p, tracker } = makeFakeP2P({ httpStatus: 404 })
    const auth = new Auth(authTokenDatabase, config, () => p2p)
    const token = await mintToken(auth, consumer, consumer.address)

    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
    expect(tracker.calls).to.equal(1)
  })

  it('rejects a token with no embedded signature without asking the issuer', async () => {
    const { p2p, tracker } = makeFakeP2P({ verdict: { valid: true } })
    const auth = new Auth(authTokenDatabase, config, () => p2p)
    const token = await auth.getJWTToken(
      consumer.address,
      '2',
      Date.now(),
      undefined,
      ISSUER_PEER_ID
    )

    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
    expect(tracker.calls).to.equal(0)
  })

  it('rejects a token with no issuerPeerId without asking the issuer', async () => {
    const { p2p, tracker } = makeFakeP2P({ verdict: { valid: true } })
    const auth = new Auth(authTokenDatabase, config, () => p2p)
    const nonce = '3'
    const signature = await safeSign(
      consumer,
      createHashForSignature(consumer.address, nonce, 'createAuthToken', ISSUER_PEER_ID)
    )
    const token = await auth.getJWTToken(consumer.address, nonce, Date.now(), signature)

    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
    expect(tracker.calls).to.equal(0)
  })

  it('rejects when the issuer is self (already missed locally)', async () => {
    const { p2p, tracker } = makeFakeP2P({ verdict: { valid: true }, isSelf: true })
    const auth = new Auth(authTokenDatabase, config, () => p2p)
    const token = await mintToken(auth, consumer, consumer.address, {
      issuerPeerId: SELF_PEER_ID
    })

    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
    expect(tracker.calls).to.equal(0)
  })

  it('getLocalToken does NOT delegate', async () => {
    const { p2p, tracker } = makeFakeP2P({
      verdict: { valid: true, validUntil: Date.now() + 60_000 }
    })
    const auth = new Auth(authTokenDatabase, config, () => p2p)
    const token = await mintToken(auth, consumer, consumer.address)

    expect(await auth.validateToken(token)).to.not.equal(null)
    const callsBefore = tracker.calls
    expect(await auth.getLocalToken(token)).to.equal(null)
    expect(tracker.calls).to.equal(callsBefore)
  })
})
