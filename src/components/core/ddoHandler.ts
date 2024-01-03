import { Handler } from './handler.js'
import {
  GetDdoCommand,
  FindDDOCommand,
  PROTOCOL_COMMANDS
} from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types'
import { Readable } from 'stream'
import {
  hasCachedDDO,
  sortFindDDOResults,
  findDDOLocally,
  formatService
} from './utils/findDdoHandler.js'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { sleep, readStream } from '../../utils/util.js'
import { DDO } from '../../@types/DDO/DDO.js'
import { FindDDOResponse } from '../../@types/index.js'
import { P2P_CONSOLE_LOGGER } from '../P2P/index.js'

const MAX_NUM_PROVIDERS = 5
// after 60 seconds it returns whatever info we have available
const MAX_RESPONSE_WAIT_TIME_SECONDS = 60
// wait time for reading the next getDDO command
const MAX_WAIT_TIME_SECONDS_GET_DDO = 5

export class GetDdoHandler extends Handler {
  async handle(task: GetDdoCommand): Promise<P2PCommandResponse> {
    try {
      const ddo = await this.getP2PNode().getDatabase().ddo.retrieve(task.id)
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
}

export class FindDdoHandler extends Handler {
  // isFindDdoCommand(obj: any): obj is FindDDOCommand {
  //   return typeof obj === 'object' && obj !== null && 'command' in obj && 'id' in obj
  // }

  async handle(task: FindDDOCommand): Promise<P2PCommandResponse> {
    try {
      // if (!this.isFindDdoCommand(task)) {
      //   throw new Error(`Task has not FindDDOCommand type. It has ${typeof task}`)
      // }
      const node = this.getP2PNode()
      let updatedCache = false
      // result list
      const resultList: FindDDOResponse[] = []
      // if we have the result cached recently we return that result
      if (hasCachedDDO(task, node)) {
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
              if (
                new Date(ddoInfo.lastUpdateTime) > new Date(localValue.lastUpdateTime)
              ) {
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
          P2P_CONSOLE_LOGGER.logMessageWithEmoji(
            'FindDDO: Error on sink function: ' + err.message,
            true,
            GENERIC_EMOJIS.EMOJI_CROSS_MARK,
            LOG_LEVELS_STR.LEVEL_ERROR
          )
          processed++
        }
      }
      // end sink

      // if something goes really bad then exit after 60 secs
      const fnTimeout = setTimeout(() => {
        P2P_CONSOLE_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_DEBUG,
          'FindDDO: Timeout reached: ',
          true
        )
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
        const filteredProviders = providers.filter((provider: any) => {
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
                const response: P2PCommandResponse = await node.sendTo(
                  peer,
                  JSON.stringify(getCommand),
                  sink
                )
                if (response.status.httpStatus !== 200) {
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
            stream: Readable.from(
              JSON.stringify(sortFindDDOResults(resultList), null, 4)
            ),
            status: { httpStatus: 200 }
          }
        } else {
          // could empty list
          clearTimeout(fnTimeout)
          return {
            stream: Readable.from(
              JSON.stringify(sortFindDDOResults(resultList), null, 4)
            ),
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
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }

  // Function to use findDDO and get DDO in desired format
  async findAndFormatDdo(ddoId: string): Promise<DDO | null> {
    const node = this.getP2PNode()
    // First try to find the DDO Locally
    try {
      const ddo = await node.getDatabase().ddo.retrieve(ddoId)
      return ddo as DDO
    } catch (error) {
      P2P_CONSOLE_LOGGER.logMessage(
        `Unable to find DDO locally. Proceeding to call findDDO`,
        true
      )
    }
    try {
      const task: FindDDOCommand = {
        id: ddoId,
        command: PROTOCOL_COMMANDS.FIND_DDO
      }
      const response: P2PCommandResponse = await this.handle(task)

      if (response && response?.status?.httpStatus === 200 && response?.stream) {
        const streamData = await readStream(response.stream)
        const ddoList = JSON.parse(streamData)

        // Assuming the first DDO in the list is the one we want
        const ddoData = ddoList[0]
        if (!ddoData) {
          return null
        }

        // Format each service according to the Service interface
        const formattedServices = ddoData.services.map(formatService)

        // Map the DDO data to the DDO interface
        const ddo: DDO = {
          '@context': ddoData['@context'],
          id: ddoData.id,
          version: ddoData.version,
          nftAddress: ddoData.nftAddress,
          chainId: ddoData.chainId,
          metadata: ddoData.metadata,
          services: formattedServices,
          credentials: ddoData.credentials,
          event: ddoData.event
        }

        return ddo
      }

      return null
    } catch (error) {
      P2P_CONSOLE_LOGGER.logMessage(`Error getting DDO: ${error}`, true)
      return null
    }
  }
}
