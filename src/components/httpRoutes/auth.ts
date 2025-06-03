import express from 'express'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { OceanNode } from '../../OceanNode.js'
import { Auth } from '../Auth/index.js'

export const authRoutes = express.Router()
const oceanNode = OceanNode.getInstance()
const auth = new Auth(oceanNode.getDatabase())

authRoutes.post('/api/v1/auth/token', async (req, res) => {
    try {
        const { signature, address, validUntil } = req.body

        if (!signature || !address) {
            return res.status(400).json({ error: 'Missing required parameters' })
        }

        const token = await auth.createToken(signature, address, validUntil)

        res.json({ token })
    } catch (error) {
        HTTP_LOGGER.error(`Error creating auth token: ${error}`)
        res.status(500).json({ error: 'Internal server error' })
    }
})

authRoutes.delete('/api/v1/auth/token', async (req, res) => {
    try {
        const { signature, address, token } = req.body

        if (!signature || !address || !token) {
            return res.status(400).json({ error: 'Missing required parameters' })
        }

        const tokenEntry = await auth.validateToken(token)
        if (!tokenEntry) {
            return res.status(401).json({ error: 'Invalid token' })
        }

        await auth.deleteToken(token)

        res.json({ success: true })
    } catch (error) {
        HTTP_LOGGER.error(`Error deleting auth token: ${error}`)
        res.status(500).json({ success: false, error: 'Internal server error' })
    }
})

