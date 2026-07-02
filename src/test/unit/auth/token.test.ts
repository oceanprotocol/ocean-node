import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { getConfiguration } from '../../../utils/index.js'
import { expect } from 'chai'
import { HDNodeWallet, Wallet } from 'ethers'
import { Auth } from '../../../components/Auth/index.js'
import { AuthTokenDatabase } from '../../../components/database/AuthTokenDatabase.js'
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

describe('Auth cross-node self-verifying token', () => {
  let config: OceanNodeConfig
  let authTokenDatabase: AuthTokenDatabase
  let auth: Auth
  let consumer: HDNodeWallet

  before(async () => {
    const baseConfig = await getConfiguration(true)
    config = { ...baseConfig, supportedNetworks: {} }
    authTokenDatabase = await AuthTokenDatabase.create(baseConfig.dbConfig)
    auth = new Auth(authTokenDatabase, config)
    consumer = Wallet.createRandom()
  })

  async function mintToken(
    signWith: HDNodeWallet,
    claimAddress: string,
    opts: { nonce?: string; validUntil?: number; signedValidUntil?: number } = {}
  ): Promise<string> {
    const nonce = opts.nonce ?? '12345'
    const validUntil = opts.validUntil ?? Date.now() + 60_000
    const signedValidUntil = opts.signedValidUntil ?? validUntil
    const signature = await safeSign(
      signWith,
      createHashForSignature(claimAddress, nonce, 'createAuthToken', signedValidUntil)
    )
    return auth.getJWTToken(claimAddress, nonce, Date.now(), signature, validUntil)
  }

  it('accepts a token whose signature over validUntil recovers to the address', async () => {
    const token = await mintToken(consumer, consumer.address)
    const result = await auth.validateToken(token)
    expect(result).to.not.equal(null)
    expect(result.address).to.equal(consumer.address)
    expect(result.isValid).to.equal(true)
  })

  it('rejects a signature from a different address', async () => {
    const attacker = Wallet.createRandom()
    const token = await mintToken(attacker, consumer.address)
    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
  })

  it('rejects an expired token', async () => {
    const token = await mintToken(consumer, consumer.address, {
      validUntil: Date.now() - 1000
    })
    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
  })

  it('rejects a token whose validUntil was tampered after signing', async () => {
    const token = await mintToken(consumer, consumer.address, {
      signedValidUntil: Date.now() + 60_000,
      validUntil: Date.now() + 999_999_999
    })
    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
  })

  it('rejects a token with no embedded signature', async () => {
    const token = await auth.getJWTToken(
      consumer.address,
      '2',
      Date.now(),
      undefined,
      Date.now() + 60_000
    )
    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
  })

  it('rejects a token with no validUntil', async () => {
    const nonce = '3'
    const signature = await safeSign(
      consumer,
      createHashForSignature(consumer.address, nonce, 'createAuthToken')
    )
    const token = await auth.getJWTToken(consumer.address, nonce, Date.now(), signature)
    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
  })

  it('returns a locally-stored token from the DB', async () => {
    const token = await auth.getJWTToken(consumer.address, '4', Date.now())
    await auth.insertToken(consumer.address, token, Date.now() + 60_000, Date.now())
    const result = await auth.validateToken(token)
    expect(result).to.not.equal(null)
    expect(result.address).to.equal(consumer.address)
  })
})
