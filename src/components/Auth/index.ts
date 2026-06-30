import { AuthToken, AuthTokenDatabase } from '../database/AuthTokenDatabase.js'
import jwt from 'jsonwebtoken'
import { checkNonce, NonceResponse } from '../core/utils/nonceHandler.js'
import { OceanNode } from '../../OceanNode.js'
import { CommonValidation } from '../../utils/validators.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import {
  getAddress,
  hexlify,
  solidityPackedKeccak256,
  toBeArray,
  toUtf8Bytes,
  verifyMessage
} from 'ethers'
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

  public constructor(authTokenDatabase: AuthTokenDatabase, config: OceanNodeConfig) {
    this.authTokenDatabase = authTokenDatabase
    this.jwtSecret = config.jwtSecret
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
    validUntil?: number | null
  ): Promise<string> {
    const jwtToken = jwt.sign(
      {
        address,
        nonce,
        createdAt,
        signature,
        validUntil
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
    return this.validateRemoteToken(token)
  }

  private validateRemoteToken(token: string): AuthToken | null {
    const decoded = jwt.decode(token)
    if (!decoded || typeof decoded !== 'object') {
      return null
    }
    const { address, nonce, signature, createdAt, validUntil } = decoded as {
      address?: string
      nonce?: string
      signature?: string
      createdAt?: number
      validUntil?: number | null
    }
    if (!address || !nonce || !signature) {
      return null
    }
    if (validUntil != null && Date.now() >= Number(validUntil)) {
      return null
    }
    if (!this.signatureMatchesAddress(address, nonce, signature)) {
      return null
    }
    return {
      token,
      address,
      created: new Date(Number(createdAt)),
      validUntil: validUntil != null ? new Date(Number(validUntil)) : null,
      isValid: true
    }
  }

  private signatureMatchesAddress(
    address: string,
    nonce: string,
    signature: string
  ): boolean {
    try {
      const message =
        String(address) + String(nonce) + PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN
      const consumerMessage = solidityPackedKeccak256(
        ['bytes'],
        [hexlify(toUtf8Bytes(message))]
      )
      const expected = getAddress(address).toLowerCase()
      return (
        getAddress(verifyMessage(consumerMessage, signature)).toLowerCase() ===
          expected ||
        getAddress(verifyMessage(toBeArray(consumerMessage), signature)).toLowerCase() ===
          expected
      )
    } catch {
      return false
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
  ): Promise<CommonValidation> {
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
