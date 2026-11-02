import { expect, assert } from 'chai'
import sinon from 'sinon'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import {
  redactCommandForLogging,
  validateCommandParameters
} from '../../components/httpRoutes/validateCommands.js'
import { Readable } from 'stream'

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

  it('redacts file-object credentials (headers, s3 keys) nested in datasets', () => {
    validateCommandParameters(
      {
        command: PROTOCOL_COMMANDS.FREE_COMPUTE_START,
        consumerAddress: ERC20,
        datasets: [
          {
            fileObject: {
              type: 's3',
              headers: { Authorization: 'Bearer file-object-token' },
              s3Access: {
                accessKeyId: 's3-key-id',
                secretAccessKey: 's3-secret-value'
              }
            }
          }
        ]
      },
      []
    )
    const logged = loggedCommand()
    expect(logged).to.not.contain('file-object-token')
    expect(logged).to.not.contain('s3-key-id')
    expect(logged).to.not.contain('s3-secret-value')
    expect(logged).to.contain('[REDACTED]')
  })

  it('redacts the plaintext blob on encrypt', () => {
    validateCommandParameters(
      {
        command: PROTOCOL_COMMANDS.ENCRYPT,
        blob: 'super-secret-plaintext',
        encoding: 'string',
        encryptionType: 'ECIES'
      },
      []
    )
    const logged = loggedCommand()
    expect(logged).to.not.contain('super-secret-plaintext')
    expect(logged).to.contain('[REDACTED]')
    // the encoding is non-sensitive and still logged
    expect(logged).to.contain('string')
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

  it('redacts a "token" credential on policyServerPassthrough', () => {
    validateCommandParameters(
      {
        command: PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH,
        consumerAddress: ERC20,
        policyServerPassthrough: { action: 'download', token: TOKEN }
      },
      []
    )
    expect(loggedCommand()).to.not.contain(TOKEN)
  })

  it('redacts credential fields regardless of casing', () => {
    validateCommandParameters(
      {
        command: PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH,
        consumerAddress: ERC20,
        policyServerPassthrough: {
          Authorization: TOKEN,
          Signature: SIGNATURE,
          s3Access: { AccessKeyId: 's3-key-id', SecretAccessKey: 's3-secret-value' }
        }
      },
      []
    )
    const logged = loggedCommand()
    expect(logged).to.not.contain(TOKEN)
    expect(logged).to.not.contain(SIGNATURE)
    expect(logged).to.not.contain('s3-key-id')
    expect(logged).to.not.contain('s3-secret-value')
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

// redactCommandForLogging is the shared redactor used by both the HTTP command logging and
// the P2P inbound/forward paths, so credentials are stripped consistently on every path
describe('redactCommandForLogging', () => {
  function logged(command: any): string {
    return JSON.stringify(redactCommandForLogging(command))
  }

  it('redacts credentials without mutating the original command', () => {
    const command: any = {
      command: PROTOCOL_COMMANDS.DOWNLOAD,
      documentId: 'did:op:1234',
      signature: SIGNATURE,
      authorization: TOKEN
    }
    const out = logged(command)
    expect(out).to.not.contain(SIGNATURE)
    expect(out).to.not.contain(TOKEN)
    expect(out).to.contain('did:op:1234')
    // original keeps the real credentials for the handler
    expect(command.signature).to.equal(SIGNATURE)
    expect(command.authorization).to.equal(TOKEN)
  })

  it('redacts file-object headers and s3 keys nested in datasets', () => {
    const out = logged({
      command: PROTOCOL_COMMANDS.FREE_COMPUTE_START,
      consumerAddress: ERC20,
      datasets: [
        {
          fileObject: {
            headers: { Authorization: 'file-object-token' },
            s3Access: { accessKeyId: 's3-key-id', secretAccessKey: 's3-secret-value' }
          }
        }
      ]
    })
    expect(out).to.not.contain('file-object-token')
    expect(out).to.not.contain('s3-key-id')
    expect(out).to.not.contain('s3-secret-value')
  })

  it('redacts the raw algorithm source (algorithm.meta.rawcode)', () => {
    const out = logged({
      command: PROTOCOL_COMMANDS.FREE_COMPUTE_START,
      consumerAddress: ERC20,
      algorithm: { meta: { rawcode: "console.log('secret-algo-source')" } }
    })
    expect(out).to.not.contain('secret-algo-source')
  })

  it('redacts the encrypt plaintext blob', () => {
    const out = logged({
      command: PROTOCOL_COMMANDS.ENCRYPT,
      blob: 'super-secret-plaintext'
    })
    expect(out).to.not.contain('super-secret-plaintext')
  })

  it('strips user:password credentials from FTP URLs in file objects', () => {
    const out = logged({
      command: PROTOCOL_COMMANDS.FILE_INFO,
      type: 'ftp',
      url: 'ftp://ftp-user:ftp-secret@host.example/path/file.csv'
    })
    expect(out).to.not.contain('ftp-user')
    expect(out).to.not.contain('ftp-secret')
    // the non-secret host/path is kept, useful for debugging
    expect(out).to.contain('host.example')
  })

  it('strips presigned query tokens from URLs in file objects', () => {
    const out = logged({
      command: PROTOCOL_COMMANDS.FILE_INFO,
      type: 'url',
      url: 'https://host.example/file?X-Amz-Signature=presigned-token-value'
    })
    expect(out).to.not.contain('presigned-token-value')
    expect(out).to.contain('host.example')
  })

  it('summarizes a non-cloneable request stream instead of throwing', () => {
    const out = logged({
      command: PROTOCOL_COMMANDS.DOWNLOAD,
      signature: SIGNATURE,
      stream: Readable.from(['body'])
    })
    expect(out).to.not.contain(SIGNATURE)
    expect(out).to.contain('[STREAM]')
  })
})
