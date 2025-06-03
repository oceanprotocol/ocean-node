import { getMessageHash, verifyMessage } from "../../utils/index.js";
import { AuthToken } from "../database/AuthTokenDatabase.js";
import jwt from 'jsonwebtoken';
import { Database } from "../database/index.js";

export interface CommonValidation {
    valid: boolean;
    error: string;
}

export class Auth {
    private db: Database
    private jwtSecret: string
    private signatureMessage: string

    public constructor(db: Database) {
        this.db = db
        this.jwtSecret = process.env.JWT_SECRET || 'ocean-node-secret'
        this.signatureMessage = process.env.SIGNATURE_MESSAGE || 'token-auth'
    }

    public getJwtSecret(): string {
        return this.jwtSecret
    }

    public getSignatureMessage(): string {
        return this.signatureMessage
    }

    async createToken(signature: string, address: string, validUntil: number | null = null): Promise<string> {
        const createdAt = Date.now()
        const messageHashBytes = await getMessageHash(this.signatureMessage)
        const isValid = await verifyMessage(messageHashBytes, address, signature)
        if (!isValid) {
            throw new Error('Invalid signature')
        }

        const jwtToken = jwt.sign(
            {
                address,
                createdAt
            },
            this.jwtSecret
        )

        const token = await this.db.authToken.createToken(jwtToken, address, validUntil, createdAt)
        return token
    }

    async validateToken(token: string): Promise<AuthToken | null> {
        const tokenEntry = await this.db.authToken.validateToken(token)
        if (!tokenEntry) {
            return null
        }
        return tokenEntry
    }

    async deleteToken(token: string): Promise<void> {
        await this.db.authToken.deleteToken(token)
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
                const messageHashBytes = await getMessageHash(message)
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