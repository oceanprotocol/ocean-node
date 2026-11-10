import { expect } from 'chai'
import sinon from 'sinon'
import { computeRoutes } from '../../components/httpRoutes/compute.js'
import {
  PaidComputeStartHandler,
  FreeComputeStartHandler,
  ComputeInitializeHandler
} from '../../components/core/compute/index.js'
import {
  ServiceStartHandler,
  ServiceExtendHandler
} from '../../components/core/service/index.js'
import { buildMaintenanceResponse } from '../../components/core/utils/maintenance.js'
import { MAINTENANCE_MODE_CODE, SERVICES_API_BASE_PATH } from '../../utils/constants.js'

// Pull a route's handler function straight out of the express router stack (same approach as
// computeRoutes.test.ts), so we exercise the real route logic without starting a server.
function routeHandler(method: string, routePath: string): (req: any, res: any) => any {
  const layer = (computeRoutes as any).stack.find(
    (l: any) => l.route?.path === routePath && l.route.methods[method]
  )
  if (!layer) throw new Error(`route ${method} ${routePath} not found`)
  return layer.route.stack[0].handle
}

function fakeResponse() {
  const res: any = { statusCode: 200, body: undefined }
  res.status = (code: number) => {
    res.statusCode = code
    return res
  }
  res.json = (body: unknown) => {
    res.body = body
    return res
  }
  res.send = (body: unknown) => {
    res.body = body
    return res
  }
  res.set = () => res
  return res
}

function makeRequest(body: any = {}) {
  return { query: {}, headers: {}, body, oceanNode: {}, caller: '127.0.0.1' }
}

describe('maintenance mode REST routes surface 503 + code', () => {
  afterEach(() => sinon.restore())

  const cases: Array<{
    name: string
    method: string
    path: string
    handler: any
    body: any
  }> = [
    {
      name: 'computeStart',
      method: 'post',
      path: `${SERVICES_API_BASE_PATH}/compute`,
      handler: PaidComputeStartHandler,
      body: {}
    },
    {
      name: 'freeCompute',
      method: 'post',
      path: `${SERVICES_API_BASE_PATH}/freeCompute`,
      handler: FreeComputeStartHandler,
      body: {}
    },
    {
      name: 'initializeCompute',
      method: 'post',
      path: `${SERVICES_API_BASE_PATH}/initializeCompute`,
      handler: ComputeInitializeHandler,
      // the route 400s on a missing algorithm before it reaches the handler
      body: { algorithm: {}, datasets: [] }
    },
    {
      name: 'serviceStart',
      method: 'post',
      path: `${SERVICES_API_BASE_PATH}/serviceStart`,
      handler: ServiceStartHandler,
      body: {}
    },
    {
      name: 'serviceExtend',
      method: 'post',
      path: `${SERVICES_API_BASE_PATH}/serviceExtend`,
      handler: ServiceExtendHandler,
      body: {}
    }
  ]

  for (const c of cases) {
    it(`${c.name} responds 503 (NOT 200) with code=MAINTENANCE_MODE in the body`, async () => {
      // The handler returns the real maintenance response: BOTH a 503 status AND a stream body.
      sinon.stub(c.handler.prototype, 'handle').resolves(buildMaintenanceResponse())
      const req = makeRequest(c.body)
      const res = fakeResponse()
      // runServiceCommand reads res.req.oceanNode, so the two must be linked.
      res.req = req
      await routeHandler(c.method, c.path)(req, res)
      // B1 regression guard: a stream-bearing 503 must never be answered as 200.
      expect(res.statusCode).to.equal(503)
      // B2: the machine-readable code must reach the client in the JSON body.
      expect(res.body).to.be.an('object')
      expect((res.body as any).code).to.equal(MAINTENANCE_MODE_CODE)
      expect((res.body as any).error).to.be.a('string')
    })
  }
})
