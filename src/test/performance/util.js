import http from 'k6/http'
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

export async function targetEndpoint(method, path) {
  const response = await http.asyncRequest(method.toUpperCase(), path)
  console.log(`Response from API endpoint ${TARGET_URL}${path})`, response)
}

// 1st step - get root enpoint and call all paths
export async function stepRootEndpoint() {
  const response = http.get(TARGET_URL)
  try {
    if (response.status === 200) {
      const data = JSON.parse(response.body)
      const endpoints = Object.keys(data.serviceEndpoints)
      for (const endpointName of endpoints) {
        const apiData = data.serviceEndpoints[endpointName]
        console.log('Targeting endpoint: ', endpointName, 'Method/path:', apiData)
        await targetEndpoint(apiData[0], apiData[1])
      }
      return true
    } else {
      console.log('Check if your node is running before calling this script')
    }
  } catch (error) {
    console.error(error)
  }
  return false
}