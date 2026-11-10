/* eslint-disable no-unused-expressions */
/**
 * ON-18 unit tests for Docker registry hardening in C2DEngineDocker:
 *   1. checkDockerImage never reflects the upstream registry body into `reason`.
 *   2. getDockerManifest binds the www-authenticate realm host to the registry host
 *      (operator Basic creds are NOT forwarded to a foreign, non-allow-listed realm).
 *   3. ALLOWED_DOCKER_REGISTRIES rejects non-listed registries BEFORE any outbound request.
 *
 * Network simulation. On this branch (rc_5.0.0, PR #1575) getDockerManifest performs its
 * HTTP calls via `fetchHeadersTimeout(url, { dispatcher: getSafeDispatcher(config) })`. When a
 * dispatcher is passed, `fetchHeadersTimeout` routes through the npm `undici` package's fetch,
 * NOT `globalThis.fetch`, so a sinon stub on `globalThis.fetch` is never hit. The realm-binding
 * tests therefore drive the real code against REAL local registries (`https.createServer` on
 * 127.0.0.1, ephemeral port) — the same idiom PR #1575's own suite uses in `safeUrl.test.ts`.
 *
 * Loopback + TLS. #1575's safe dispatcher rejects private/loopback addresses unless the config
 * allow-lists them, so the engine is built with `allowedPrivateUrlRanges` covering loopback.
 * `parseImage` maps a `127.0.0.1:<port>` registry to an `https://` URL, which is exactly the
 * scheme the credential-forwarding branch requires (`realmTrusted && protocol === 'https:'`).
 * The local servers use a self-signed cert, so the realm-binding block sets
 * NODE_TLS_REJECT_UNAUTHORIZED=0 for its duration (restored afterwards) — the only lever, since
 * getSafeDispatcher owns the TLS options. The allow-list / body-reflection tests stub the engine
 * method directly and need no network.
 */
import { expect } from 'chai'
import sinon from 'sinon'
import https from 'https'
import { AddressInfo } from 'net'
import { IncomingMessage, ServerResponse } from 'http'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { C2DClusterInfo, C2DClusterType } from '../../../@types/C2D/C2D.js'

// Self-signed cert valid for localhost / 127.0.0.1 / ::1 (expires year 2126). Used only to
// stand up the local test registries; TLS verification is disabled for these loopback servers.
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDKvXR3kp/4Qrwt
Aog2AtITWaal0nnxawztWEvs93oFaoWKIGkeuUO9qZRmqXAdkVE0Un1PtFBRG2+i
mOtbRBNwtF5j3hFGf7YQkpEF0WcPF+Vz6vG1SmOthad61QohDspoD/55b6Agpgj1
zmAEz9Y0R/u1X/hUP3ntcnzM2Zd7al3UYX7UhofI21ciOx+NfPWYU6TtqsAA1xMd
hlGL1meZ4rfA7D5cOzvPNCUa0niRVmYJxTywwYvk8lavR8ZDYpLGx/bRQng9HUnU
a5GqoPOcxJmrwwryrbtXYsyqDJ3icgkSlz1WX3Lki3Ryysh21hBuZor5Gc+g8h2M
pguc3VctAgMBAAECggEAHFKeSCwULAcKqdEOPVlkhq6CEO1X+smFO00YAklKYyJP
+I1xkgi4tXDQ2gy2rHLGIOSbO/zJMaN/E3yAeLYIbzjLbPEzgaFKyoLnPqRT3PBu
LiT20mhLh4zB6m+DpD2gOixt1QIqoRUA8HH9yP5OAuzBdcOr+f0KKAlT9Pw65NMm
Cg+yqrjp76VzIM1X+ktbuGbRoj390jUr7DJeXQW2o5o0Rgm1Z4sCufK3nptYDTrq
mhovzD74YFBJiNmx2b+CZhwNdtg0JBUP+RnEQcTUsMLS8tW4AktoEr2u6e6NjcdM
P8T8PND1OCrQN+KoSlE5Oj9sTgWyiNwSdBjPIkRpYwKBgQDb5kJTO4gdXW0jHsTG
uFw6WTgFr9lYMFhKBxRTAoxtNw45d/0Sazv+33v7UwJyCCM0RwErKq1S24Dh+Cjj
93HkDWx5LAlZeCmTci60XSc64ti8OCj9iom/3ilfmSCho7KMVk2maIh56+/vMdux
Q/09N2e5nKX3F7PUgS20xGZVjwKBgQDsBgk6bvANma6FQxpjaXs2wildMfHlE11w
Hk7qRHIulL7TpOK3a2LbUxThj7H6BWtKHVasKnE0bedYW9IKZRE9SBZeSiX7JxAJ
JQ046r3WJyp28N0mY88U2CVYcP919yvPBhlM1kpzrQqEKFhuFtRO3FOYWXl+EMv/
pD5TtjYBgwKBgQCRiBFLHnIV5Rfuj1Vxot++6f8OnHO+TriPvaGw0lX3jeFHHWcK
gpfBNUzLZwOOTl5mIbvfQq5U0Nq6Mk91l/TzFgM9KmzBnqn9YCsSyTfGXA1Oe+h8
6+wAZFqDX0deUoU/JXrccAAqmIBBkICyD6oQkpN+HvMj1bb5I8kJApYrdwKBgGHZ
dsX07CyXRBUXZr9EIcLn6AItDJ3t01UCG7Ffwv6wyBQyTZPBP3CyFvwUeLKwwHQv
iZlC1z/nOHwXRRLuJ6GCW1On5esjnLBN3hd0qlM4VZCN9wFNa7K2kXUDE8WyPUVM
v/xs8tzWJn/3wgGSEV7IVRfaMFYlXI2VaAmIhwdFAoGAXEvvLPi10knrqJ4pu9gP
M/mo7kAe2n8l0HL7w8rutj3T56BUZArXgiPrfwq+nyyL6qbCjlLWY36Lvn6JTe93
6fqjz8JPkvII9lDGuF+yM29f0Bf5xN58wfwB4mNQxjKnzbsCU/2otYaJRLK24fHA
temSJtfZnqmU+5EHJLwils8=
-----END PRIVATE KEY-----`

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDOjCCAiKgAwIBAgIUa/8IiTr4XYnc6t5j7cbTVr/gIwcwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEwOTIxMTAwMVoYDzIxMjYx
MDE2MjExMDAxWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDKvXR3kp/4QrwtAog2AtITWaal0nnxawztWEvs93oF
aoWKIGkeuUO9qZRmqXAdkVE0Un1PtFBRG2+imOtbRBNwtF5j3hFGf7YQkpEF0WcP
F+Vz6vG1SmOthad61QohDspoD/55b6Agpgj1zmAEz9Y0R/u1X/hUP3ntcnzM2Zd7
al3UYX7UhofI21ciOx+NfPWYU6TtqsAA1xMdhlGL1meZ4rfA7D5cOzvPNCUa0niR
VmYJxTywwYvk8lavR8ZDYpLGx/bRQng9HUnUa5GqoPOcxJmrwwryrbtXYsyqDJ3i
cgkSlz1WX3Lki3Ryysh21hBuZor5Gc+g8h2Mpguc3VctAgMBAAGjgYEwfzAdBgNV
HQ4EFgQU4zOOXDyai2A0qnToSA1mxULDiIAwHwYDVR0jBBgwFoAU4zOOXDyai2A0
qnToSA1mxULDiIAwDwYDVR0TAQH/BAUwAwEB/zAsBgNVHREEJTAjgglsb2NhbGhv
c3SHBH8AAAGHEAAAAAAAAAAAAAAAAAAAAAEwDQYJKoZIhvcNAQELBQADggEBAMLf
eSmbi2bL3nSVyuscFZ4jfFFXhPiOScl2KgIqeT7KHcIhn4FCtLquxq1sbkahJiTR
Cd/kr8VBXXiholOldsLnB3OXt4rz3lRRJJNDC4IG3lKjHKjITn7GMNiJV76B0bzU
iWl467vj74DPcB54bUGJbGcxn4lWaKupBxgvIjXs0fvPUb/IAigP7Yqv2Kgk/lKa
2Kp+Uh7JgzfU9NAezC4lG7qaD4YwEOAf9+rv3epNDEaqbI9J1bEyccvNA5RKbHpp
6PxnSR1DdkHpYV3iQvdX653wjr3r0NgONsixuaCoDIxkecmxW9eoGaJ3a+7nXVgh
1bfvl2lNkTLqCIAsXUc=
-----END CERTIFICATE-----`

// Loopback ranges the engine config must allow so #1575's safe dispatcher permits the
// local test registries. Keyed identically across tests so getSafeDispatcher caches one agent.
const LOOPBACK_RANGES = ['127.0.0.1/32', '::1/128']

function makeEngine(config: any): C2DEngineDocker {
  // No socketPath / host → Dockerode is never constructed → this.docker stays null, so
  // checkDockerImage skips the local-image path and we can drive the remote branch directly.
  const clusterConfig: C2DClusterInfo = {
    type: C2DClusterType.DOCKER,
    hash: 'test-cluster-hash',
    connection: {},
    tempFolder: '/tmp/test-docker-on18'
  } as any
  // Allow loopback so getSafeDispatcher / checkUrlHost permit the local registries. A test
  // may override by passing its own allowedPrivateUrlRanges.
  const fullConfig = {
    allowedPrivateUrlRanges: LOOPBACK_RANGES,
    ...config
  }
  return new C2DEngineDocker(
    clusterConfig,
    null as any,
    null as any,
    null as any,
    fullConfig as any
  )
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

async function startRegistry(
  handler: Handler
): Promise<{ server: https.Server; port: number; origin: string }> {
  const server = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return { server, port, origin: `https://127.0.0.1:${port}` }
}

describe('ON-18: Docker registry body-reflection, realm binding, allow-list', () => {
  afterEach(() => {
    sinon.restore()
  })

  describe('checkDockerImage does not reflect upstream bodies', () => {
    it('returns a generic reason and hides upstream detail on manifest error', async () => {
      const engine = makeEngine({ allowedDockerRegistries: [] })
      // Simulate an upstream registry error carrying sensitive internal detail.
      const upstreamSecret = 'INTERNAL-UPSTREAM-SECRET-token=abcd1234'
      sinon.stub(engine, 'getDockerManifest').rejects({
        message: upstreamSecret,
        errors: [{ code: 'UNAUTHORIZED', message: upstreamSecret }]
      })

      const result = await engine.checkDockerImage(
        'registry-1.docker.io/library/alpine:latest'
      )
      expect(result.valid).to.be.false
      expect(result.status).to.equal(404)
      expect(result.reason).to.equal('Image manifest could not be retrieved')
      // The caller-facing reason must NOT contain any upstream body substring.
      expect(result.reason).to.not.contain(upstreamSecret)
      expect(result.reason).to.not.contain('UNAUTHORIZED')
    })
  })

  describe('ALLOWED_DOCKER_REGISTRIES allow-list (opt-in)', () => {
    it('rejects an image from a non-listed registry before any outbound request', async () => {
      const engine = makeEngine({ allowedDockerRegistries: ['ghcr.io'] })
      const manifestStub = sinon.stub(engine, 'getDockerManifest').resolves({})

      const result = await engine.checkDockerImage('quay.io/owner/img:latest')
      expect(result.valid).to.be.false
      expect(result.status).to.equal(400)
      expect(result.reason).to.contain('allowed registries')
      // No outbound manifest fetch must have happened.
      expect(manifestStub.called).to.be.false
    })

    it('allows an image from a listed registry (proceeds to manifest check)', async () => {
      const engine = makeEngine({ allowedDockerRegistries: ['ghcr.io'] })
      const manifestStub = sinon
        .stub(engine, 'getDockerManifest')
        .resolves({ platform: { architecture: 'amd64', os: 'linux' } })

      const result = await engine.checkDockerImage('ghcr.io/owner/img:latest')
      // The allow-list did not short-circuit: the manifest path ran.
      expect(manifestStub.calledOnce).to.be.true
      expect(result.valid).to.be.true
    })

    it('empty allow-list keeps current behaviour (any registry allowed)', async () => {
      const engine = makeEngine({ allowedDockerRegistries: [] })
      const manifestStub = sinon
        .stub(engine, 'getDockerManifest')
        .resolves({ platform: { architecture: 'amd64', os: 'linux' } })

      const result = await engine.checkDockerImage('quay.io/owner/img:latest')
      expect(manifestStub.calledOnce).to.be.true
      expect(result.valid).to.be.true
    })
  })

  // Regression: `parseImage` must classify the first path segment the same way `docker.pull`
  // resolves it (Docker `splitDockerDomain`). Otherwise `localhost/x` and `MyReg/x` (uppercase
  // single-label host) are mis-read as Docker Hub and slip past a Hub-only allow-list, yet Docker
  // pulls them from the local / `MyReg` registry.
  describe('ALLOWED_DOCKER_REGISTRIES: localhost / uppercase host are not mis-classified as Hub', () => {
    const HUB_ONLY = { allowedDockerRegistries: ['registry-1.docker.io'] }

    it('parseImage treats localhost and an uppercase single-label host as a registry', () => {
      const engine = makeEngine(HUB_ONLY)
      const parse = (img: string) => (engine as any).parseImage(img)

      expect(parse('localhost/evil:latest').registry).to.equal('http://localhost')
      expect(parse('localhost/evil:latest').name).to.equal('evil')
      expect(parse('localhost:5000/evil').registry).to.equal('http://localhost:5000')
      // Uppercase single-label host → registry (not the Hub `library/<name>` form).
      expect(parse('MyReg/evil').registry).to.equal('https://MyReg')
      expect(parse('MyReg/evil').name).to.equal('evil')
      // A normal Hub image is still Hub.
      expect(parse('alpine:latest').registry).to.equal('https://registry-1.docker.io')
    })

    it('checkDockerImage rejects localhost/x under a Hub-only allow-list, no manifest fetch', async () => {
      const engine = makeEngine(HUB_ONLY)
      const manifestStub = sinon.stub(engine, 'getDockerManifest').resolves({})

      const result = await engine.checkDockerImage('localhost/evil:latest')
      expect(result.valid).to.be.false
      expect(result.status).to.equal(400)
      expect(result.reason).to.contain('allowed registries')
      expect(manifestStub.called).to.be.false
    })

    it('checkDockerImage rejects MyReg/x under a Hub-only allow-list, no manifest fetch', async () => {
      const engine = makeEngine(HUB_ONLY)
      const manifestStub = sinon.stub(engine, 'getDockerManifest').resolves({})

      const result = await engine.checkDockerImage('MyReg/evil:latest')
      expect(result.valid).to.be.false
      expect(result.status).to.equal(400)
      expect(result.reason).to.contain('allowed registries')
      expect(manifestStub.called).to.be.false
    })

    it('service pull path (pullImageRef) rejects localhost/x and MyReg/x without calling docker.pull', async () => {
      const engine = makeEngine(HUB_ONLY)
      const pull = sinon.stub().resolves({})
      ;(engine as any).docker = { pull }
      sinon.stub(engine as any, 'getImagePullTimeoutMs').returns(1000)

      for (const img of ['localhost/evil:latest', 'MyReg/evil:latest']) {
        let threw = false
        try {
          await (engine as any).pullImageRef(img)
        } catch (e: any) {
          threw = true
          expect(e.message).to.contain('allowed registries')
        }
        expect(threw, `expected ${img} to be rejected`).to.be.true
      }
      expect(pull.called).to.be.false
    })
  })

  describe('getDockerManifest binds www-authenticate realm host to registry host', () => {
    const servers: https.Server[] = []
    let savedTlsReject: string | undefined

    async function registry(handler: Handler): Promise<{ port: number; origin: string }> {
      const { server, port, origin } = await startRegistry(handler)
      servers.push(server)
      return { port, origin }
    }

    before(() => {
      // The local registries use a self-signed cert; getSafeDispatcher owns the undici TLS
      // options, so disabling verification for loopback here is the only available lever.
      savedTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    })

    after(() => {
      if (savedTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTlsReject
    })

    afterEach(async () => {
      while (servers.length) {
        const server = servers.pop() as https.Server
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    function creds(origin: string) {
      return { [origin]: { username: 'operator', password: 'secret', auth: '' } }
    }

    it('fetches the token ANONYMOUSLY (no operator creds) when the realm host differs', async () => {
      // A foreign realm host (like an attacker's) must never receive the operator's Basic
      // credentials — but the token IS still fetched anonymously so legitimate registries that
      // serve tokens on a separate host (Docker Hub -> auth.docker.io) keep working.
      const captured: { manifestAuth: Array<string | undefined>; tokenAuth?: string } = {
        manifestAuth: []
      }

      // Foreign realm (token endpoint) on its own host:port.
      const foreign = await registry((req, res) => {
        captured.tokenAuth = req.headers.authorization
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ token: 'abc' }))
      })

      // Registry: 401 pointing the realm at the foreign host; 200 once a Bearer token is sent.
      const reg = await registry((req, res) => {
        captured.manifestAuth.push(req.headers.authorization)
        if ((req.headers.authorization || '').startsWith('Bearer ')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ schemaVersion: 2 }))
          return
        }
        res.writeHead(401, {
          'www-authenticate': `Bearer realm="${foreign.origin}/token",service="registry.docker.io"`
        })
        res.end()
      })

      const engine = makeEngine({ allowedDockerRegistries: [] })
      ;(engine as any).dockerRegistryAuths = creds(reg.origin)

      const manifest = await engine.getDockerManifest(
        `127.0.0.1:${reg.port}/library/alpine:latest`
      )
      expect(manifest).to.deep.equal({ schemaVersion: 2 })
      // CRITICAL: the token fetch to the foreign realm carried NO Authorization header.
      expect(captured.tokenAuth).to.equal(undefined)
      // The flow still completed: initial Basic-authed manifest -> 401 -> anon token -> Bearer.
      expect(captured.manifestAuth[0]).to.match(/^Basic /)
      expect(captured.manifestAuth[1]).to.equal('Bearer abc')
    })

    it('forwards operator creds to a same-host realm (and sets redirect:error)', async () => {
      // Realm host == registry host over https: the operator's Basic creds ARE forwarded, and
      // `redirect: 'error'` binds that credential header to the vetted host. We prove both by
      // making the (same-host) token endpoint answer with a redirect: with redirect:'error'
      // the fetch must reject, so getDockerManifest throws — while the server still observes the
      // Basic Authorization header on the token request it received first.
      const captured: { tokenAuth?: string } = {}
      let regPort = 0

      const reg = await registry((req, res) => {
        if (req.url && req.url.startsWith('/token')) {
          captured.tokenAuth = req.headers.authorization
          res.writeHead(302, { location: `https://127.0.0.1:${regPort}/elsewhere` })
          res.end()
          return
        }
        res.writeHead(401, {
          'www-authenticate': `Bearer realm="https://127.0.0.1:${regPort}/token",service="registry.docker.io"`
        })
        res.end()
      })
      regPort = reg.port

      const engine = makeEngine({ allowedDockerRegistries: [] })
      ;(engine as any).dockerRegistryAuths = creds(reg.origin)

      let threw = false
      try {
        await engine.getDockerManifest(`127.0.0.1:${reg.port}/library/alpine:latest`)
      } catch {
        threw = true
      }
      // redirect:'error' was applied: the token fetch rejected on the 302 instead of following it.
      expect(threw).to.be.true
      // The same-host https realm received the operator's Basic credentials.
      expect(captured.tokenAuth).to.match(/^Basic /)
    })

    it('proceeds to the token fetch when the realm host matches the registry host', async () => {
      let regPort = 0
      const reg = await registry((req, res) => {
        if (req.url && req.url.startsWith('/token')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ token: 'abc' }))
          return
        }
        if ((req.headers.authorization || '').startsWith('Bearer ')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ schemaVersion: 2 }))
          return
        }
        res.writeHead(401, {
          'www-authenticate': `Bearer realm="https://127.0.0.1:${regPort}/token",service="registry.docker.io"`
        })
        res.end()
      })
      regPort = reg.port

      const engine = makeEngine({ allowedDockerRegistries: [] })

      const manifest = await engine.getDockerManifest(
        `127.0.0.1:${reg.port}/library/alpine:latest`
      )
      expect(manifest).to.deep.equal({ schemaVersion: 2 })
    })

    it('forwards creds to a realm host explicitly listed in ALLOWED_DOCKER_REGISTRIES', async () => {
      // A realm host that DIFFERS from the registry host but is explicitly allow-listed is
      // trusted: the operator's creds are forwarded to it and the pull proceeds. (Without the
      // allow-list entry this is the anonymous-foreign-realm case above.)
      const captured: { tokenAuth?: string } = {}

      const foreign = await registry((req, res) => {
        captured.tokenAuth = req.headers.authorization
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ token: 'abc' }))
      })

      const reg = await registry((req, res) => {
        if ((req.headers.authorization || '').startsWith('Bearer ')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ schemaVersion: 2 }))
          return
        }
        res.writeHead(401, {
          'www-authenticate': `Bearer realm="${foreign.origin}/token",service="registry.docker.io"`
        })
        res.end()
      })

      // Allow-list the foreign realm host:port so it is treated as trusted.
      const engine = makeEngine({
        allowedDockerRegistries: [`127.0.0.1:${foreign.port}`]
      })
      ;(engine as any).dockerRegistryAuths = creds(reg.origin)

      const manifest = await engine.getDockerManifest(
        `127.0.0.1:${reg.port}/library/alpine:latest`
      )
      expect(manifest).to.deep.equal({ schemaVersion: 2 })
      // The allow-listed foreign realm (https) received the operator's Basic credentials.
      expect(captured.tokenAuth).to.match(/^Basic /)
    })

    it('forwards creds to a realm host trusted via ALLOWED_DOCKER_REGISTRY_REALMS', async () => {
      // A realm host that DIFFERS from the registry host but is trusted through the dedicated
      // realm setting (NOT the registry allow-list) receives the operator's creds. Because
      // allowedDockerRegistries stays empty, allow-list mode is NOT enabled — any registry is
      // still pullable; only the realm host is additionally trusted.
      const captured: { tokenAuth?: string } = {}

      const foreign = await registry((req, res) => {
        captured.tokenAuth = req.headers.authorization
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ token: 'abc' }))
      })

      const reg = await registry((req, res) => {
        if ((req.headers.authorization || '').startsWith('Bearer ')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ schemaVersion: 2 }))
          return
        }
        res.writeHead(401, {
          'www-authenticate': `Bearer realm="${foreign.origin}/token",service="registry.docker.io"`
        })
        res.end()
      })

      // Trust the foreign realm host:port via the dedicated realm setting; leave the registry
      // allow-list empty so allow-list mode is NOT turned on by this.
      const engine = makeEngine({
        allowedDockerRegistries: [],
        allowedDockerRegistryRealms: [`127.0.0.1:${foreign.port}`]
      })
      ;(engine as any).dockerRegistryAuths = creds(reg.origin)

      const manifest = await engine.getDockerManifest(
        `127.0.0.1:${reg.port}/library/alpine:latest`
      )
      expect(manifest).to.deep.equal({ schemaVersion: 2 })
      expect(captured.tokenAuth).to.match(/^Basic /)
    })
  })
})
