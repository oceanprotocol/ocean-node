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
    config = await getConfiguration(true)
    authTokenDatabase = await AuthTokenDatabase.create(config.dbConfig)
    auth = new Auth(authTokenDatabase, config)
    consumer = Wallet.createRandom()
  })

  async function mintRemoteToken(
    signWith: HDNodeWallet,
    claimAddress: string,
    opts: { nonce?: string; validUntil?: number | null } = {}
  ): Promise<string> {
    const nonce = opts.nonce ?? '12345'
    const signature = await safeSign(
      signWith,
      createHashForSignature(claimAddress, nonce, 'createAuthToken')
    )
    return auth.getJWTToken(
      claimAddress,
      nonce,
      Date.now(),
      signature,
      opts.validUntil ?? Date.now() + 60_000
    )
  }

  it('accepts a token whose embedded signature recovers to the claimed address', async () => {
    const token = await mintRemoteToken(consumer, consumer.address)
    const result = await auth.validateToken(token)
    expect(result).to.not.equal(null)
    expect(result.address).to.equal(consumer.address)
    expect(result.isValid).to.equal(true)
  })

  it('rejects a token whose signature recovers to a different address', async () => {
    const attacker = Wallet.createRandom()
    const token = await mintRemoteToken(attacker, consumer.address)
    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
  })

  it('rejects a token with no embedded signature', async () => {
    const token = await auth.getJWTToken(consumer.address, '999', Date.now())
    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
  })

  it('rejects an expired remote token', async () => {
    const token = await mintRemoteToken(consumer, consumer.address, {
      validUntil: Date.now() - 1000
    })
    const result = await auth.validateToken(token)
    expect(result).to.equal(null)
  })
})
