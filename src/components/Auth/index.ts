import { AuthToken, AuthTokenDatabase } from '../database/AuthTokenDatabase.js'
import jwt from 'jsonwebtoken'
import {
  checkNonce,
  NonceResponse,
  verifyConsumerSignature
} from '../core/utils/nonceHandler.js'
import { OceanNode } from '../../OceanNode.js'
import { CommonValidation } from '../../utils/validators.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { PROTOCOL_COMMANDS, MAX_AUTH_TOKEN_TTL_MS } from '../../utils/constants.js'
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

  public constructor(authTokenDatabase: AuthTokenDatabase, config: OceanNodeConfig) {
    this.authTokenDatabase = authTokenDatabase
    this.jwtSecret = config.jwtSecret
    this.config = config
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
    validUntil?: number | null,
    chainId?: string | null
  ): Promise<string> {
    const jwtToken = jwt.sign(
      {
        address,
        nonce,
        createdAt,
        signature,
        validUntil,
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
    return await this.validateSelfContainedToken(token)
  }

  private async validateSelfContainedToken(token: string): Promise<AuthToken | null> {
    const decoded = jwt.decode(token)
    if (!decoded || typeof decoded !== 'object') {
      return null
    }
    const { address, nonce, signature, createdAt, validUntil, chainId } = decoded as {
      address?: string
      nonce?: string
      signature?: string
      createdAt?: number
      validUntil?: number | null
      chainId?: string | null
    }
    if (
      typeof address !== 'string' ||
      typeof nonce !== 'string' ||
      typeof signature !== 'string' ||
      typeof validUntil !== 'number'
    ) {
      return null
    }
    // Enforce the max lifetime here too: a self-verifying token can be built
    // client-side, so the creation-time cap alone is not binding cross-node.
    if (
      !Number.isFinite(validUntil) ||
      Date.now() >= validUntil ||
      validUntil - Date.now() > MAX_AUTH_TOKEN_TTL_MS
    ) {
      return null
    }
    const signatureValid = await verifyConsumerSignature(
      address,
      nonce,
      signature,
      PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN,
      this.config,
      chainId,
      validUntil
    )
    if (!signatureValid) {
      return null
    }

    const createdNum = Number(createdAt)
    return {
      token,
      address,
      created: Number.isFinite(createdNum) ? new Date(createdNum) : new Date(),
      validUntil: new Date(validUntil),
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
