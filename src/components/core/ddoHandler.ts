import {
  FindDDOCommand,
  GetDdoCommand,
  PROTOCOL_COMMANDS
} from '../../utils/constants.js'
import { FindDDOResponse, P2PCommandResponse } from '../../@types'
import { Readable } from 'stream'
import OceanNodeInstance from '../../index.js'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { CACHE_TTL, OceanP2P } from '../P2P/index.js'
import { sleep } from '../../utils/util.js'

const MAX_NUM_PROVIDERS = 5
// after 60 seconds it returns whatever info we have available
const MAX_RESPONSE_WAIT_TIME_SECONDS = 60
// wait time for reading the next getDDO command
const MAX_WAIT_TIME_SECONDS_GET_DDO = 8

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
 * Straight ask the DHT table
 * @param task the command find ddo
 * @returns raw list of providers for the ddo id
 */
export async function findProvidersForDDO(
  task: FindDDOCommand
): Promise<P2PCommandResponse> {
  try {
    const { node } = await OceanNodeInstance
    const providers = await node.getProvidersForDid(task.id)
    return {
      stream: Readable.from(JSON.stringify(providers)),
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
  }
  return false
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
    const { node } = await OceanNodeInstance
    // result list
    const resultList: FindDDOResponse[] = []
    // if we have the result cached recently we return that result
    if (hasCachedDDO(node, task)) {
      // 'found cached DDO'
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
    const chunks: string[] = []
    // sink fn
    const sink = async function (source: any) {
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
        // console.log(`PARSED ddo with id ${ddo.id}:`, ddo)
        if (providerIds.length > 0) {
          const peer = providerIds.pop()
          const ddoInfo: FindDDOResponse = {
            id: ddo.id,
            lastUpdateTx: ddo.event.tx,
            lastUpdateTime: ddo.metadata.updated,
            provider: peer
          }
          resultList.push(ddoInfo)
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

    // 1st result is allways the most recent
    const sortedResults = function (): FindDDOResponse[] {
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

    // if something goes really bad then exit after 60 secs
    const fnTimeout = setTimeout(() => {
      console.log('FindDDO Timeout reached: ')
      return {
        stream: Readable.from(JSON.stringify(sortedResults(), null, 4)),
        status: { httpStatus: 200 }
      }
    }, 1000 * MAX_RESPONSE_WAIT_TIME_SECONDS)

    // Checking locally...
    const ddo = await node.getDatabase().ddo.retrieve(task.id)
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
            // 'sleep 8 seconds...'
            await sleep(MAX_WAIT_TIME_SECONDS_GET_DDO * 1000) // await 8 seconds before proceeding to next one
          }
          doneLoop += 1
        } while (processed < toProcess)

        if (updatedCache) {
          node.getDDOCache().updated = new Date().getTime()
        }

        // house cleaning
        clearTimeout(fnTimeout)
        return {
          stream: Readable.from(JSON.stringify(sortedResults(), null, 4)),
          status: { httpStatus: 200 }
        }
      } else {
        // could empty list
        clearTimeout(fnTimeout)
        return {
          stream: Readable.from(JSON.stringify(sortedResults(), null, 4)),
          status: { httpStatus: 200 }
        }
      }
    } else {
      // could be empty list
      clearTimeout(fnTimeout)
      return {
        stream: Readable.from(JSON.stringify(sortedResults(), null, 4)),
        status: { httpStatus: 200 }
      }
    }
  } catch (error) {
    // 'FindDDO big error: '
    return {
      stream: null,
      status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
    }
  }
}
