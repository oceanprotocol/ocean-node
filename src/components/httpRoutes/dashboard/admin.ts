import express from 'express'
import { HTTP_LOGGER } from '../../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { getConfiguration } from '../../../utils/index.js'

export const adminRoutes = express.Router()
const regex: RegExp = /^(0x)?[0-9a-fA-F]{40}$/

adminRoutes.get(`/adminList`, async (req, res) => {
  try {
    const config = await getConfiguration()
    if (!config.allowedAdmins) {
      HTTP_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_INFO,
        `Allowed admins list is empty because env var is not set.`
      )
      res.status(200).send({
        response: []
      })
    }

    for (const address of config.allowedAdmins) {
      // should we return the good ones instead?
      if (regex.test(address) === false) {
        HTTP_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `Invalid format for ETH address from ALLOWED ADMINS.`
        )
        res.status(400).send({
          response: []
        })
      }
    }
    res.status(200).send({
      response: config.allowedAdmins
    })
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send(`Internal Server Error: ${error}`)
  }
})
