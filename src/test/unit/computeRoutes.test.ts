import { expect } from 'chai'
import sinon from 'sinon'
import { Readable } from 'stream'
import { computeRoutes } from '../../components/httpRoutes/compute.js'
import {
  ComputeGetEnvironmentsHandler,
  ComputeGetStatusHandler,
  ComputeStopHandler
} from '../../components/core/compute/index.js'
import { SERVICES_API_BASE_PATH } from '../../utils/constants.js'

// the route's handler function, taken from the express router
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
  return res
}

const request = { query: {}, headers: {}, oceanNode: {}, caller: '127.0.0.1' }

const cases = [
  {
    name: 'computeEnvironments',
    method: 'get',
    path: `${SERVICES_API_BASE_PATH}/computeEnvironments`,
    handler: ComputeGetEnvironmentsHandler
  },
  {
    name: 'computeStop',
    method: 'put',
    path: `${SERVICES_API_BASE_PATH}/compute`,
    handler: ComputeStopHandler
  },
  {
    name: 'computeStatus',
    method: 'get',
    path: `${SERVICES_API_BASE_PATH}/compute`,
    handler: ComputeGetStatusHandler
  }
]

describe('compute routes: non-200 handler answers', () => {
  afterEach(() => sinon.restore())

  for (const c of cases) {
    it(`${c.name} returns the handler's status and error instead of a 500`, async () => {
      sinon.stub(c.handler.prototype, 'handle').resolves({
        stream: null,
        status: { httpStatus: 404, error: 'C2D Engine not found' }
      })
      const res = fakeResponse()
      await routeHandler(c.method, c.path)(request, res)
      expect(res.statusCode).to.equal(404)
      expect(res.body).to.equal('C2D Engine not found')
    })

    it(`${c.name} returns the handler's result on 200`, async () => {
      sinon.stub(c.handler.prototype, 'handle').resolves({
        stream: Readable.from(JSON.stringify([{ id: 'x' }])),
        status: { httpStatus: 200 }
      })
      const res = fakeResponse()
      await routeHandler(c.method, c.path)(request, res)
      expect(res.statusCode).to.equal(200)
      expect(res.body).to.deep.equal([{ id: 'x' }])
    })
  }
})
