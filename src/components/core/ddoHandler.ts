import {
  FindDDOCommand,
  GetDdoCommand,
  PROTOCOL_COMMANDS
} from '../../utils/constants.js'
import { FindDDOResponse, P2PCommandResponse } from '../../@types'
import { Readable } from 'stream'
import { OceanNodeInstance } from '../../index.js'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { CACHE_TTL, OceanP2P, P2P_CONSOLE_LOGGER } from '../P2P/index.js'
import { sleep } from '../../utils/util.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'

const MAX_NUM_PROVIDERS = 5
// after 60 seconds it returns whatever info we have available
const MAX_RESPONSE_WAIT_TIME_SECONDS = 60
// wait time for reading the next getDDO command
const MAX_WAIT_TIME_SECONDS_GET_DDO = 5

export async function handleGetDdoCommand(
  task: GetDdoCommand
): Promise<P2PCommandResponse> {
  try {
    const ddo = await this.db.ddo.retrieve(task.id)
    if (!ddo) {
      return {
        stream: null,
        status: { httpStatus: 404, error: 'Not found' }
      }
    }
    return {
      stream: Readable.from(JSON.stringify(ddo)),
      status: { httpStatus: 200 }
    }
  } catch (error) {
    return {
      stream: null,
      status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
    }
  }
}

/**
 * Check if the specified ddo is cached and if the cached version is recent enough
 * @param task FindDDO
 * @returns boolean
 */
export function hasCachedDDO(node: OceanP2P, task: FindDDOCommand): boolean {
  if (node.getDDOCache().dht.has(task.id)) {
    // check cache age
    const now: number = new Date().getTime()
    const cacheTime: number = node.getDDOCache().updated
    if (now - cacheTime <= CACHE_TTL) {
      // console.log('cache age (ms):', now - cacheTime)
      return true
    }
    P2P_CONSOLE_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_INFO,
      `DDO cache for ${task.id} has expired, cache age(secs): ${
        (now - cacheTime) / 1000
      }`,
      true
    )
  }
  return false
}

// 1st result is allways the most recent
function sortFindDDOResults(resultList: FindDDOResponse[]): FindDDOResponse[] {
  if (resultList.length > 0) {
    return resultList.sort((a: FindDDOResponse, b: FindDDOResponse) => {
      const dateA = new Date(a.lastUpdateTime)
      const dateB = new Date(b.lastUpdateTime)
      if (dateB > dateA) {
        return 1
      } else if (dateB < dateA) {
        return -1
      }
      return 0
    })
  }
  return resultList
}
/**
 * Get the DDO list from list of available providers (including self)
 * @param task the findDDO command task
 * @returns filtered list
 */
export async function findDDO(task: FindDDOCommand): Promise<P2PCommandResponse> {
  try {
    let updatedCache = false
    // this node
    const node = await OceanNodeInstance.getP2PNode()
    // result list
    const resultList: FindDDOResponse[] = []
    // if we have the result cached recently we return that result
    if (hasCachedDDO(node, task)) {
      // 'found cached DDO'
      P2P_CONSOLE_LOGGER.logMessage(
        'Found local cached version for DDO id: ' + task.id,
        true
      )
      resultList.push(node.getDDOCache().dht.get(task.id))
      return {
        stream: Readable.from(JSON.stringify(resultList, null, 4)),
        status: { httpStatus: 200 }
      }
    }
    // otherwise we need to contact other providers and get DDO from them
    // ids of available providers
    const providerIds: string[] = []
    let processed = 0
    let toProcess = 0
    // sink fn
    const sink = async function (source: any) {
      const chunks: string[] = []
      let first = true
      try {
        for await (const chunk of source) {
          if (first) {
            first = false
            const str = uint8ArrayToString(chunk.subarray()) // Obs: we need to specify the length of the subarrays
            const decoded = JSON.parse(str)
            if (decoded.httpStatus !== 200) {
              processed++
              break
            }
          } else {
            const str = uint8ArrayToString(chunk.subarray())
            chunks.push(str)
          }
        } // end for chunk
        const ddo = JSON.parse(chunks.toString())
        chunks.length = 0
        // process it
        if (providerIds.length > 0) {
          const peer = providerIds.pop()
          const ddoInfo: FindDDOResponse = {
            id: ddo.id,
            lastUpdateTx: ddo.event.tx,
            lastUpdateTime: ddo.metadata.updated,
            provider: peer
          }
          resultList.push(ddoInfo)
          P2P_CONSOLE_LOGGER.logMessage(
            `Succesfully processed DDO info, id: ${ddo.id} from remote peer: ${peer}`,
            true
          )
          // is it cached?
          if (node.getDDOCache().dht.has(ddo.id)) {
            const localValue: FindDDOResponse = node.getDDOCache().dht.get(ddo.id)
            if (new Date(ddoInfo.lastUpdateTime) > new Date(localValue.lastUpdateTime)) {
              // update cached version
              node.getDDOCache().dht.set(ddo.id, ddoInfo)
            }
          } else {
            // just add it to the list
            node.getDDOCache().dht.set(ddo.id, ddoInfo)
          }
          updatedCache = true
        }
        processed++
      } catch (err) {
        console.log('Error on sink function: ' + err.message)
        processed++
      }
    }
    // end sink

    // if something goes really bad then exit after 60 secs
    const fnTimeout = setTimeout(() => {
      console.log('FindDDO Timeout reached: ')
      return {
        stream: Readable.from(JSON.stringify(sortFindDDOResults(resultList), null, 4)),
        status: { httpStatus: 200 }
      }
    }, 1000 * MAX_RESPONSE_WAIT_TIME_SECONDS)

    // Checking locally...
    const ddoInfo = await findDDOLocally(node, task.id)
    if (ddoInfo) {
      // node has ddo
      // add to the result list anyway
      resultList.push(ddoInfo)
      updatedCache = true
    }

    // check other providers for this ddo
    const providers = await node.getProvidersForDid(task.id)
    // check if includes self and exclude from check list
    if (providers.length > 0) {
      // exclude this node from the providers list if present
      const filteredProviders = providers.filter((provider) => {
        return provider.id.toString() !== node.getPeerId()
      })

      // work with the filtered list only
      if (filteredProviders.length > 0) {
        toProcess = filteredProviders.length
        // only process a maximum of 5 provider entries per DDO (might never be that much anyway??)
        if (toProcess > MAX_NUM_PROVIDERS) {
          filteredProviders.slice(0, MAX_NUM_PROVIDERS)
          toProcess = MAX_NUM_PROVIDERS
        }

        let doneLoop = 0
        do {
          // eslint-disable-next-line no-unmodified-loop-condition
          for (let i = 0; i < toProcess && doneLoop < toProcess; i++) {
            const provider = filteredProviders[i]
            const peer = provider.id.toString()
            const getCommand: GetDdoCommand = {
              id: task.id,
              command: PROTOCOL_COMMANDS.GET_DDO
            }
            providerIds.push(peer)

            try {
              // problem here is that even if we get the P2PCommandResponse right after await(), we still don't know
              // exactly when the chunks are written/processed/received on the sink function
              // so, better to wait/sleep some small amount of time before proceeding to the next one
              const status: P2PCommandResponse = await node.sendTo(
                peer,
                JSON.stringify(getCommand),
                sink
              )
              if (status.status.httpStatus !== 200) {
                providerIds.pop() // move to the next one
                processed++
              }
            } catch (innerException) {
              providerIds.pop() // ignore this one
              processed++
            }
            // 'sleep 5 seconds...'
            P2P_CONSOLE_LOGGER.logMessage(
              `Sleeping for: ${MAX_WAIT_TIME_SECONDS_GET_DDO} seconds, while getting DDO info remote peer...`,
              true
            )
            await sleep(MAX_WAIT_TIME_SECONDS_GET_DDO * 1000) // await 5 seconds before proceeding to next one
            // if the ddo is not cached, the very 1st request will take a bit longer
            // cause it needs to get the response from all the other providers call getDDO()
            // otherwise is immediate as we just return the cached version, once the cache expires we
            // repeat the procedure and query the network again, updating cache at the end
          }
          doneLoop += 1
        } while (processed < toProcess)

        if (updatedCache) {
          node.getDDOCache().updated = new Date().getTime()
        }

        // house cleaning
        clearTimeout(fnTimeout)
        return {
          stream: Readable.from(JSON.stringify(sortFindDDOResults(resultList), null, 4)),
          status: { httpStatus: 200 }
        }
      } else {
        // could empty list
        clearTimeout(fnTimeout)
        return {
          stream: Readable.from(JSON.stringify(sortFindDDOResults(resultList), null, 4)),
          status: { httpStatus: 200 }
        }
      }
    } else {
      // could be empty list
      clearTimeout(fnTimeout)
      return {
        stream: Readable.from(JSON.stringify(sortFindDDOResults(resultList), null, 4)),
        status: { httpStatus: 200 }
      }
    }
  } catch (error) {
    // 'FindDDO big error: '
    P2P_CONSOLE_LOGGER.logMessageWithEmoji(
      `Error: '${error.message}' was caught while getting DDO info for id: ${task.id}`,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEl_ERROR
    )
    return {
      stream: null,
      status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
    }
  }
}

/**
 * Finds a given DDO on local DB and updates cache if needed
 * @param node this node
 * @param id ddo id
 * @returns ddo info
 */
async function findDDOLocally(
  node: OceanP2P,
  id: string
): Promise<FindDDOResponse> | undefined {
  const ddo = await node.getDatabase().ddo.retrieve(id)
  if (ddo) {
    // node has ddo

    const ddoInfo: FindDDOResponse = {
      id: ddo.id,
      lastUpdateTx: ddo.event.tx,
      lastUpdateTime: ddo.metadata.updated,
      provider: node.getPeerId()
    }
    // not in the cache yet
    if (!node.getDDOCache().dht.has(ddo.id)) {
      node.getDDOCache().dht.set(ddo.id, ddoInfo)
    } else {
      // it has, just check wich one is newer
      const localCachedData: FindDDOResponse = node.getDDOCache().dht.get(ddo.id)
      // update localCachedData if newer
      if (new Date(ddoInfo.lastUpdateTime) > new Date(localCachedData.lastUpdateTime)) {
        node.getDDOCache().dht.set(ddo.id, ddoInfo)
      }
    }
    return ddoInfo
  }
  return undefined
}
