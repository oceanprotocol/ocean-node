import express, { Request, Response } from 'express'
import { Readable } from 'stream'
import { StatusHandler } from '../core/handler/statusHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { StatusCommand } from '../../@types/commands.js'

export const rootEndpointRoutes = express.Router()

// The root endpoint is the HTTP mirror of the `status` command (the same object returned over
// P2P / `/directCommand`). It defaults to the BASIC status to keep this frequently-hit path
// cheap for health checks; `?detailed=true` opts into the extended status (c2dClusters +
// supportedSchemas), mirroring the P2P `status` vs `detailedStatus` split. `?clientChallenge=...`
// (OJ-03) is forwarded so a client can prove the node controls the key its peerId commits to.
rootEndpointRoutes.get('/', async (req: Request, res: Response): Promise<void> => {
  const detailed = String(req.query.detailed).toLowerCase() === 'true'
  const clientChallenge = req.query.clientChallenge
    ? String(req.query.clientChallenge)
    : undefined
  const command: StatusCommand = {
    command: PROTOCOL_COMMANDS.STATUS,
    node: req.oceanNode.getKeyManager().getPeerId().toString(),
    detailed,
    clientChallenge,
    caller: req.caller
  }
  const result = await new StatusHandler(req.oceanNode).handle(command)
  if (result.stream) {
    // The handler already emits a formatted JSON string stream; pipe it straight through
    // instead of buffering and re-serializing via res.json().
    res.type('application/json')
    ;(result.stream as Readable).pipe(res)
  } else {
    res.status(result.status.httpStatus).send(result.status.error)
  }
})
