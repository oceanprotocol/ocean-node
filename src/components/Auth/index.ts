import { AuthToken, AuthTokenDatabase } from '../database/AuthTokenDatabase.js'
import jwt from 'jsonwebtoken'
import { checkNonce, NonceResponse } from '../core/utils/nonceHandler.js'
import { OceanNode } from '../../OceanNode.js'

export interface CommonValidation {
  valid: boolean
  error: string
}

export class Auth {
  private authTokenDatabase: AuthTokenDatabase
  private jwtSecret: string

  public constructor(authTokenDatabase: AuthTokenDatabase) {
    this.authTokenDatabase = authTokenDatabase
    this.jwtSecret = process.env.JWT_SECRET || 'ocean-node-secret'
  }

  public getJwtSecret(): string {
    return this.jwtSecret
  }

  public getMessage(address: string, nonce: string): string {
    return address + nonce
  }

  getJWTToken(address: string, nonce: string, createdAt: number): string {
    const jwtToken = jwt.sign(
      {
        address,
        nonce,
        createdAt
      },
      this.getJwtSecret()
    )

    return jwtToken
  }

  async insertToken(
    address: string,
    jwtToken: string,
    validUntil: number,
    createdAt: number
  ): Promise<void> {
    await this.authTokenDatabase.createToken(jwtToken, address, validUntil, createdAt)
  }

  async invalidateToken(jwtToken: string): Promise<void> {
    await this.authTokenDatabase.invalidateToken(jwtToken)
  }

  async validateToken(token: string): Promise<AuthToken | null> {
    const tokenEntry = await this.authTokenDatabase.validateToken(token)
    if (!tokenEntry) {
      return null
    }
    return tokenEntry
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
  async validateAuthenticationOrToken({
    token,
    address,
    nonce,
    signature
  }: {
    token?: string
    address?: string
    nonce?: string
    signature?: string
  }): Promise<CommonValidation> {
    try {
      if (signature && address && nonce) {
        const oceanNode = OceanNode.getInstance()
        const nonceCheckResult: NonceResponse = await checkNonce(
          oceanNode.getDatabase().nonce,
          address,
          parseInt(nonce),
          signature,
          this.getMessage(address, nonce)
        )

        if (!nonceCheckResult.valid) {
          return { valid: false, error: nonceCheckResult.error }
        }

        if (nonceCheckResult.valid) {
          return { valid: true, error: '' }
        }
      }

      if (token) {
        const authToken = await this.validateToken(token)
        if (authToken) {
          return { valid: true, error: '' }
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
