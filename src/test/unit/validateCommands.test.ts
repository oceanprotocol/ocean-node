import { expect, assert } from 'chai'
import sinon from 'sinon'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { validateCommandParameters } from '../../components/httpRoutes/validateCommands.js'

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.fake.token'
const SIGNATURE = '0xdeadbeefsignature'
const ERC20 = '0x0000000000000000000000000000000000000abc'

// validateCommandParameters logs the whole command for every request (at debug), so
// anything that authorizes the request must be redacted before it reaches the logs
describe('validateCommandParameters credential redaction', () => {
  let debug: sinon.SinonStub

  beforeEach(() => {
    debug = sinon.stub(CORE_LOGGER, 'debug')
    sinon.stub(CORE_LOGGER, 'isLevelEnabled').returns(true)
  })
  afterEach(() => sinon.restore())

  function loggedCommand(): string {
    assert(debug.called, 'the command should have been logged')
    return debug.firstCall.args[0] as string
  }

  it('redacts the authorization token, signature and encrypted key material', () => {
    const command = {
      command: PROTOCOL_COMMANDS.DOWNLOAD,
      documentId: 'did:op:1234',
      consumerAddress: ERC20,
      nonce: '1',
      authorization: TOKEN,
      signature: SIGNATURE,
      aes_encrypted_key: 'secret-key-material'
    }

    const validation = validateCommandParameters(command, [])
    expect(validation.valid).to.equal(true)

    const logged = loggedCommand()
    expect(logged).to.not.contain(TOKEN)
    expect(logged).to.not.contain(SIGNATURE)
    expect(logged).to.not.contain('secret-key-material')
    expect(logged).to.contain('[REDACTED]')
    // non-sensitive fields are still logged, so the logs stay useful
    expect(logged).to.contain('did:op:1234')
    expect(logged).to.contain(ERC20)
    // the nonce pairs with the signature: redacted too
    expect(logged).to.contain('"nonce":"[REDACTED]"')
    // one line per command
    expect(logged).to.not.contain('\n')
  })

  it('does not build the payload dump when debug logging is off', () => {
    ;(CORE_LOGGER.isLevelEnabled as sinon.SinonStub).returns(false)
    const result = validateCommandParameters(
      { command: PROTOCOL_COMMANDS.NONCE, address: ERC20 },
      ['address']
    )
    expect(result.valid).to.equal(true)
    expect(debug.called).to.equal(false)
  })

  it('redacts file objects, headers, user data and storage credentials', () => {
    validateCommandParameters(
      {
        command: PROTOCOL_COMMANDS.FILE_INFO,
        files: [{ type: 'url', url: 'https://private.example.com/data.csv' }],
        file: {
          type: 's3',
          s3Access: { secretAccessKey: 'aws-secret', accessKeyId: 'aws-key-id' },
          headers: { Authorization: 'Bearer abc' }
        },
        userData: { apiKey: 'user-secret' }
      },
      []
    )
    const logged = loggedCommand()
    for (const secret of [
      'private.example.com',
      'aws-secret',
      'aws-key-id',
      'Bearer abc',
      'user-secret'
    ]) {
      expect(logged).to.not.contain(secret)
    }
    expect(logged).to.contain('"type":"s3"')
  })

  it('redacts encryptedDockerRegistryAuth on compute commands', () => {
    validateCommandParameters(
      {
        command: PROTOCOL_COMMANDS.COMPUTE_START,
        consumerAddress: ERC20,
        encryptedDockerRegistryAuth: 'registry-secret'
      },
      []
    )
    expect(loggedCommand()).to.not.contain('registry-secret')
  })

  it('redacts the auth token on invalidateAuthToken', () => {
    validateCommandParameters(
      {
        command: PROTOCOL_COMMANDS.INVALIDATE_AUTH_TOKEN,
        address: ERC20,
        nonce: '1',
        token: TOKEN
      },
      []
    )
    expect(loggedCommand()).to.not.contain(TOKEN)
  })

  it('redacts the auth token on validateAuthToken', () => {
    validateCommandParameters(
      { command: PROTOCOL_COMMANDS.VALIDATE_AUTH_TOKEN, token: TOKEN },
      []
    )
    expect(loggedCommand()).to.not.contain(TOKEN)
  })

  it('keeps "token" readable where it is an ERC20 address, not a credential', () => {
    validateCommandParameters(
      { command: PROTOCOL_COMMANDS.GET_ESCROW_EVENTS, chainId: 8996, token: ERC20 },
      []
    )
    expect(loggedCommand()).to.contain(ERC20)
  })

  it('redacts credentials nested inside the policyServerPassthrough blob', () => {
    validateCommandParameters(
      {
        command: PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH,
        consumerAddress: ERC20,
        policyServerPassthrough: {
          action: 'download',
          documentId: 'did:op:1234',
          authorization: TOKEN,
          signature: SIGNATURE
        }
      },
      []
    )
    const logged = loggedCommand()
    expect(logged).to.not.contain(TOKEN)
    expect(logged).to.not.contain(SIGNATURE)
    // the rest of the blob is still logged
    expect(logged).to.contain('did:op:1234')
    expect(logged).to.contain('download')
  })

  it('redacts credentials nested inside the policyServer blob', () => {
    validateCommandParameters(
      {
        command: PROTOCOL_COMMANDS.POLICY_SERVER_INITIALIZE,
        documentId: 'did:op:1234',
        serviceId: '0',
        consumerAddress: ERC20,
        policyServer: { authorization: TOKEN, signature: SIGNATURE }
      },
      []
    )
    const logged = loggedCommand()
    expect(logged).to.not.contain(TOKEN)
    expect(logged).to.not.contain(SIGNATURE)
  })

  it('redacts credentials nested arbitrarily deep, including inside arrays', () => {
    validateCommandParameters(
      {
        command: PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH,
        consumerAddress: ERC20,
        policyServerPassthrough: {
          nested: { deeper: [{ authorization: TOKEN }, { signature: SIGNATURE }] }
        }
      },
      []
    )
    const logged = loggedCommand()
    expect(logged).to.not.contain(TOKEN)
    expect(logged).to.not.contain(SIGNATURE)
  })

  it('does not mutate nested objects it shares with the caller', () => {
    // the shallow-clone fallback path shares nested references with the original, so
    // redaction must never write into them - handlers still need the real credentials
    const nested = { action: 'download', authorization: TOKEN, signature: SIGNATURE }
    const command: any = {
      command: PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH,
      consumerAddress: ERC20,
      policyServerPassthrough: nested,
      notCloneable: () => 'boom' // forces the shallow-clone fallback
    }
    validateCommandParameters(command, [])
    expect(loggedCommand()).to.not.contain(TOKEN)
    expect(nested.authorization).to.equal(TOKEN)
    expect(nested.signature).to.equal(SIGNATURE)
  })

  it('survives a circular payload', () => {
    const blob: any = { authorization: TOKEN }
    blob.self = blob
    validateCommandParameters(
      {
        command: PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH,
        consumerAddress: ERC20,
        policyServerPassthrough: blob
      },
      []
    )
    const logged = loggedCommand()
    expect(logged).to.not.contain(TOKEN)
    expect(logged).to.contain('[CIRCULAR]')
  })

  it('keeps "token" readable when nested as an ERC20 payment address', () => {
    validateCommandParameters(
      {
        command: PROTOCOL_COMMANDS.COMPUTE_START,
        consumerAddress: ERC20,
        payment: { chainId: 8996, token: ERC20 }
      },
      []
    )
    expect(loggedCommand()).to.contain(ERC20)
  })

  it('does not mutate the command it was given', () => {
    const command = {
      command: PROTOCOL_COMMANDS.DOWNLOAD,
      authorization: TOKEN,
      signature: SIGNATURE
    }
    validateCommandParameters(command, [])
    // redaction happens on a copy - handlers still need the real credentials
    expect(command.authorization).to.equal(TOKEN)
    expect(command.signature).to.equal(SIGNATURE)
  })

  it('redacts even when the command carries a non-cloneable stream', () => {
    // forces the shallow-clone fallback path (structuredClone throws on functions)
    const command: any = {
      command: PROTOCOL_COMMANDS.DOWNLOAD,
      authorization: TOKEN,
      notCloneable: () => 'boom'
    }
    validateCommandParameters(command, [])
    expect(loggedCommand()).to.not.contain(TOKEN)
    expect(command.authorization).to.equal(TOKEN)
  })

  it('still reports missing required fields', () => {
    const validation = validateCommandParameters(
      { command: PROTOCOL_COMMANDS.DOWNLOAD, authorization: TOKEN },
      ['documentId']
    )
    expect(validation.valid).to.equal(false)
    expect(validation.status).to.equal(400)
    expect(validation.reason).to.contain('documentId')
  })
})
