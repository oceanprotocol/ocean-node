# Tests

## Unit tests

```bash
npm run test:unit
```

## Integration tests

To run the integration tests, you should start barge locally. In a separate terminal, clone and start the necessary services using Barge:

````bash
git clone https://github.com/oceanprotocol/barge.git
cd barge
git checkout feature/nodes
./start_ocean.sh -with-c2d
'''


Now, back in your nodes terminal, you can run the tests

```bash
npm run test:integration
````

If you started barge without c2d components you can run a lighter version of integration tests that do not run the compute to data tests.

```bash
npm run test:integration:light
```

## Unit and integration .environments

Whenever possible, we should avoid overriding .env variables, as it might affect local configuration and other tests
Avoid doing things like:

```bash
process.env.PRIVATE_KEY = '0xc594c6e5def4bab63ac29ee...'
```

If we really need to change/override existing .env config:
use:

```bash
setupEnvironment() / tearDownEnvironment()
```

instead (on before() and after() hooks respectively),
Any config changes will not be permanent and the environment is preserved between tests

## Performance tests

There are 3 different scenarios that can be run; `smoke` tests, `load` tests, and `stress` tests.
Each one of those scenarios puts the ocean node into different traffic/request pressure conditions.

In order to start the suite, you need to have a running node instance first and then target the node on the tests.
Furthermore, you need to have previously installed grafana k6 tools on your machine: [https://grafana.com/docs/k6/latest/set-up/install-k6/](https://grafana.com/docs/k6/latest/set-up/install-k6/).
You can use `TARGET_URL` env variable to specify the target URL for the tests (by default runs against the local node, if any)

To run them, use one of the following options;

```bash
npm run test:smoke
npm run test:load
npm run test:stress
```

The 1st option performs a more "lightweight" approach, with fewer requests and less virtual users involved.
The 2nd and the 3rd options put the node into greater pressure for longer periods of time, also making more requests and simulating more usage
Additionally, you can also execute another test that will instruct the k6 script to keep the request rate under the node `RATE LIMIT` verifications
By default (can be customized) the ocean node allows a MAX of 3 requests per second, from the same originating address/ip. Anything above that is denied.
So if you want to avoid the rate limitations and still perform a battery of HTTP requests, you can set `RATE_LIMIT` env var.
The value of this variable should be lower than the value definied on the node itself (same env var name on the node instance)
To run this rate limited tests do;

```bash
npm run test:request:rate
```

At the end of the test suite, you can check the generated HTML report `html-report.html` for more insigths.
Additionally, while the tests are running you can open
a browser page at `http://127.0.0.1:5665/` and see a live report

For a more detailed view of all the options available and the type of requests executed check the script: [../src/test/performance/util.js](../src/test/performance/util.js)

## Additional tests / helper scripts

There are a couple of helper scripts to help test additional functionality and components integration. These can be found under 'src/helpers/scripts'
To run them, do either:

```
npm run client
```

(Purpose: for downloadURL flow. It requires at least 2 nodes properly configured and running)

OR

```
npm run check-nonce
```

(Purpose: for checking nonce tracking flow. This last one requires DB up and running)
