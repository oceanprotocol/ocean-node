import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { getConfiguration, getMessageHash } from '../../../utils/index.js'
import { expect } from 'chai'
import { Database } from '../../../components/database/index.js'
import { Wallet } from 'ethers'
import { Auth } from '../../../components/Auth/index.js'
import { OceanNode } from '../../../OceanNode.js'
import { CreateAuthTokenHandler, InvalidateAuthTokenHandler } from '../../../components/core/handler/authHandler.js'
import { streamToString } from '../../../utils/util.js'
import { Readable } from 'stream'

describe('Auth Token Tests', () => {
  let wallet: Wallet
  let mockDatabase: Database
  let config: OceanNodeConfig
  let oceanNode: OceanNode
  let createTokenHandler: CreateAuthTokenHandler
  let invalidateTokenHandler: InvalidateAuthTokenHandler
  let auth: Auth

  before(async () => {
    config = await getConfiguration(true)
    mockDatabase = await new Database(config.dbConfig)
    wallet = new Wallet(process.env.PRIVATE_KEY)
    oceanNode = OceanNode.getInstance(config, mockDatabase)
    createTokenHandler = new CreateAuthTokenHandler(oceanNode)
    invalidateTokenHandler = new InvalidateAuthTokenHandler(oceanNode)
    auth = new Auth(mockDatabase.authToken)
  })


  it('should create and validate a token', async () => {
    const message = auth.getSignatureMessage()
    const messageHash = getMessageHash(message)
    const signature = await wallet.signMessage(messageHash)

    const tokenCreateResponse = await createTokenHandler.handle({
      command: 'createAuthToken',
      address: wallet.address,
      signature,
    })
    const data: string = await streamToString(tokenCreateResponse.stream as Readable)
    expect(tokenCreateResponse.status.httpStatus).to.be.equal(200)
    expect(data).to.be.a('string')
    const tokenResponse = JSON.parse(data)
    const token = tokenResponse.token

    const result = await auth.validateAuthenticationOrToken(
      wallet.address,
      undefined,
      token
    )
    expect(result.valid).to.be.equal(true)
  })


  it('should fail validation with invalid token', async () => {
    const result = await auth.validateAuthenticationOrToken(
      wallet.address,
      undefined,
      'invalid-token'
    )
    expect(result.valid).to.be.equal(false)
  })

  it('should fail validation with invalid signature', async () => {
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
    const message = auth.getSignatureMessage()
    const messageHash = getMessageHash(message)
    const signature = await wallet.signMessage(messageHash)

    const tokenCreateResponse = await createTokenHandler.handle({
      command: 'createAuthToken',
      address: wallet.address,
      signature,
      validUntil: Date.now() + 1000
    })
    const data: string = await streamToString(tokenCreateResponse.stream as Readable)
    const token = JSON.parse(data).token

    await new Promise(resolve => setTimeout(resolve, 1500))

    const validationResult = await auth.validateToken(token)
    expect(validationResult).to.be.equal(null)
  })

  it('should invalidate a token', async () => {
    const message = auth.getSignatureMessage()
    const messageHash = getMessageHash(message)
    const signature = await wallet.signMessage(messageHash)

    const tokenCreateResponse = await createTokenHandler.handle({
      command: 'createAuthToken',
      address: wallet.address,
      signature,
    })
    const data: string = await streamToString(tokenCreateResponse.stream as Readable)
    const token = JSON.parse(data).token

    const invalidateTokenResponse = await invalidateTokenHandler.handle({
      command: 'invalidateAuthToken',
      address: wallet.address,
      signature,
      token
    })
    console.log({ invalidateTokenResponse })
    expect(invalidateTokenResponse.status.httpStatus).to.be.equal(200)

    const validationResult = await auth.validateToken(token)
    expect(validationResult).to.be.equal(null)
  })
})
