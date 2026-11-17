# Tests

## Unit tests

The unit tests run on the database that `DB_TYPE` selects. With no `DB_TYPE` and no `DB_URL`
they run on SQLite and need no database container:

```bash
export PRIVATE_KEY=0x<your test key>
npm run test:unit
```

The tests load `src/test/.env.test` for the variables that the shell does not set. If that
file has `DB_URL`, `DB_USERNAME` and `DB_PASSWORD` lines for Elasticsearch, the tests run on
Elasticsearch: remove the lines, or set the variables to empty values in the shell
(`DB_TYPE= DB_URL= DB_USERNAME= DB_PASSWORD= npm run test:unit`).

The SQLite files of the tests are in `databases/` in the repository folder. Do not run the
tests in the folder of a node that you use.

### On PostgreSQL

```bash
docker-compose -f postgresql-compose.yml up -d
export DB_TYPE=postgresql DB_URL=postgresql://localhost:5432/ocean
export DB_USERNAME=ocean DB_PASSWORD=changeme
npm run test:unit
```

The suites of the SQL stores make a schema of their own for each test and remove it.

### On Elasticsearch

```bash
docker-compose -f elasticsearch-compose.yml up -d
export DB_TYPE=elasticsearch DB_URL=http://localhost:9200
export DB_USERNAME=elastic DB_PASSWORD=changeme
npm run test:unit
```

Some suites use the Elasticsearch client directly and run only with `DB_TYPE=elasticsearch`
(`describeOnElasticsearch` in `src/test/utils/utils.ts`). They delete all documents in the
`auth_tokens`, `c2d_jobs`, `service_jobs`, `service_locks`, `docker_images`, `buckets`,
`node_metrics_samples` and `node_metrics_hourly` indices in `beforeEach`, and write nonces
and the maintenance flag to the `nonce` and `node_config` indices. Never point the tests at
an Elasticsearch that a running node uses.

On macOS, Elasticsearch sniffing returns the container-internal address, which the host
cannot reach. Turn sniffing off before you run the tests:

```bash
export ELASTICSEARCH_SNIFF_ON_START=false
export ELASTICSEARCH_SNIFF_INTERVAL=false
export ELASTICSEARCH_SNIFF_ON_CONNECTION_FAULT=false
```

CI runs the unit and the integration tests on the three databases.

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
