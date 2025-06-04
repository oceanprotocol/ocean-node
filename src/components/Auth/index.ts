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

  async validateSignature(signature: string, address: string): Promise<boolean> {
    const messageHashBytes = getMessageHash(this.signatureMessage)
    const isValid = await verifyMessage(messageHashBytes, address, signature)
    return isValid
  }

  async createToken(
    address: string,
    validUntil: number | null = null
  ): Promise<string | null> {
    const createdAt = Date.now()

    const jwtToken = jwt.sign(
      {
        address,
        createdAt
      },
      this.jwtSecret
    )

    const token = await this.authTokenDatabase.createToken(
      jwtToken,
      address,
      validUntil,
      createdAt
    )
    return token
  }

  async validateToken(token: string): Promise<AuthToken | null> {
    const tokenEntry = await this.authTokenDatabase.validateToken(token)
    if (!tokenEntry) {
      return null
    }
    return tokenEntry
  }

  async invalidateToken(token: string): Promise<void> {
    await this.authTokenDatabase.invalidateToken(token)
  }

  async validateAuthenticationOrToken(
    address: string,
    signature?: string,
    token?: string,
    message?: string
  ): Promise<CommonValidation> {
    try {
      if (token) {
        const authToken = await this.validateToken(token)
        if (authToken && authToken.address.toLowerCase() === address.toLowerCase()) {
          return { valid: true, error: '' }
        }
      }

      if (signature && message) {
        const messageHashBytes = getMessageHash(message)
        const isValid = await verifyMessage(messageHashBytes, address, signature)

        if (isValid) {
          return { valid: true, error: '' }
        }
      }

      return { valid: false, error: 'Invalid authentication' }
    } catch (e) {
      return { valid: false, error: `Error during authentication validation: ${e}` }
    }
  }
}
