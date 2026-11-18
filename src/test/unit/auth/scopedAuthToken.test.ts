import { expect } from 'chai'
import jwt from 'jsonwebtoken'
import { Wallet } from 'ethers'
import {
  buildCreateAuthTokenSignatureMessage,
  AUTH_TOKEN_VERSION,
  STATUS_CHALLENGE_DOMAIN
} from '../../../utils/crypt.js'
import {
  DISALLOWED_TOKEN_SCOPE_COMMANDS,
  TOKEN_INELIGIBLE_COMMANDS,
  PROTOCOL_COMMANDS
} from '../../../utils/constants.js'
import { Auth } from '../../../components/Auth/index.js'
import { AuthTokenDatabase } from '../../../components/database/AuthTokenDatabase.js'
import { OceanNode } from '../../../OceanNode.js'
import { getConfiguration } from '../../../utils/index.js'
import { Database } from '../../../components/database/index.js'
import { KeyManager } from '../../../components/KeyManager/index.js'
import { BlockchainRegistry } from '../../../components/BlockchainRegistry/index.js'

// ──────────────────────────────────────────────────────────────────────────────────────────
// GOLDEN VECTORS — these MUST be byte-identical to the ocean.js test of the same name. If one
// byte changes here, change both repos (shared wire contract, plan §3.2 / §11).
// ──────────────────────────────────────────────────────────────────────────────────────────
const V = {
  ADDR: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  NONCE: '42',
  PEER: '16Uiu2HAmTEST',
  EXP: 1893456000000
}
const GOLDEN = {
  expOnly:
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc242createAuthToken16Uiu2HAmTEST|v:2|aud:|cmd:|exp:1893456000000',
  audOnly:
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc242createAuthToken16Uiu2HAmTEST|v:2|aud:16Uiu2HAmAAA,16Uiu2HAmBBB|cmd:|exp:1893456000000',
  scopeOnly:
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc242createAuthToken16Uiu2HAmTEST|v:2|aud:|cmd:download,query|exp:1893456000000',
  bothDedup:
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc242createAuthToken16Uiu2HAmTEST|v:2|aud:16Uiu2HAmAAA,16Uiu2HAmBBB|cmd:download,startCompute|exp:1893456000000',
  single:
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc242createAuthToken16Uiu2HAmTEST|v:2|aud:16Uiu2HAmONLY|cmd:download|exp:1893456000000'
}

describe('scoped auth token — signed message (golden vectors)', () => {
  const base = {
    address: V.ADDR,
    nonce: V.NONCE,
    issuerPeerId: V.PEER,
    validUntil: V.EXP
  }

  it('exp only (no aud/scope)', () => {
    expect(buildCreateAuthTokenSignatureMessage({ ...base })).to.equal(GOLDEN.expOnly)
  })
  it('audience only — dedup + sort', () => {
    expect(
      buildCreateAuthTokenSignatureMessage({
        ...base,
        audience: ['16Uiu2HAmBBB', '16Uiu2HAmAAA']
      })
    ).to.equal(GOLDEN.audOnly)
  })
  it('scope only — sort order', () => {
    expect(
      buildCreateAuthTokenSignatureMessage({ ...base, scope: ['query', 'download'] })
    ).to.equal(GOLDEN.scopeOnly)
  })
  it('both, with dedup', () => {
    expect(
      buildCreateAuthTokenSignatureMessage({
        ...base,
        audience: ['16Uiu2HAmBBB', '16Uiu2HAmAAA', '16Uiu2HAmBBB'],
        scope: ['startCompute', 'download', 'download']
      })
    ).to.equal(GOLDEN.bothDedup)
  })
  it('single element each', () => {
    expect(
      buildCreateAuthTokenSignatureMessage({
        ...base,
        audience: ['16Uiu2HAmONLY'],
        scope: ['download']
      })
    ).to.equal(GOLDEN.single)
  })
  it('AUTH_TOKEN_VERSION is 2 and embedded in the bytes', () => {
    expect(AUTH_TOKEN_VERSION).to.equal(2)
    expect(GOLDEN.expOnly).to.contain('|v:2|')
  })
  it('STATUS_CHALLENGE_DOMAIN matches the shared contract', () => {
    expect(STATUS_CHALLENGE_DOMAIN).to.equal('ocean-node-status-challenge-v1:')
  })
})

describe('scoped auth token — disallowed-scope / ineligible constants', () => {
  it('DECRYPT_DDO and mutating admin are disallowed in scope', () => {
    for (const c of [
      PROTOCOL_COMMANDS.DECRYPT_DDO,
      PROTOCOL_COMMANDS.STOP_NODE,
      PROTOCOL_COMMANDS.STOP_JOB,
      PROTOCOL_COMMANDS.HANDLE_INDEXING_THREAD,
      PROTOCOL_COMMANDS.SET_MAINTENANCE,
      PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN,
      PROTOCOL_COMMANDS.VALIDATE_AUTH_TOKEN
    ]) {
      expect(DISALLOWED_TOKEN_SCOPE_COMMANDS).to.include(c)
    }
  })
  it('fetchConfig / getLogs are NOT disallowed in scope', () => {
    expect(DISALLOWED_TOKEN_SCOPE_COMMANDS).to.not.include(PROTOCOL_COMMANDS.FETCH_CONFIG)
    expect(DISALLOWED_TOKEN_SCOPE_COMMANDS).to.not.include(PROTOCOL_COMMANDS.GET_LOGS)
  })
  it('DECRYPT_DDO + mutating admin are token-INELIGIBLE at consumption', () => {
    expect(TOKEN_INELIGIBLE_COMMANDS).to.include(PROTOCOL_COMMANDS.DECRYPT_DDO)
    expect(TOKEN_INELIGIBLE_COMMANDS).to.include(PROTOCOL_COMMANDS.STOP_NODE)
    // read-only admin and ordinary read commands are eligible
    expect(TOKEN_INELIGIBLE_COMMANDS).to.not.include(PROTOCOL_COMMANDS.GET_LOGS)
    expect(TOKEN_INELIGIBLE_COMMANDS).to.not.include(PROTOCOL_COMMANDS.DOWNLOAD)
  })
})

describe('scoped auth token — claims + enforcement', () => {
  let authTokenDatabase: AuthTokenDatabase
  let auth: Auth
  let wallet: Wallet
  let selfPeerId: string
  const nonce = () => Math.floor(Math.random() * 1e9).toString()

  before(async () => {
    const config = await getConfiguration(true)
    authTokenDatabase = await AuthTokenDatabase.create(config.dbConfig)
    auth = new Auth(authTokenDatabase, config)
    wallet = new Wallet(process.env.PRIVATE_KEY)
    // SQLite-core-only DB (no metadata DB needed for auth); build a minimal OceanNode so the
    // enforcement path (which reads the node's own peerId) has a singleton.
    const db = await Database.init({ url: 'http://localhost:9999', dbType: 'none' } as any)
    const keyManager = new KeyManager(config)
    const blockchainRegistry = new BlockchainRegistry(keyManager, config)
    OceanNode.getInstance(
      config,
      db,
      undefined,
      undefined,
      undefined,
      keyManager,
      blockchainRegistry,
      true
    )
    selfPeerId = keyManager.getPeerIdString()
  })

  async function mintLocalToken(scoped?: {
    audience?: string[]
    scope?: string[]
    validUntil?: number
  }) {
    const createdAt = Date.now()
    const validUntil = scoped?.validUntil ?? createdAt + 60_000
    const token = await auth.getJWTToken(
      wallet.address,
      nonce(),
      createdAt,
      'sig',
      selfPeerId,
      null,
      scoped
        ? {
            version: AUTH_TOKEN_VERSION,
            audience: scoped.audience,
            scope: scoped.scope,
            validUntil
          }
        : undefined
    )
    await auth.insertToken(wallet.address, token, validUntil, createdAt, null)
    return token
  }

  it('legacy getJWTToken emits NO v/audience/scope/validUntil claims', async () => {
    const token = await auth.getJWTToken(wallet.address, nonce(), Date.now())
    const claims: any = jwt.decode(token)
    expect(claims.v).to.equal(undefined)
    expect(claims.audience).to.equal(undefined)
    expect(claims.scope).to.equal(undefined)
    expect(claims.validUntil).to.equal(undefined)
  })

  it('v2 getJWTToken emits v=2 + the signed fields verbatim', async () => {
    const token = await mintLocalToken({
      audience: [selfPeerId],
      scope: ['download'],
      validUntil: Date.now() + 60_000
    })
    const claims: any = jwt.decode(token)
    expect(claims.v).to.equal(2)
    expect(claims.audience).to.deep.equal([selfPeerId])
    expect(claims.scope).to.deep.equal(['download'])
    expect(typeof claims.validUntil).to.equal('number')
  })

  it('accepts a v2 token used IN audience', async () => {
    const token = await mintLocalToken({ audience: [selfPeerId] })
    const res = await auth.validateAuthenticationOrToken({
      token,
      command: PROTOCOL_COMMANDS.DOWNLOAD
    })
    expect(res.valid).to.equal(true)
  })

  it('rejects a v2 token used OUT of audience', async () => {
    const token = await mintLocalToken({ audience: ['16Uiu2HAmNOTME'] })
    const res = await auth.validateAuthenticationOrToken({
      token,
      command: PROTOCOL_COMMANDS.DOWNLOAD
    })
    expect(res.valid).to.equal(false)
    expect(res.error).to.contain('audience')
  })

  it('accepts a command IN scope and rejects one OUT of scope', async () => {
    const token = await mintLocalToken({ scope: ['download'] })
    const ok = await auth.validateAuthenticationOrToken({
      token,
      command: PROTOCOL_COMMANDS.DOWNLOAD
    })
    expect(ok.valid).to.equal(true)
    const bad = await auth.validateAuthenticationOrToken({
      token,
      command: PROTOCOL_COMMANDS.QUERY
    })
    expect(bad.valid).to.equal(false)
    expect(bad.error).to.contain('scope')
  })

  it('rejects ANY token (even unrestricted) for a token-ineligible command', async () => {
    // unrestricted v2 token (v=2, validUntil, but no scope/audience)
    const token = await mintLocalToken({ validUntil: Date.now() + 60_000 })
    const res = await auth.validateAuthenticationOrToken({
      token,
      command: PROTOCOL_COMMANDS.DECRYPT_DDO
    })
    expect(res.valid).to.equal(false)
    expect(res.error).to.contain('requires a request signature')
  })
})
