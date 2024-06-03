import * as http from 'k6/http'
import { group, check, sleep } from 'k6'

// -----------------------------------------------------------------
// LIST OF TESTS TO EXECUTE
// -----------------------------------------------------------------

// - Call node root enpoint (get a list of all endpoints)
// - Call all HTTP endpoints (with & without proper params)
// - Execute requests with & without RATE limits on the node instance
// - Call directCommand enpoint with all supported commands
//

// -----------------------------------------------------------------

// set default node port if not specified
export const HTTP_PORT = __ENV.HTTP_API_PORT || 8000
// we can export the target host/port as an ENV variable export TARGET_URL='http://example.com:8000'
// OR we can also pass env variables directly to the script: $ k6 run -e TARGET_URL=http://example.com:8000 script.js
export const TARGET_URL = __ENV.TARGET_URL
  ? __ENV.TARGET_URL
  : `http://127.0.0.1:${HTTP_PORT}`

const allEndPoints = new Set()

const PROTOCOL_COMMANDS = {
  DOWNLOAD: 'download',
  DOWNLOAD_URL: 'downloadURL', // we still use this
  ECHO: 'echo',
  ENCRYPT: 'encrypt',
  ENCRYPT_FILE: 'encryptFile',
  DECRYPT_DDO: 'decryptDDO',
  GET_DDO: 'getDDO',
  QUERY: 'query',
  NONCE: 'nonce',
  STATUS: 'status',
  DETAILED_STATUS: 'detailedStatus',
  FIND_DDO: 'findDDO',
  GET_FEES: 'getFees',
  FILE_INFO: 'fileInfo',
  VALIDATE_DDO: 'validateDDO',
  COMPUTE_GET_ENVIRONMENTS: 'getComputeEnvironments',
  COMPUTE_START: 'startCompute',
  COMPUTE_STOP: 'stopCompute',
  COMPUTE_GET_STATUS: 'getComputeStatus',
  COMPUTE_GET_RESULT: 'getComputeResult',
  COMPUTE_INITIALIZE: 'initializeCompute',
  STOP_NODE: 'stopNode',
  REINDEX_TX: 'reindexTx',
  REINDEX_CHAIN: 'reindexChain',
  HANDLE_INDEXING_THREAD: 'handleIndexingThread'
}
export function buildPayloadForRequest(api) {
  // TODO: proper request for each API endpoint
}

export async function targetEndpoint(api, method, path) {
  return new Promise((resolve) => {
    // strip away path params
    if (path.indexOf(':') >= -1) {
      path = path.substr(0, path.indexOf(':'))
    }
    // this is needed for the k6 "group" call (only recognizes with / at end)
    if (!path.endsWith('/')) {
      path = path + '/'
    }
    const url = `${TARGET_URL}${path}`
    group(`Calling API ${api}`, () => {
      http.asyncRequest(method.toUpperCase(), url).then((response) => {
        check(response, {
          'status code should be 200/400/403/404/500': (res) =>
            [200, 400, 403, 404, 500].includes(res.status)
        })

        if (response.status === 200) {
          console.log(`Response body from API endpoint ${TARGET_URL}${path}):`)
          console.log(response.body)
        }
        resolve()
      })
    })
  })
}

// 1st step - get root enpoint and call all paths
export async function stepRootEndpoint() {
  const response = http.get(TARGET_URL)
  try {
    if (response.status === 200) {
      const data = JSON.parse(response.body)
      const endpoints = Object.keys(data.serviceEndpoints)
      //query all endpoints, exclude params
      for (const endpointName of endpoints) {
        allEndPoints.add(endpointName)
        const apiData = data.serviceEndpoints[endpointName]
        console.log('Targeting endpoint: ', endpointName, 'Method/path:', apiData)
        await targetEndpoint(endpointName, apiData[0], apiData[1])
        sleep(1)
      }
    } else {
      console.log('Check if your node is running before calling this script')
    }
  } catch (error) {
    console.error('Endpoint error:', error)
  }
}

// targets a specific 'directCommand'
export async function targetDirectCommand(command) {
  return new Promise((resolve) => {
    const url = `${TARGET_URL}/directCommand`
    const payload = {
      command: command
    }
    // supply a random did for these
    if ([PROTOCOL_COMMANDS.FIND_DDO, PROTOCOL_COMMANDS.GET_DDO].includes(command)) {
      payload.id = 'did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123'
      // some data for this one as well
    } else if (command === PROTOCOL_COMMANDS.ENCRYPT) {
      payload.rawData = new Uint8Array([
        104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100
      ])
    }
    group(
      `Calling 
    "/directCommand": "${command}"`,
      () => {
        http
          .asyncRequest('POST', url, JSON.stringify(payload), {
            headers: { 'Content-Type': 'application/json' }
          })
          .then((response) => {
            check(response, {
              'status code should be 200/400/403/404/500': (res) =>
                [200, 400, 403, 404, 500].includes(res.status)
            })

            if (response.status === 200) {
              console.log(
                `Response body from API /directCommand => command: "${command}"`
              )
              console.log(response.body)
            }
            resolve()
          })
      }
    )
  })
}

export async function stepDirectCommands() {
  // TODO
  const allCommands = Object.keys(PROTOCOL_COMMANDS)
  for (const commandKey of allCommands) {
    const command = PROTOCOL_COMMANDS[commandKey]
    console.log('Targeting directCommand: ' + command)
    await targetDirectCommand(command)
    sleep(1)
  }
}
