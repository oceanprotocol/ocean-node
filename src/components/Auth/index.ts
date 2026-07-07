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
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { peerIdFromString } from '@libp2p/peer-id'
import { Readable } from 'node:stream'

const MAX_VERDICT_BYTES = 4096

async function readBounded(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > MAX_VERDICT_BYTES) {
      stream.destroy()
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
}

export class Auth {
  private authTokenDatabase: AuthTokenDatabase
  private jwtSecret: string
  private config: OceanNodeConfig
  private getP2PNode: () => OceanP2P | undefined

  public constructor(
    authTokenDatabase: AuthTokenDatabase,
    config: OceanNodeConfig,
    getP2PNode: () => OceanP2P | undefined = () => OceanNode.getInstance().getP2PNode()
  ) {
    this.authTokenDatabase = authTokenDatabase
    this.jwtSecret = config.jwtSecret
    this.config = config
    this.getP2PNode = getP2PNode
  }

  public getJwtSecret(): string {
    return this.jwtSecret
  }

  // eslint-disable-next-line require-await
  async getJWTToken(
    address: string,
    nonce: string,
    createdAt: number,
    signature?: string,
    issuerPeerId?: string,
    chainId?: string | null
  ): Promise<string> {
    const jwtToken = jwt.sign(
      {
        address,
        nonce,
        createdAt,
        signature,
        issuerPeerId,
        chainId
      },
      this.getJwtSecret()
    )

    return jwtToken
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

  private async validateRemoteToken(token: string): Promise<AuthToken | null> {
    const decoded = jwt.decode(token)
    if (!decoded || typeof decoded !== 'object') {
      return null
    }
    const { address, nonce, signature, createdAt, issuerPeerId, chainId } = decoded as {
      address?: string
      nonce?: string
      signature?: string
      createdAt?: number
      issuerPeerId?: string
      chainId?: string | null
    }
    if (
      typeof address !== 'string' ||
      typeof nonce !== 'string' ||
      typeof signature !== 'string' ||
      typeof issuerPeerId !== 'string'
    ) {
      return null
    }
    const signatureValid = await verifyConsumerSignature(
      address,
      nonce,
      signature,
      issuerPeerId,
      PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN,
      this.config,
      chainId
    )
    if (!signatureValid) {
      return null
    }
    try {
      peerIdFromString(issuerPeerId)
    } catch {
      return null
    }
    const p2p = this.getP2PNode()
    if (!p2p || p2p.isTargetPeerSelf(issuerPeerId)) {
      return null
    }
    const response = await p2p.sendTo(
      issuerPeerId,
      JSON.stringify({ command: PROTOCOL_COMMANDS.VALIDATE_AUTH_TOKEN, token })
    )
    if (response?.status?.httpStatus !== 200 || !response.stream) {
      return null
    }
    let verdict: { valid?: boolean; validUntil?: number | string | null }
    try {
      verdict = JSON.parse(await readBounded(response.stream as Readable))
    } catch {
      return null
    }
    if (!verdict.valid) {
      return null
    }
    const createdNum = Number(createdAt)
    return {
      token,
      address,
      created: Number.isFinite(createdNum) ? new Date(createdNum) : new Date(),
      validUntil:
        verdict.validUntil != null ? new Date(Number(verdict.validUntil)) : null,
      isValid: true
    }
  }

  /**
   * Validates the authentication or token
   * You need to provider either a token or an address, signature and message
   * @param {string} token - The token to validate
   * @param {string} address - The address to validate
   * @param {string} signature - The signature to validate
   * @param {string} message - The message to validate
   * @returns The validation result
   */
  async validateAuthenticationOrToken(
    authValidation: AuthValidation
  ): Promise<CommonValidation & { address?: string }> {
    const { token, address, nonce, signature, command, chainId } = authValidation
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
          chainId
        )

        if (!nonceCheckResult.valid) {
          return { valid: false, error: nonceCheckResult.error }
        }

        if (nonceCheckResult.valid) {
          return { valid: true, error: '', address }
        }
      }

      if (token) {
        const authToken = await this.validateToken(token)
        if (authToken) {
          return { valid: true, error: '', address: authToken.address }
        }

        return { valid: false, error: 'Invalid token' }
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
}
