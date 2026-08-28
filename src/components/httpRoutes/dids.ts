import express, { Request, Response } from 'express'
import { c2dBucketFor, c2dCapabilityContent } from '../P2P/c2dCapability.js'

// Deliberately not imported from './index.js': that module imports the two routes exported
// below, so importing back from it here would make this file circularly depend on itself.
// That circularity was latent (harmless as long as something else always finished loading
// './index.js' first) but turns into a `ReferenceError: Cannot access ... before
// initialization` the moment anything - such as a unit test - imports this file directly.
// Inlining the one-line helper removes the cycle instead of relying on import order.
function sendMissingP2PResponse(res: Response) {
  res.status(400).send('Invalid or Non Existing P2P configuration')
}

/**
 * Translates one input string of `POST /getProvidersForStrings` from an exact C2D capability
 * value to its bucket, so a caller hand-building a documented example like
 * `{"c2d":{"free":false,"cpu":1}}` (see `docs/API.md`) keeps working against a fleet that now
 * only announces buckets, and so does a caller hand-building a value that was never itself a
 * bucket (e.g. `cpu: 3`, which now resolves to the bucket that covers it, `cpu: 2`).
 *
 * Anything that is not a well-formed `{"c2d":{"free":<boolean>,"<resource>":<integer>}}`
 * string — including every plain DID, which is the overwhelmingly common input to this route
 * — is returned completely untouched: this function only ever recognizes and rewrites the one
 * shape it knows about, never rejects or alters anything else.
 */
export function translateC2DStringToBucket(input: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return input
  }
  if (typeof parsed !== 'object' || parsed === null || !('c2d' in parsed)) {
    return input
  }
  const { c2d } = parsed as { c2d: unknown }
  if (typeof c2d !== 'object' || c2d === null || Array.isArray(c2d)) {
    return input
  }
  const entries = c2d as Record<string, unknown>
  const keys = Object.keys(entries)
  // The frozen shape is exactly two fields: `free` and one resource key.
  if (keys.length !== 2 || typeof entries.free !== 'boolean') {
    return input
  }
  const resource = keys.find((key) => key !== 'free')
  if (!resource) {
    return input
  }
  const value = entries[resource]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return input
  }
  try {
    const bucket = c2dBucketFor(resource, value)
    return c2dCapabilityContent({ free: entries.free, resource, value: bucket })
  } catch {
    // Malformed in some way `c2dBucketFor`/`c2dCapabilityContent` reject (e.g. empty resource
    // key) - fall back to passing the original string through rather than throwing out of the
    // route handler.
    return input
  }
}

export const getProvidersForStringRoute = express.Router()
getProvidersForStringRoute.get(
  '/getProvidersForString',
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query.input) {
      res.sendStatus(400)
      return
    }
    if (req.oceanNode.hasP2PInterface()) {
      const providers = await req.oceanNode
        .getP2PNode()
        .getProvidersForString(req.query.input as string)
      res.json(providers)
    } else {
      sendMissingP2PResponse(res)
    }
  }
)

export const getProvidersForStringsRoute = express.Router()
getProvidersForStringsRoute.post(
  '/getProvidersForStrings',
  express.json(),
  async (req, res) => {
    try {
      if (!req.body) {
        res.status(400).send('Missing array of strings in request body.')
        return
      }
      // const body = JSON.parse(req.body)
      if (
        Array.isArray(req.body) &&
        req.body.every((item: unknown) => typeof item === 'string')
      ) {
        const timeout =
          typeof req.query?.timeout === 'string'
            ? parseInt(req.query.timeout, 10)
            : undefined
        // The fleet only announces bucketed C2D capability strings now (see
        // p2pAnnounceC2D.ts), so an exact value handed to this documented route is
        // translated to its bucket before lookup. Every non-C2D string (in practice, every
        // plain DID) passes through untouched.
        const bucketed = (req.body as string[]).map(translateC2DStringToBucket)
        const providers = await req.oceanNode
          .getP2PNode()
          .getProvidersForStrings(bucketed, timeout)

        res.json(providers)
      } else {
        res.status(400).send('Expected an array of strings.')
      }
    } catch (error) {
      console.error('Error processing request:', error)
      res.status(400).send(error)
    }
  }
)
