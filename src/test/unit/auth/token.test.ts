import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { getConfiguration } from '../../../utils/index.js'
import { expect } from 'chai'
import { Wallet } from 'ethers'
import { Auth } from '../../../components/Auth/index.js'
import { AuthTokenDatabase } from '../../../components/database/AuthTokenDatabase.js'

describe('Auth Token Tests', () => {
  let wallet: Wallet
  let authTokenDatabase: AuthTokenDatabase
  let config: OceanNodeConfig
  let auth: Auth

  before(async () => {
    config = await getConfiguration(true)
    authTokenDatabase = await AuthTokenDatabase.create(config.dbConfig)
    wallet = new Wallet(process.env.PRIVATE_KEY)
    auth = new Auth(authTokenDatabase)
  })

  const getRandomNonce = () => {
    return Math.floor(Math.random() * 1000000).toString()
  }

  it('should create and validate a token', async () => {
    const jwtToken = auth.getJWTToken(wallet.address, getRandomNonce(), Date.now())
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
    const jwtToken = auth.getJWTToken(wallet.address, getRandomNonce(), Date.now())
    await auth.insertToken(wallet.address, jwtToken, Date.now() + 1000, Date.now())

    await new Promise((resolve) => setTimeout(resolve, 1500))

    const validationResult = await auth.validateToken(jwtToken)
    expect(validationResult).to.be.equal(null)
  })

  it('should invalidate a token', async () => {
    const jwtToken = auth.getJWTToken(wallet.address, getRandomNonce(), Date.now())
    await auth.insertToken(wallet.address, jwtToken, Date.now() + 1000, Date.now())

    await auth.invalidateToken(jwtToken)

    const validationResult = await auth.validateToken(jwtToken)
    expect(validationResult).to.be.equal(null)
  })
})
