import express from 'express'
import { streamToString } from '../../utils/util.js'
import { Readable } from 'stream'
import { handleGetDdoCommand } from '../core/ddoHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { handleQueryCommand } from '../core/queryHandler.js'
import {
  CustomNodeLogger,
  defaultConsoleTransport,
  getCustomLoggerForModule,
  LOG_LEVELS_STR,
  LOGGER_MODULE_NAMES
} from '../../utils/logging/Logger.js'

export const aquariusRoutes = express.Router()
const logger: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.HTTP,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

aquariusRoutes.get('/assets/ddo/:did', async (req, res) => {
  try {
    const { did } = req.params
    if (!did || !did.startsWith('did:op')) {
      res.status(400).send('Missing or invalid required parameter: "did"')
      return
    }
    const node = req.oceanNode.getP2PNode()
    const result = await handleGetDdoCommand(node, {
      id: did,
      command: PROTOCOL_COMMANDS.GET_DDO
    })
    if (result.stream) {
      const ddo = JSON.parse(await streamToString(result.stream as Readable))
      res.json(ddo)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  } catch (error) {
    logger.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

aquariusRoutes.get('/assets/metadata/:did', async (req, res) => {
  try {
    const { did } = req.params
    if (!did || !did.startsWith('did:op')) {
      res.status(400).send('Missing or invalid required parameter: "did"')
      return
    }
    const node = req.oceanNode.getP2PNode()
    const result = await handleGetDdoCommand(node, {
      id: did,
      command: PROTOCOL_COMMANDS.GET_DDO
    })
    if (result.stream) {
      const ddo = JSON.parse(await streamToString(result.stream as Readable))
      res.json(ddo.metadata)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  } catch (error) {
    logger.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

aquariusRoutes.post('/assets/metadata/query', async (req, res) => {
  try {
    const query = req.body
    if (!query) {
      res.status(400).send('Missing required body')
      return
    }
    const node = req.oceanNode.getP2PNode()
    const result = await handleQueryCommand(node, {
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
    logger.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

aquariusRoutes.get('/state/ddo', async (req, res) => {
  try {
    let query
    const did = String(req.query.did)
    if (did) {
      query = {
        q: did,
        query_by: 'id'
      }
    }
    const chainId = String(req.query.chainId)
    if (chainId) {
      query = {
        q: chainId,
        query_by: 'chainId'
      }
    }
    const nft = String(req.query.nft)
    if (nft) {
      query = {
        q: nft,
        query_by: 'nft.address'
      }
    }
    if (!query) {
      res
        .status(400)
        .send('Missing or invalid required parameters: "did", "chainId", "nft"')
      return
    }
    const node = req.oceanNode.getP2PNode()
    const result = await handleQueryCommand(node, {
      query,
      command: PROTOCOL_COMMANDS.QUERY
    })
    if (result.stream) {
      const queryResult = JSON.parse(await streamToString(result.stream as Readable))
      if (queryResult[0].found) {
        res.json(queryResult[0].hits[0].document.nft.state)
      } else {
        res.status(404).send('Not found')
      }
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  } catch (error) {
    logger.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})
