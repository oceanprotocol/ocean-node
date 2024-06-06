import { sleep } from 'k6'
import * as http from 'k6/http'
import exec from 'k6/execution'
import {
  stepRootEndpoint,
  stepDirectCommands,
  TARGET_URL,
  getTestOptions,
  getRequestRateOptions
} from './util.js'
// -----------------------------------------------------------------
// LIST OF TESTS TO EXECUTE
// -----------------------------------------------------------------

// - Call node root enpoint (get a list of all endpoints)
// - Call all HTTP endpoints (with & without proper params)
// - Execute requests with & without RATE limits on the node instance
// - Call directCommand enpoint with all supported commands
//
console.log('ENV', __ENV.K6_WEB_DASHBOARD)
// -----------------------------------------------------------------

// Type of test, defaults to 'smoke' (less requests/load in general)
export const TEST_TYPE = __ENV.TEST_TYPE || 'smoke'

// do it under the rate limits?
const doRateLimit = __ENV.RATE ? true : false

// 3 requests per second is the MAX default on the nodes, if not explicitly set otherwise
// so we're gonna keep a little bit bellow the threshold for safety here
// We should not have any requests blocked if we keep it below
let DEFAULT_RATE_LIMIT = 2

if (doRateLimit) {
  // if we have a RATE_LIMIT env var, use it
  // NOTE: this value needs to be the less or equal the value that we have configured on the node itself)
  // otherwise it will hit the rate limitations middleware
  // (and we want to go a bit further down the stack here, by not triggering that)
  if (__ENV.RATE_LIMIT && !isNaN(__ENV.RATE_LIMIT)) {
    DEFAULT_RATE_LIMIT = Math.max(Number(__ENV.RATE_LIMIT, DEFAULT_RATE_LIMIT))
  }
}

function checkIfTargetAvailable() {
  const response = http.get(TARGET_URL)
  if (response.status !== 200) {
    return false
  }
  return true
}

export const options = doRateLimit
  ? getRequestRateOptions(DEFAULT_RATE_LIMIT)
  : getTestOptions(TEST_TYPE)

// export const options =  {
// A number specifying the number of VUs to run concurrently.
//vus: 5,
// A string specifying the total duration of the test run.
// duration: '30s'

// setup k6 code
export function setup() {
  if (!checkIfTargetAvailable()) {
    console.log('\n################### ABORTING TESTS ######################\n')
    exec.test.abort('Check if your node is running before calling this script!')
    return
  }

  console.log('###################################################################')
  console.log(`Starting ${TEST_TYPE} tests against server: ${TARGET_URL}`)
  console.log('Check the web dashboard report here: http://127.0.0.1:5665/')
  console.log('Keep the browser window open')
  console.log('Keep under the RATE limits?: ', doRateLimit)
  console.log('RATE_LIMIT: ', DEFAULT_RATE_LIMIT)
  console.log('###################################################################')
}

// teardown k6 code
export function teardown(data) {
  console.log('teardown tests here')
}

// The function that defines VU logic.
//
// See https://grafana.com/docs/k6/latest/examples/get-started-with-k6/ to learn more
// about authoring k6 scripts.
//
export default function () {
  // 1st step
  // Starts from the root endpoint, gets all the available routes and tries them
  stepRootEndpoint()
  sleep(1)
  // 2nd step
  // Starts from the /directCommands endpoint, gets all available commands and tries them
  stepDirectCommands()
}
