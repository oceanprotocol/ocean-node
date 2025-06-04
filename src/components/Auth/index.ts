import { getMessageHash, verifyMessage } from '../../utils/index.js'
import { AuthToken, AuthTokenDatabase } from '../database/AuthTokenDatabase.js'
import jwt from 'jsonwebtoken'

export interface CommonValidation {
  valid: boolean
  error: string
}

export class Auth {
  private authTokenDatabase: AuthTokenDatabase
  private jwtSecret: string
  private signatureMessage: string

  public constructor(authTokenDatabase: AuthTokenDatabase) {
    this.authTokenDatabase = authTokenDatabase
    this.jwtSecret = process.env.JWT_SECRET || 'ocean-node-secret'
    this.signatureMessage = process.env.SIGNATURE_MESSAGE || 'token-auth'
  }

  public getJwtSecret(): string {
    return this.jwtSecret
  }

  public getSignatureMessage(): string {
    return this.signatureMessage
  }

  getJWTToken(address: string, createdAt: number): string {
    const jwtToken = jwt.sign(
      {
        address,
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

  async validateSignature(signature: string, address: string): Promise<boolean> {
    const messageHashBytes = getMessageHash(this.signatureMessage)
    const isValid = await verifyMessage(messageHashBytes, address, signature)
    return isValid
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
    signature,
    message
  }: {
    token?: string
    address?: string
    signature?: string
    message?: string
  }): Promise<CommonValidation> {
    try {
      if (token) {
        const authToken = await this.validateToken(token)
        if (authToken) {
          return { valid: true, error: '' }
        }

        return { valid: false, error: 'Invalid token' }
      }

      if (signature && message && address) {
        const messageHashBytes = getMessageHash(message)
        const isValid = await verifyMessage(messageHashBytes, address, signature)

        if (isValid) {
          return { valid: true, error: '' }
        }
      }

      return {
        valid: false,
        error:
          'Invalid authentication, you need to provide either a token or an address, signature and message'
      }
    } catch (e) {
      return { valid: false, error: `Error during authentication validation: ${e}` }
    }
  }
}
