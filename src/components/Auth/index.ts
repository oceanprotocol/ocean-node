import { AuthToken, AuthTokenDatabase } from '../database/AuthTokenDatabase.js'
import jwt from 'jsonwebtoken'
import {
  checkNonce,
  NonceResponse,
  verifyConsumerSignature
} from '../core/utils/nonceHandler.js'
import { OceanNode } from '../../OceanNode.js'
import { OceanP2P } from '../P2P/index.js'
import { CommonValidation } from '../../utils/validators.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { PROTOCOL_COMMANDS, TOKEN_INELIGIBLE_COMMANDS } from '../../utils/constants.js'
import { AUTH_TOKEN_VERSION } from '../../utils/crypt.js'
import { peerIdFromString } from '@libp2p/peer-id'
import { Readable } from 'node:stream'
import { CORE_LOGGER } from '../../utils/logging/common.js'

const MAX_VERDICT_BYTES = 4096
// Bound the positive-verdict cache so a flood of distinct foreign tokens cannot grow it without
// limit. Simple cap with lazy expired-eviction + oldest-first eviction on insert (plan §7.1).
const MAX_VERDICT_CACHE_ENTRIES = 10_000

/**
 * Reads a bounded validation verdict off a P2P response body.
 *
 * `destroy` is called only when the source actually has it. The parameter is typed `Readable`,
 * but what `sendTo` hands back is a bare async iterable over the response frames with no
 * `destroy` method, so calling it unconditionally replaced the size error with a `TypeError`
 * and the caller never saw why the verdict was rejected. Throwing out of the `for await` is
 * what releases such a source anyway: the loop calls the iterator's `return()`, which is where
 * that iterator resets the stream.
 */
async function readBounded(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > MAX_VERDICT_BYTES) {
      const destroy = (stream as { destroy?: unknown } | null)?.destroy
      if (typeof destroy === 'function') {
        try {
          destroy.call(stream)
        } catch {}
      }
      throw new Error('validation response too large')
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString()
}

export interface AuthValidation {
  token?: string
  address?: string
  nonce?: string
  signature?: string
  command?: string
  chainId?: string | null
  // ON-02: resource-binding fields appended to the signed message ONLY for DECRYPT_DDO.
  txId?: string
  dataNftAddress?: string
}

// Decoded v2 scoped-token claims (plan §4). Omitted fields stay absent.
interface DecodedTokenClaims {
  v?: number
  address?: string
  nonce?: string
  signature?: string
  createdAt?: number
  issuerPeerId?: string
  chainId?: string | null
  audience?: string[]
  scope?: string[]
  validUntil?: number
}

// A positive foreign-dial verdict (plan §7.1). Only successful verdicts are cached.
interface CachedVerdict {
  validUntil: number
  lastConfirmedAt: number
}

export class Auth {
  private authTokenDatabase: AuthTokenDatabase
  private jwtSecret: string
  private config: OceanNodeConfig
  private getP2PNode: () => OceanP2P | undefined
  // Scoped-token policy knobs (plan §8).
  private maxTokenLifetimeMs: number
  private revocationFallback: 'closed' | 'cache' | 'open'
  private softFailGraceMs: number
  private revalidateIntervalMs: number
  private allowCrossNodeTokens: boolean
  private trustedTokenIssuers: Set<string>
  // In-memory, per-process positive-verdict cache for foreign tokens (plan §7.1).
  private verdictCache: Map<string, CachedVerdict> = new Map()

  public constructor(
    authTokenDatabase: AuthTokenDatabase,
    config: OceanNodeConfig,
    getP2PNode: () => OceanP2P | undefined = () => OceanNode.getInstance().getP2PNode()
  ) {
    this.authTokenDatabase = authTokenDatabase
    this.jwtSecret = config.jwtSecret
    this.config = config
    this.getP2PNode = getP2PNode
    this.maxTokenLifetimeMs = (config.maxTokenLifetime ?? 86400) * 1000
    this.revocationFallback = config.tokenRevocationFallback ?? 'cache'
    this.softFailGraceMs = (config.tokenSoftFailGrace ?? 300) * 1000
    this.revalidateIntervalMs = (config.tokenRevalidateInterval ?? 60) * 1000
    this.allowCrossNodeTokens = config.allowCrossNodeTokens ?? false
    this.trustedTokenIssuers = new Set(config.trustedTokenIssuers ?? [])
    // Loud startup warning when revocation is fail-OPEN (plan §8.1): revoked tokens may be honored
    // during an issuer outage. 'closed'/'cache' are quiet.
    if (this.revocationFallback === 'open') {
      CORE_LOGGER.warn(
        'auth-token revocation is fail-OPEN (TOKEN_REVOCATION_FALLBACK=open): any signature-valid, ' +
          'unexpired token may be honored while its issuer is unreachable, including never-before-seen ' +
          'tokens. Revoked tokens may be accepted during an outage (bounded by MAX_TOKEN_LIFETIME).'
      )
    }
  }

  public getJwtSecret(): string {
    return this.jwtSecret
  }

  public getMaxTokenLifetimeMs(): number {
    return this.maxTokenLifetimeMs
  }

  // eslint-disable-next-line require-await
  async getJWTToken(
    address: string,
    nonce: string,
    createdAt: number,
    signature?: string,
    issuerPeerId?: string,
    chainId?: string | null,
    // v2 scoped-token claims (plan §4). Passing `version === 2` emits the v2 claim set; omitting
    // it keeps today's EXACT legacy claim set (no `v`, no audience/scope/validUntil claims).
    scopedClaims?: {
      version?: number
      audience?: string[]
      scope?: string[]
      validUntil?: number
    }
  ): Promise<string> {
    // Claim ⇄ signed-field invariant (plan §3.3): every signed field is stored verbatim; the
    // server never derives/defaults/clamps a signed field. Legacy tokens carry no `v`.
    const payload: Record<string, unknown> = {
      address,
      nonce,
      createdAt,
      signature,
      issuerPeerId,
      chainId
    }
    if (scopedClaims?.version === AUTH_TOKEN_VERSION) {
      payload.v = AUTH_TOKEN_VERSION
      // audience/scope present only when a non-empty list was signed (omitted ⇒ unrestricted).
      if (scopedClaims.audience && scopedClaims.audience.length) {
        payload.audience = scopedClaims.audience
      }
      if (scopedClaims.scope && scopedClaims.scope.length) {
        payload.scope = scopedClaims.scope
      }
      // validUntil is required (signed) in v2.
      payload.validUntil = scopedClaims.validUntil
    }
    return jwt.sign(payload, this.getJwtSecret())
  }

  async insertToken(
    address: string,
    jwtToken: string,
    validUntil: number,
    createdAt: number,
    chainId?: string | null
  ): Promise<void> {
    await this.authTokenDatabase.createToken(
      jwtToken,
      address,
      validUntil,
      createdAt,
      chainId
    )
  }

  async invalidateToken(jwtToken: string): Promise<void> {
    // Evict any cached positive verdict so a revoked token stops being soft-fail-eligible.
    this.verdictCache.delete(jwtToken)
    await this.authTokenDatabase.invalidateToken(jwtToken)
  }

  async validateToken(token: string): Promise<AuthToken | null> {
    const tokenEntry = await this.authTokenDatabase.validateToken(token)
    if (tokenEntry) {
      return tokenEntry
    }
    return await this.validateRemoteToken(token)
  }

  async getLocalToken(token: string): Promise<AuthToken | null> {
    return await this.authTokenDatabase.validateToken(token)
  }

  // Lazily drop expired entries and keep the cache bounded (plan §7.1).
  private pruneVerdictCache(now: number): void {
    for (const [key, entry] of this.verdictCache) {
      if (now >= entry.validUntil) {
        this.verdictCache.delete(key)
      }
    }
    while (this.verdictCache.size >= MAX_VERDICT_CACHE_ENTRIES) {
      const oldest = this.verdictCache.keys().next().value
      if (oldest === undefined) break
      this.verdictCache.delete(oldest)
    }
  }

  private buildAuthTokenFromCache(
    token: string,
    address: string,
    createdAt?: number,
    validUntilMs?: number
  ): AuthToken {
    const createdNum = Number(createdAt)
    return {
      token,
      address,
      created: Number.isFinite(createdNum) ? new Date(createdNum) : new Date(),
      validUntil: new Date(validUntilMs),
      isValid: true
    }
  }

  private async validateRemoteToken(token: string): Promise<AuthToken | null> {
    const decoded = jwt.decode(token)
    if (!decoded || typeof decoded !== 'object') {
      return null
    }
    const {
      address,
      nonce,
      signature,
      createdAt,
      issuerPeerId,
      chainId,
      v,
      audience,
      scope,
      validUntil: signedValidUntil
    } = decoded as DecodedTokenClaims
    if (
      typeof address !== 'string' ||
      typeof nonce !== 'string' ||
      typeof signature !== 'string' ||
      typeof issuerPeerId !== 'string'
    ) {
      return null
    }

    // A version we do not implement must be rejected outright — never interpret an unknown format
    // (plan §3.4). Legacy tokens (no `v`) are allowed.
    if (v != null && v !== AUTH_TOKEN_VERSION) {
      CORE_LOGGER.debug(`Rejecting foreign token: unsupported version ${v}`)
      return null
    }

    // Strict v2 semantics: a token that CLAIMS v2 MUST carry a signed numeric `validUntil`. Without
    // this, a v2 claim with no `validUntil` would make the signature check fall back to the legacy
    // message builder (isV2CreateAuthToken ⇒ false), letting a legacy token's signature be replayed
    // as a malformed "v2" token. Not a privilege escalation (legacy is already unrestricted) but it
    // breaks the claim⇄signed invariant and is loose under the `open` revocation fallback — reject.
    if (v === AUTH_TOKEN_VERSION && typeof signedValidUntil !== 'number') {
      CORE_LOGGER.debug('Rejecting foreign token: v2 token missing validUntil')
      return null
    }

    // ── Lever B federation gate (plan §17.1) — FIRST, before any crypto or dial. Only foreign
    // tokens reach here (self-issued tokens are served from the local DB path). Also the ON-03(3)
    // DoS mitigation: non-federated / junk tokens are rejected on a cheap check.
    if (!this.allowCrossNodeTokens) {
      CORE_LOGGER.debug(
        'Rejecting foreign token: cross-node tokens disabled on this node'
      )
      return null
    }
    if (!this.trustedTokenIssuers.has(issuerPeerId)) {
      CORE_LOGGER.debug(
        `Rejecting foreign token: cross-node issuer not federated (${issuerPeerId})`
      )
      return null
    }

    // ── Cheap parse + self / no-P2P guards BEFORE the expensive ECDSA/dial (plan §6.3).
    try {
      peerIdFromString(issuerPeerId)
    } catch {
      return null
    }
    const p2p = this.getP2PNode()
    if (!p2p || p2p.isTargetPeerSelf(issuerPeerId)) {
      return null
    }

    // ── Audience BEFORE dial (plan §18.4): an out-of-audience foreign token must never cost a
    // dial (or an ECDSA verify). §6.1 still enforces audience on the local path.
    if (v === AUTH_TOKEN_VERSION && Array.isArray(audience) && audience.length) {
      const selfPeerId = OceanNode.getInstance().getKeyManager().getPeerIdString()
      if (!audience.includes(selfPeerId)) {
        CORE_LOGGER.debug('Rejecting foreign token: node not in audience')
        return null
      }
    }

    // ── Consumer signature, rebuilt from the SAME claims (plan §6.2). For v2 the rebuilt message
    // includes version/audience/scope/exp, so a tampered claim fails verification. ERC-1271
    // fan-out is capped on the token path when chainId is null (plan §18.4).
    const signatureValid = await verifyConsumerSignature(
      address,
      nonce,
      signature,
      issuerPeerId,
      PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN,
      this.config,
      chainId,
      v === AUTH_TOKEN_VERSION
        ? { audience, scope, validUntil: signedValidUntil }
        : undefined,
      true // tokenPath: cap the ERC-1271 multi-network fan-out
    )
    if (!signatureValid) {
      return null
    }

    // Defense in depth: a v2 token's signed validUntil also bounds it here.
    if (
      v === AUTH_TOKEN_VERSION &&
      typeof signedValidUntil === 'number' &&
      signedValidUntil <= Date.now()
    ) {
      return null
    }

    const now = Date.now()

    // ── Fast path: a recent positive confirmation suppresses the dial (plan §7.2).
    const cached = this.verdictCache.get(token)
    if (
      cached &&
      now < cached.validUntil &&
      now - cached.lastConfirmedAt < this.revalidateIntervalMs
    ) {
      return this.buildAuthTokenFromCache(token, address, createdAt, cached.validUntil)
    }

    // ── Revocation / liveness dial.
    let response
    let unreachable = false
    try {
      response = await p2p.sendTo(
        issuerPeerId,
        JSON.stringify({ command: PROTOCOL_COMMANDS.VALIDATE_AUTH_TOKEN, token })
      )
    } catch {
      unreachable = true
    }
    if (!unreachable && (response?.status?.httpStatus !== 200 || !response.stream)) {
      unreachable = true
    }

    let verdict: { valid?: boolean; validUntil?: number | string | null } | null = null
    if (!unreachable) {
      try {
        verdict = JSON.parse(await readBounded(response.stream as Readable))
      } catch {
        unreachable = true
      }
    }

    if (unreachable) {
      // Outcome 3 — issuer unreachable: apply the configured fallback (plan §7.2).
      switch (this.revocationFallback) {
        case 'open':
          // fail-open: trust the signature + claims, no revocation. Bounded by the signed/claim
          // validUntil (and the DB-side cap). Never written to the positive cache.
          CORE_LOGGER.debug(
            'Issuer unreachable; accepting foreign token under fail-OPEN revocation policy'
          )
          return this.buildAuthTokenFromClaims(
            token,
            address,
            createdAt,
            signedValidUntil
          )
        case 'cache':
          if (
            cached &&
            now < cached.validUntil &&
            now - cached.lastConfirmedAt < this.softFailGraceMs
          ) {
            return this.buildAuthTokenFromCache(
              token,
              address,
              createdAt,
              cached.validUntil
            )
          }
          return null
        case 'closed':
        default:
          return null
      }
    }

    // Outcome 2 — issuer reachable but says invalid / unparseable verdict: reject hard + evict.
    if (!verdict || !verdict.valid || verdict.validUntil == null) {
      this.verdictCache.delete(token)
      return null
    }
    const validUntilMs = Number(verdict.validUntil)
    if (!Number.isFinite(validUntilMs) || validUntilMs <= now) {
      this.verdictCache.delete(token)
      return null
    }

    // Outcome 1 — issuer confirms valid: refresh the positive cache.
    this.pruneVerdictCache(now)
    this.verdictCache.set(token, { validUntil: validUntilMs, lastConfirmedAt: now })
    return this.buildAuthTokenFromCache(token, address, createdAt, validUntilMs)
  }

  // `open`-mode only: build the AuthToken from decoded claims WITHOUT touching the positive cache
  // (an unconfirmed token must never later satisfy `cache` mode). Bounded by validUntil (plan §7.2).
  private buildAuthTokenFromClaims(
    token: string,
    address: string,
    createdAt?: number,
    signedValidUntil?: number
  ): AuthToken | null {
    // In `open` mode a legacy token has no signed validUntil; fall back to the max lifetime from
    // createdAt so we never mint an unbounded token.
    const now = Date.now()
    const createdNum = Number(createdAt)
    const fallback = Number.isFinite(createdNum)
      ? createdNum + this.maxTokenLifetimeMs
      : now + this.maxTokenLifetimeMs
    const requested =
      typeof signedValidUntil === 'number' && signedValidUntil > now
        ? signedValidUntil
        : fallback
    // Always bound by THIS node's MAX_TOKEN_LIFETIME (plan §7.3): a trusted-but-compromised issuer
    // with a larger cap must not get a longer-lived token honored here during an outage.
    const validUntilMs = Math.min(requested, now + this.maxTokenLifetimeMs)
    if (validUntilMs <= now) return null
    return this.buildAuthTokenFromCache(token, address, createdAt, validUntilMs)
  }

  /**
   * Validates the authentication or token
   * You need to provide either a token or an address, signature and nonce.
   * For v2 tokens this ALSO enforces audience / scope / expiry from the signed claims, and
   * rejects a token presented for a token-ineligible command (plan §6.1, §18.1).
   */
  async validateAuthenticationOrToken(
    authValidation: AuthValidation
  ): Promise<CommonValidation & { address?: string }> {
    const { token, address, nonce, signature, command, chainId, txId, dataNftAddress } =
      authValidation
    try {
      if (signature && address && nonce) {
        const oceanNode = OceanNode.getInstance()
        const nonceCheckResult: NonceResponse = await checkNonce(
          oceanNode.getConfig(),
          (await oceanNode.getDatabase()).nonce,
          address,
          parseInt(nonce),
          signature,
          command,
          chainId,
          { txId, dataNftAddress }
        )

        if (!nonceCheckResult.valid) {
          return { valid: false, error: nonceCheckResult.error }
        }

        return { valid: true, error: '', address }
      }

      if (token) {
        // HIGH (plan §18.1): a bearer token is NEVER accepted for a token-ineligible command,
        // even an unrestricted one. These require a fresh single-use nonce-bound signature.
        if (command && TOKEN_INELIGIBLE_COMMANDS.includes(command)) {
          return {
            valid: false,
            error: 'this command requires a request signature, not an auth token'
          }
        }

        const authToken = await this.validateToken(token)
        if (!authToken) {
          return { valid: false, error: 'Invalid token' }
        }

        // Enforce v2 audience / scope / expiry from the signed claims (plan §6.1). The claims are
        // trustworthy: for self/local tokens the exact JWT string is the DB key (tamper ⇒ miss);
        // for foreign tokens validateRemoteToken re-verified the signature over these claims.
        const scopeCheck = this.enforceScopedClaims(token, command)
        if (!scopeCheck.valid) {
          return scopeCheck
        }

        return { valid: true, error: '', address: authToken.address }
      }

      return {
        valid: false,
        error:
          'Invalid authentication, you need to provide either a token or an address, signature, message and nonce'
      }
    } catch (e) {
      return { valid: false, error: `Error during authentication validation: ${e}` }
    }
  }

  // Enforce the v2 claims (audience / scope / expiry) from the token itself (plan §6.1). Distinct
  // error strings per gate for debuggability (plan §10).
  private enforceScopedClaims(
    token: string,
    command?: string
  ): CommonValidation & { address?: string } {
    const decoded = jwt.decode(token) as DecodedTokenClaims | null
    if (!decoded || typeof decoded !== 'object') {
      return { valid: true, error: '' }
    }
    // Unknown / unsupported version ⇒ reject outright (never interpret an unknown format).
    if (decoded.v != null && decoded.v !== AUTH_TOKEN_VERSION) {
      return { valid: false, error: 'unsupported token version' }
    }
    if (decoded.v === AUTH_TOKEN_VERSION) {
      // Strict v2 semantics (belt to validateRemoteToken's suspenders): a v2 token MUST carry a
      // signed numeric validUntil. A self/local v2 token always does (the issuer sets it); this
      // also rejects any malformed v2 claim that reaches the chokepoint.
      if (typeof decoded.validUntil !== 'number') {
        return { valid: false, error: 'invalid v2 token (missing validUntil)' }
      }
      // audience
      if (Array.isArray(decoded.audience) && decoded.audience.length) {
        const selfPeerId = OceanNode.getInstance().getKeyManager().getPeerIdString()
        if (!decoded.audience.includes(selfPeerId)) {
          return { valid: false, error: 'token not valid at this node (audience)' }
        }
      }
      // scope
      if (Array.isArray(decoded.scope) && decoded.scope.length) {
        if (!command || !decoded.scope.includes(command)) {
          return { valid: false, error: 'token not permitted for this command (scope)' }
        }
      }
      // expiry (defense in depth; DB/dial already enforce, but the claim is signed)
      if (typeof decoded.validUntil === 'number' && decoded.validUntil <= Date.now()) {
        return { valid: false, error: 'token expired' }
      }
    }
    return { valid: true, error: '' }
  }
}
