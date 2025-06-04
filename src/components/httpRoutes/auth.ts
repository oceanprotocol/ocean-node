import express from 'express'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { SERVICES_API_BASE_PATH } from '../../utils/index.js'

export const authRoutes = express.Router()

authRoutes.post(
  `${SERVICES_API_BASE_PATH}/auth/token`,
  express.json(),
  async (req, res) => {
    try {
      const { signature, address, validUntil } = req.body

      console.log({ signature, address, validUntil })

      if (!signature || !address) {
        return res.status(400).json({ error: 'Missing required parameters' })
      }

      const isValid = await req.oceanNode.getAuth().validateSignature(signature, address)
      if (!isValid) {
        return res.status(400).json({ error: 'Invalid signature' })
      }

      const token = await req.oceanNode.getAuth().createToken(address, validUntil)

      res.json({ token })
    } catch (error) {
      HTTP_LOGGER.error(`Error creating auth token: ${error}`)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

authRoutes.post(
  `${SERVICES_API_BASE_PATH}/auth/token/invalidate`,
  express.json(),
  async (req, res) => {
    try {
      const { signature, address, token } = req.body

      if (!signature || !address || !token) {
        return res.status(400).json({ error: 'Missing required parameters' })
      }

      const isValid = await req.oceanNode.getAuth().validateSignature(signature, address)
      if (!isValid) {
        return res.status(400).json({ error: 'Invalid signature' })
      }

      await req.oceanNode.getAuth().invalidateToken(token)

      res.json({ success: true })
    } catch (error) {
      HTTP_LOGGER.error(`Error deleting auth token: ${error}`)
      res.status(500).json({ success: false, error: 'Internal server error' })
    }
  }
)
