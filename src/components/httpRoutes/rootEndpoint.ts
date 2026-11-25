import express, { Request, Response } from 'express'
import { Readable } from 'stream'
import { StatusHandler } from '../core/handler/statusHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { StatusCommand } from '../../@types/commands.js'

export const rootEndpointRoutes = express.Router()

// The root endpoint is the HTTP mirror of the `status` command (the same object returned over
// P2P / `/directCommand`). It defaults to the BASIC status to keep this frequently-hit path
// cheap for health checks; `?detailed=true` opts into the extended status (indexer + c2dClusters
// + supportedSchemas — indexer is detailed-only because it reads the metadata DB per chain),
// mirroring the P2P `status` vs `detailedStatus` split. `?clientChallenge=...`
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
  // Preserve the handler's HTTP status for BOTH streamed and non-streamed responses: a
  // rate-limit / error response (e.g. buildRateLimitReachedResponse) carries a stream AND a
  // non-200 httpStatus, so the status must be set before piping, not only on the error branch.
  res.status(result.status.httpStatus)
  if (result.stream) {
    // The success path emits a formatted JSON string stream; pipe it straight through instead
    // of buffering and re-serializing via res.json(). Non-200 stream bodies (e.g. the rate-limit
    // text) are left as the default content type.
    if (result.status.httpStatus === 200) {
      res.type('application/json')
    }
    ;(result.stream as Readable).pipe(res)
  } else {
    res.send(result.status.error)
  }
})
