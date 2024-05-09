import express from 'express'
import { streamToString } from '../../utils/util.js'
import { Readable } from 'stream'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { FindDdoHandler, ValidateDDOHandler } from '../core/handler/ddoHandler.js'
import { QueryDdoStateHandler, QueryHandler } from '../core/handler/queryHandler.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { DDO } from '../../@types/DDO/DDO.js'
import { QueryCommand } from '../../@types/commands.js'

export const aquariusRoutes = express.Router()

export const AQUARIUS_API_BASE_PATH = '/api/aquarius'

aquariusRoutes.get(
  `${AQUARIUS_API_BASE_PATH}/assets/ddo/:did/:force?`,
  async (req, res) => {
    try {
      const { did, force } = req.params
      if (!did || !did.startsWith('did:op')) {
        res.status(400).send('Missing or invalid required parameter: "did"')
        return
      }
      const forceFlag = force === 'true'
      const ddo = await new FindDdoHandler(req.oceanNode).findAndFormatDdo(did, forceFlag)
      if (ddo) {
        res.json(ddo)
      } else {
        res.status(404).send('DDO not found')
      }
    } catch (error) {
      HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
      res.status(500).send('Internal Server Error')
    }
  }
)

aquariusRoutes.get(
  `${AQUARIUS_API_BASE_PATH}/assets/metadata/:did/:force?`,
  async (req, res) => {
    try {
      const { did, force } = req.params
      if (!did || !did.startsWith('did:op')) {
        res.status(400).send('Missing or invalid required parameter: "did"')
        return
      }
      const forceFlag = force === 'true'
      const ddo = await new FindDdoHandler(req.oceanNode).findAndFormatDdo(did, forceFlag)
      if (ddo) {
        res.json(ddo)
      } else {
        res.status(404).send('DDO not found')
      }
    } catch (error) {
      HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
      res.status(500).send('Internal Server Error')
    }
  }
)

aquariusRoutes.post(
  `${AQUARIUS_API_BASE_PATH}/assets/metadata/query`,
  async (req, res) => {
    try {
      const query = req.body
      if (!query) {
        res.status(400).send('Missing required body')
        return
      }

      const result = await new QueryHandler(req.oceanNode).handle({
        query,
        command: PROTOCOL_COMMANDS.QUERY
      })
      if (result.stream) {
        const queryResult = JSON.parse(await streamToString(result.stream as Readable))
        res.json(queryResult)
      } else {
        res.status(result.status.httpStatus).send(result.status.error)
      }
    } catch (error) {
      HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
      res.status(500).send('Internal Server Error')
    }
  }
)

aquariusRoutes.get(`${AQUARIUS_API_BASE_PATH}/state/ddo`, async (req, res) => {
  try {
    const queryDdoState: QueryCommand = { query: {}, command: PROTOCOL_COMMANDS.QUERY }
    const did = String(req.query.did)
    queryDdoState.query = {
      q: did,
      query_by: 'did'
    }

    const nft = String(req.query.nft)
    queryDdoState.query = {
      q: nft,
      query_by: 'nft'
    }

    const txId = String(req.query.txId)
    queryDdoState.query = {
      q: txId,
      query_by: 'txId'
    }

    if (!queryDdoState.query.query_by) {
      res
        .status(400)
        .send(
          'Missing or invalid required parameters, you need to specify one of: "did", "txId", "nft"'
        )
      return
    }
    const result = await new QueryDdoStateHandler(req.oceanNode).handle(queryDdoState)
    if (result.stream) {
      const queryResult = JSON.parse(await streamToString(result.stream as Readable))
      if (queryResult[0].found) {
        res.json(queryResult[0].hits[0])
      } else {
        res.status(404).send('Not found')
      }
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

aquariusRoutes.post(`${AQUARIUS_API_BASE_PATH}/assets/ddo/validate`, async (req, res) => {
  try {
    if (!req.body || req.body === undefined) {
      res.status(400).send('Missing DDO object')
      return
    }
    const ddo = JSON.parse(req.body) as DDO

    if (!ddo.version) {
      res.status(400).send('Missing DDO version')
      return
    }

    const node = req.oceanNode
    const result = await new ValidateDDOHandler(node).handle({
      ddo,
      command: PROTOCOL_COMMANDS.VALIDATE_DDO
    })
    if (result.stream) {
      const validationResult = JSON.parse(await streamToString(result.stream as Readable))
      res.json(validationResult)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})
