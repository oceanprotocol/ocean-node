import { Request, Response, NextFunction } from 'express'
import { HTTP_LOGGER } from '../../../utils/logging/common.js'
import { OceanNode } from '../../../OceanNode.js'

const oceanNode = OceanNode.getInstance()

export interface AuthenticatedRequest extends Request {
    authenticatedAddress?: string
}

export async function validateAuthToken(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
) {
    const authHeader = req.headers.authorization

    if (!authHeader) {
        // If no auth header is present, check for signature in the request
        return next()
    }

    const [scheme, token] = authHeader.split(' ')

    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Invalid authorization header format' })
    }

    try {
        const tokenEntry = await oceanNode.getDatabase().authToken.validateToken(token)

        if (!tokenEntry) {
            return res.status(401).json({ error: 'Invalid or expired token' })
        }

        req.authenticatedAddress = tokenEntry.address
        next()
    } catch (error) {
        HTTP_LOGGER.error(`Error validating auth token: ${error}`)
        res.status(500).json({ error: 'Internal server error' })
    }
} 