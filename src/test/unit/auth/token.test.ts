import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { getConfiguration, getMessageHash } from '../../../utils/index.js'
import { expect } from 'chai'
import { Database } from '../../../components/database/index.js'
import { Wallet } from 'ethers'
import { Auth } from '../../../components/Auth/index.js'

describe('Auth Token Tests', () => {
  let wallet: Wallet
  let mockDatabase: Database
  let config: OceanNodeConfig

  before(async () => {
    config = await getConfiguration(true)
    mockDatabase = await new Database(config.dbConfig)
    wallet = new Wallet(process.env.PRIVATE_KEY)
  })

  it('should create and validate a token', async () => {
    const auth = new Auth(mockDatabase.authToken)
    const token = await auth.createToken(wallet.address, null)
    expect(token).to.be.a('string')

    const validationResult = await auth.validateToken(token)
    expect(validationResult).to.not.be.equal(null)
    expect(validationResult?.address).to.equal(wallet.address)
  })

  it('should validate authentication with token', async () => {
    const auth = new Auth(mockDatabase.authToken)
    const token = await auth.createToken(wallet.address, null)
    const result = await auth.validateAuthenticationOrToken(
      wallet.address,
      undefined,
      token
    )
    expect(result.valid).to.be.equal(true)
  })

  it('should validate authentication with signature', async () => {
    const auth = new Auth(mockDatabase.authToken)
    const message = auth.getSignatureMessage()
    const messageHash = getMessageHash(message)
    const signature = await wallet.signMessage(messageHash)

    const result = await auth.validateAuthenticationOrToken(
      wallet.address,
      signature,
      undefined,
      message
    )
    expect(result.valid).to.be.equal(true)
  })

  it('should fail validation with invalid token', async () => {
    const auth = new Auth(mockDatabase.authToken)
    const result = await auth.validateAuthenticationOrToken(
      wallet.address,
      undefined,
      'invalid-token'
    )
    expect(result.valid).to.be.equal(false)
  })

  it('should fail validation with invalid signature', async () => {
    const auth = new Auth(mockDatabase.authToken)
    const message = 'Test message'
    const invalidSignature = '0x' + '0'.repeat(130)

    const result = await auth.validateAuthenticationOrToken(
      wallet.address,
      invalidSignature,
      undefined,
      message
    )
    expect(result.valid).to.be.equal(false)
  })

  it('should respect token expiry', async () => {
    const auth = new Auth(mockDatabase.authToken)
    const validUntil = new Date(Date.now() - 1000) // 1 second ago
    const token = await auth.createToken(wallet.address, validUntil.getTime())

    const validationResult = await auth.validateToken(token)
    expect(validationResult).to.be.equal(null)
  })
})
