import { sleep } from 'k6'
import { stepRootEndpoint, stepDirectCommands, TARGET_URL } from './util.js'
// -----------------------------------------------------------------
// LIST OF TESTS TO EXECUTE
// -----------------------------------------------------------------

// - Call node root enpoint (get a list of all endpoints)
// - Call all HTTP endpoints (with & without proper params)
// - Execute requests with & without RATE limits on the node instance
// - Call directCommand enpoint with all supported commands
//

// -----------------------------------------------------------------

console.log('Starting stress tests against server: ', TARGET_URL)

export const options = {
  // Key configurations for Stress in this section
  stages: [
    { duration: '10m', target: 200 }, // traffic ramp-up from 1 to a higher 200 users over 10 minutes.
    { duration: '30m', target: 200 }, // stay at higher 200 users for 30 minutes
    { duration: '5m', target: 0 } // ramp-down to 0 users
  ]
}

// setup k6 code
export function setup() {
  console.log('setup tests here')
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
  stepRootEndpoint()
  sleep(1)
  // 2nd step
  stepDirectCommands()
}
