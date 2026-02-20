import express from 'express'
import { streamToString } from '../../utils/util.js'
import { Readable } from 'stream'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { FindDdoHandler, ValidateDDOHandler } from '../core/handler/ddoHandler.js'
import { QueryDdoStateHandler, QueryHandler } from '../core/handler/queryHandler.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { QueryCommand } from '../../@types/commands.js'
import { DatabaseFactory } from '../database/DatabaseFactory.js'
import { SearchQuery } from '../../@types/DDO/SearchQuery.js'
import { getConfiguration } from '../../utils/index.js'

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
      const searchQuery: SearchQuery = req.body
      if (!searchQuery) {
        res.status(400).send('Missing required body')
        return
      }

      const config = await getConfiguration()
      const queryStrategy = await DatabaseFactory.createMetadataQuery(config.dbConfig)
      const transformedQuery = queryStrategy.buildQuery(searchQuery)

      const result = await new QueryHandler(req.oceanNode).handle({
        query: transformedQuery,
        command: PROTOCOL_COMMANDS.QUERY,
        caller: req.caller
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
    const config = await getConfiguration()
    const queryStrategy = await DatabaseFactory.createDdoStateQuery(config.dbConfig)

    const did = req.query.did ? String(req.query.did) : undefined
    const nft = req.query.nft ? String(req.query.nft) : undefined
    const txId = req.query.txId ? String(req.query.txId) : undefined

    const queryDdoState: QueryCommand = {
      query: queryStrategy.buildQuery(did, nft, txId),
      command: PROTOCOL_COMMANDS.QUERY,
      caller: req.caller
    }

    if (!Object.keys(queryDdoState.query).length) {
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

      if (
        queryResult &&
        typeof queryResult === 'object' &&
        queryResult.found !== undefined
      ) {
        if (queryResult.found > 0 && queryResult.hits && queryResult.hits.length > 0) {
          res.json(queryResult.hits[0].document || queryResult.hits[0])
        } else {
          res.status(404).send('Not found')
        }
      } else if (Array.isArray(queryResult)) {
        if (queryResult.length > 0) {
          res.json(queryResult[0])
        } else {
          res.status(404).send('Not found')
        }
      } else {
        HTTP_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_DEBUG,
          `Query result structure (not found): ${JSON.stringify(queryResult)}`
        )
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
  const node = req.oceanNode
  try {
    if (!req.body) {
      res.status(400).send('Missing DDO object')
      return
    }

    const result = await new ValidateDDOHandler(node).handle({
      ddo: req.body.ddo || null,
      publisherAddress: (req.body.publisherAddress as string) || null,
      signature: (req.body.signature as string) || null,
      nonce: (req.body.nonce as string) || null,
      authorization: req.headers?.authorization,
      command: PROTOCOL_COMMANDS.VALIDATE_DDO,
      caller: req.caller
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
