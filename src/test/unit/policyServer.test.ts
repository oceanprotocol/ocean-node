import { assert, expect } from 'chai'
import sinon from 'sinon'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { PolicyServer } from '../../components/policyServer/index.js'
import {
  PolicyServerPassthroughHandler,
  PolicyServerInitializeHandler
} from '../../components/core/handler/policyServer.js'

const CONSUMER = '0x0000000000000000000000000000000000000abc'
const VICTIM = '0x0000000000000000000000000000000000000def'
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.fake.token'
const DDO = { id: 'did:op:1234', nftAddress: '0xnft' }

interface FakeOpts {
  // what Auth.validateAuthenticationOrToken resolves to
  authResult?: any
  // false => OceanNode.getAuth() returns undefined (auth component not wired up)
  authConfigured?: boolean
  ddo?: any
}

function buildFakes(opts: FakeOpts = {}) {
  const validateAuthenticationOrToken = sinon
    .stub()
    .resolves(opts.authResult ?? { valid: true, error: '', address: CONSUMER })

  const retrieve = sinon.stub().resolves(opts.ddo === undefined ? DDO : opts.ddo)

  const node: any = {
    getRequestMap: () => new Map(),
    getConfig: (): any => ({ rateLimit: undefined as number | undefined }),
    getDatabase: () => Promise.resolve({ ddo: { retrieve } }),
    getAuth: () =>
      opts.authConfigured === false ? undefined : { validateAuthenticationOrToken }
  }

  return { node, validateAuthenticationOrToken, retrieve }
}

function passthroughTask(overrides: any = {}) {
  return {
    command: PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH,
    policyServerPassthrough: { action: 'newDDO', documentId: DDO.id },
    consumerAddress: CONSUMER,
    nonce: '1',
    signature: '0xsignature',
    ...overrides
  }
}

function initializeTask(overrides: any = {}) {
  return {
    command: PROTOCOL_COMMANDS.POLICY_SERVER_INITIALIZE,
    documentId: DDO.id,
    serviceId: 'service-1',
    consumerAddress: CONSUMER,
    policyServer: { some: 'blob' },
    nonce: '1',
    signature: '0xsignature',
    ...overrides
  }
}

describe('PolicyServerPassthroughHandler', () => {
  afterEach(() => sinon.restore())

  describe('parameter validation (runs before auth)', () => {
    it('rejects a missing policyServerPassthrough field (400)', async () => {
      const { node, validateAuthenticationOrToken } = buildFakes()
      const response = await new PolicyServerPassthroughHandler(node).handle(
        passthroughTask({ policyServerPassthrough: undefined })
      )
      expect(response.status.httpStatus).to.equal(400)
      expect(response.status.error).to.contain('missing policyServerPassthrough')
      // validation must short-circuit before we ever touch the auth component
      assert(validateAuthenticationOrToken.notCalled, 'auth should not be reached')
    })

    it('rejects a non-object policyServerPassthrough (400)', async () => {
      const { node } = buildFakes()
      const response = await new PolicyServerPassthroughHandler(node).handle(
        passthroughTask({ policyServerPassthrough: 'not-an-object' })
      )
      expect(response.status.httpStatus).to.equal(400)
      expect(response.status.error).to.contain('must be an object')
    })

    it('rejects a missing consumerAddress (400)', async () => {
      const { node } = buildFakes()
      const response = await new PolicyServerPassthroughHandler(node).handle(
        passthroughTask({ consumerAddress: undefined })
      )
      expect(response.status.httpStatus).to.equal(400)
      expect(response.status.error).to.contain('consumerAddress')
    })

    it('rejects a malformed consumerAddress (400)', async () => {
      const { node } = buildFakes()
      const response = await new PolicyServerPassthroughHandler(node).handle(
        passthroughTask({ consumerAddress: 'not-an-address' })
      )
      expect(response.status.httpStatus).to.equal(400)
      expect(response.status.error).to.contain('not a valid web3 address')
    })
  })

  describe('authentication', () => {
    it('rejects an unauthenticated request (401)', async () => {
      const { node } = buildFakes({
        authResult: {
          valid: false,
          error:
            'Invalid authentication, you need to provide either a token or an address, signature, message and nonce'
        }
      })
      const passThrough = sinon.stub(PolicyServer.prototype, 'passThrough')

      const response = await new PolicyServerPassthroughHandler(node).handle(
        passthroughTask({ nonce: undefined, signature: undefined })
      )

      expect(response.status.httpStatus).to.equal(401)
      assert(passThrough.notCalled, 'must not reach the policy server')
    })

    it('rejects an invalid signature (401)', async () => {
      const { node } = buildFakes({
        authResult: { valid: false, error: 'Invalid signature' }
      })
      const passThrough = sinon.stub(PolicyServer.prototype, 'passThrough')

      const response = await new PolicyServerPassthroughHandler(node).handle(
        passthroughTask()
      )

      expect(response.status.httpStatus).to.equal(401)
      expect(response.status.error).to.equal('Invalid signature')
      assert(passThrough.notCalled, 'must not reach the policy server')
    })

    it('returns 401 when the auth component is not configured', async () => {
      const { node } = buildFakes({ authConfigured: false })
      const response = await new PolicyServerPassthroughHandler(node).handle(
        passthroughTask()
      )
      expect(response.status.httpStatus).to.equal(401)
      expect(response.status.error).to.equal('Auth not configured')
    })

    it('passes the auth header and the nonce/signature triple to the auth component', async () => {
      const { node, validateAuthenticationOrToken } = buildFakes()
      sinon.stub(PolicyServer.prototype, 'passThrough').resolves({
        success: true,
        message: 'ok',
        httpStatus: 200
      })

      await new PolicyServerPassthroughHandler(node).handle(
        passthroughTask({ authorization: TOKEN })
      )

      const args = validateAuthenticationOrToken.firstCall.args[0]
      expect(args.token).to.equal(TOKEN)
      expect(args.address).to.equal(CONSUMER)
      expect(args.nonce).to.equal('1')
      expect(args.signature).to.equal('0xsignature')
      // the signed message is scoped to the command string
      expect(args.command).to.equal(PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH)
    })
  })

  describe('forwarding to the policy server', () => {
    it('forwards the verified consumerAddress and the caller credentials', async () => {
      const { node } = buildFakes()
      const passThrough = sinon.stub(PolicyServer.prototype, 'passThrough').resolves({
        success: true,
        message: 'ok',
        httpStatus: 200
      })

      const response = await new PolicyServerPassthroughHandler(node).handle(
        passthroughTask({ authorization: TOKEN })
      )

      expect(response.status.httpStatus).to.equal(200)
      const forwarded = passThrough.firstCall.args[0]
      expect(forwarded.consumerAddress).to.equal(CONSUMER)
      expect(forwarded.authorization).to.equal(TOKEN)
      expect(forwarded.nonce).to.equal('1')
      expect(forwarded.signature).to.equal('0xsignature')
      // the node still resolves the DDO server-side
      expect(forwarded.ddo).to.deep.equal(DDO)
      // and the caller's own payload is preserved
      expect(forwarded.action).to.equal('newDDO')
    })

    it('overwrites a forged consumerAddress inside the payload with the verified one', async () => {
      // auth succeeds for CONSUMER, but the caller tries to pass VICTIM off as the consumer
      const { node } = buildFakes()
      const passThrough = sinon.stub(PolicyServer.prototype, 'passThrough').resolves({
        success: true,
        message: 'ok',
        httpStatus: 200
      })

      await new PolicyServerPassthroughHandler(node).handle(
        passthroughTask({
          policyServerPassthrough: {
            action: 'download',
            documentId: DDO.id,
            consumerAddress: VICTIM
          }
        })
      )

      expect(passThrough.firstCall.args[0].consumerAddress).to.equal(CONSUMER)
    })

    it('uses the address the token resolves to, not the one the caller claims', async () => {
      // token path: Auth returns the address encoded in the JWT
      const { node } = buildFakes({
        authResult: { valid: true, error: '', address: CONSUMER }
      })
      const passThrough = sinon.stub(PolicyServer.prototype, 'passThrough').resolves({
        success: true,
        message: 'ok',
        httpStatus: 200
      })

      await new PolicyServerPassthroughHandler(node).handle(
        passthroughTask({ consumerAddress: VICTIM, authorization: TOKEN })
      )

      expect(passThrough.firstCall.args[0].consumerAddress).to.equal(CONSUMER)
    })

    it('forwards even when the DDO cannot be resolved (ddo stays null)', async () => {
      const { node } = buildFakes({ ddo: null })
      const passThrough = sinon.stub(PolicyServer.prototype, 'passThrough').resolves({
        success: true,
        message: 'ok',
        httpStatus: 200
      })

      await new PolicyServerPassthroughHandler(node).handle(passthroughTask())

      expect(passThrough.firstCall.args[0].ddo).to.equal(null)
      expect(passThrough.firstCall.args[0].consumerAddress).to.equal(CONSUMER)
    })

    it('propagates a policy server denial', async () => {
      const { node } = buildFakes()
      sinon.stub(PolicyServer.prototype, 'passThrough').resolves({
        success: false,
        message: 'denied by policy',
        httpStatus: 403
      })

      const response = await new PolicyServerPassthroughHandler(node).handle(
        passthroughTask()
      )

      expect(response.status.httpStatus).to.equal(403)
      expect(response.status.error).to.equal('denied by policy')
      expect(response.stream).to.equal(null)
    })
  })
})

describe('PolicyServerInitializeHandler', () => {
  afterEach(() => sinon.restore())

  it('rejects a malformed consumerAddress (400)', async () => {
    const { node } = buildFakes()
    const response = await new PolicyServerInitializeHandler(node).handle(
      initializeTask({ consumerAddress: 'not-an-address' })
    )
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.contain('not a valid web3 address')
  })

  it('scopes the signature to its own command, not to PolicyServerPassthrough', async () => {
    const { node, validateAuthenticationOrToken } = buildFakes()
    sinon
      .stub(PolicyServer.prototype, 'initializePSVerification')
      .resolves({ success: true, message: 'ok', httpStatus: 200 })

    await new PolicyServerInitializeHandler(node).handle(initializeTask())

    expect(validateAuthenticationOrToken.firstCall.args[0].command).to.equal(
      PROTOCOL_COMMANDS.POLICY_SERVER_INITIALIZE
    )
    expect(validateAuthenticationOrToken.firstCall.args[0].command).to.not.equal(
      PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH
    )
  })

  it('rejects an unauthenticated request (401)', async () => {
    const { node } = buildFakes({
      authResult: { valid: false, error: 'Invalid signature' }
    })
    const initialize = sinon.stub(PolicyServer.prototype, 'initializePSVerification')

    const response = await new PolicyServerInitializeHandler(node).handle(
      initializeTask()
    )

    expect(response.status.httpStatus).to.equal(401)
    assert(initialize.notCalled, 'must not reach the policy server')
  })

  it('forwards the verified consumerAddress and the caller credentials', async () => {
    const { node } = buildFakes()
    const initialize = sinon
      .stub(PolicyServer.prototype, 'initializePSVerification')
      .resolves({ success: true, message: 'ok', httpStatus: 200 })

    const response = await new PolicyServerInitializeHandler(node).handle(
      initializeTask({ consumerAddress: VICTIM, authorization: TOKEN })
    )

    expect(response.status.httpStatus).to.equal(200)
    const [documentId, ddo, serviceId, consumerAddress, policyServer] =
      initialize.firstCall.args
    expect(documentId).to.equal(DDO.id)
    expect(ddo).to.deep.equal(DDO)
    expect(serviceId).to.equal('service-1')
    // verified address wins over the one the caller supplied
    expect(consumerAddress).to.equal(CONSUMER)
    expect(policyServer.some).to.equal('blob')
    expect(policyServer.authorization).to.equal(TOKEN)
    expect(policyServer.nonce).to.equal('1')
    expect(policyServer.signature).to.equal('0xsignature')
  })

  it('returns 404 when the DDO does not exist', async () => {
    const { node } = buildFakes({ ddo: null })
    const initialize = sinon.stub(PolicyServer.prototype, 'initializePSVerification')

    const response = await new PolicyServerInitializeHandler(node).handle(
      initializeTask()
    )

    expect(response.status.httpStatus).to.equal(404)
    assert(initialize.notCalled, 'must not reach the policy server')
  })
})
