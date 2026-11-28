import { expect, assert } from 'chai'
import http, { Server } from 'http'
import { AddressInfo } from 'net'
import { Readable } from 'stream'
import {
  PRIVATE_URL_ERROR,
  checkHostnameSync,
  checkUrlHost,
  createSafeAgent,
  createSafeLookup,
  getSafeDispatcher,
  isBlockedAddress,
  parseAllowedRanges,
  resolveSafeAddress
} from '../../utils/safeUrl.js'
import { fetchStream } from '../../utils/http.js'
import { fetchFileMetadata } from '../../utils/asset.js'
import { UrlStorage } from '../../components/storage/UrlStorage.js'
import { FTPStorage } from '../../components/storage/FTPStorage.js'
import { S3Storage } from '../../components/storage/S3Storage.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { DEFAULT_UNSAFE_URLS } from '../../utils/config/constants.js'
import { getConfiguration } from '../../utils/index.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import {
  TEST_ENV_CONFIG_PATH,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

function configWith(allowed: string[] = []): OceanNodeConfig {
  return {
    unsafeURLs: [...DEFAULT_UNSAFE_URLS],
    allowedPrivateUrlRanges: allowed
  } as unknown as OceanNodeConfig
}

// undici's fetch wraps connector errors: TypeError('fetch failed', { cause })
function errorText(err: any): string {
  return [err?.message, err?.cause?.message].filter(Boolean).join(' | ')
}

async function rejects(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    return errorText(err)
  }
  assert.fail('expected the request to be rejected')
}

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe('safeUrl: isBlockedAddress', () => {
  const blocked = [
    // IPv4 loopback / private / link-local / CGNAT / special
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.100.100.200',
    '0.0.0.0',
    '0.1.2.3',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.0.192',
    '192.0.2.1',
    '198.18.0.1',
    '240.0.0.1',
    // IPv6
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1'
  ]
  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.0.7', // Barge network: public space, must stay reachable
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8'
  ]

  it('blocks loopback, private, link-local, CGNAT, multicast and reserved addresses', () => {
    for (const ip of blocked) {
      expect(isBlockedAddress(ip), ip).to.equal(true)
    }
  })

  it('allows public unicast addresses', () => {
    for (const ip of allowed) {
      expect(isBlockedAddress(ip), ip).to.equal(false)
    }
  })

  it('fails closed on garbage', () => {
    expect(isBlockedAddress('not-an-ip')).to.equal(true)
    expect(isBlockedAddress('')).to.equal(true)
  })

  it('honours operator allow-list ranges (CIDR and single IP, v4 and v6, mapped v4)', () => {
    const ranges = parseAllowedRanges([
      '10.0.0.0/8',
      '192.168.1.5',
      'fd00::/8',
      'junk',
      42
    ])
    expect(ranges).to.have.length(3)
    expect(isBlockedAddress('10.1.2.3', ranges)).to.equal(false)
    expect(isBlockedAddress('::ffff:10.1.2.3', ranges)).to.equal(false)
    expect(isBlockedAddress('192.168.1.5', ranges)).to.equal(false)
    expect(isBlockedAddress('192.168.1.6', ranges)).to.equal(true)
    expect(isBlockedAddress('fd00::1', ranges)).to.equal(false)
    expect(isBlockedAddress('fe80::1', ranges)).to.equal(true)
    expect(isBlockedAddress('127.0.0.1', ranges)).to.equal(true)
  })
})

describe('safeUrl: synchronous host checks', () => {
  it('rejects localhost names and IP literals, accepts DNS names and public IPs', () => {
    for (const host of [
      'localhost',
      'LOCALHOST.',
      'foo.localhost',
      '127.0.0.1',
      '[::1]',
      '::1',
      '10.0.0.1'
    ]) {
      expect(checkHostnameSync(host), host).to.equal(PRIVATE_URL_ERROR)
    }
    expect(checkHostnameSync('')).to.equal('URL has no host')
    for (const host of [
      'example.com',
      'elasticsearch',
      '8.8.8.8',
      '[2606:4700:4700::1111]'
    ]) {
      expect(checkHostnameSync(host), host).to.equal(null)
    }
  })

  it('lets localhost through only when loopback is allow-listed', () => {
    expect(checkHostnameSync('localhost', parseAllowedRanges(['127.0.0.1/32']))).to.equal(
      null
    )
    expect(checkHostnameSync('localhost', parseAllowedRanges(['10.0.0.0/8']))).to.equal(
      PRIVATE_URL_ERROR
    )
  })

  it('normalises alternative IP encodings through the URL parser', () => {
    const urls = [
      'http://2130706433/', // decimal 127.0.0.1
      'http://0x7f000001/', // hex
      'http://0177.0.0.1/', // octal
      'http://0/', // 0.0.0.0
      'http://[::ffff:127.0.0.1]/',
      'http://[fe80::1]/',
      'http://user:pw@10.0.0.1:8080/x', // credentials do not hide the host
      'http://192.168.0.1:8108/collections'
    ]
    for (const url of urls) {
      expect(checkUrlHost(url, configWith()), url).to.equal(PRIVATE_URL_ERROR)
    }
    expect(checkUrlHost('https://example.com/a', configWith())).to.equal(null)
    expect(checkUrlHost('http://elasticsearch:9200/', configWith())).to.equal(null)
    expect(checkUrlHost('not a url', configWith())).to.equal('Invalid URL')
    expect(checkUrlHost('http://10.0.0.1/', configWith(['10.0.0.0/8']))).to.equal(null)
  })

  it('resolveSafeAddress keeps public literals and rejects blocked ones', async () => {
    expect(await resolveSafeAddress('8.8.8.8')).to.deep.equal({
      address: '8.8.8.8',
      family: 4
    })
    expect(await rejects(resolveSafeAddress('127.0.0.1'))).to.include(PRIVATE_URL_ERROR)
    // localhost is resolved by the OS resolver, no network needed
    expect(await rejects(resolveSafeAddress('localhost'))).to.include(PRIVATE_URL_ERROR)
    expect(
      await resolveSafeAddress(
        'localhost',
        parseAllowedRanges(['127.0.0.0/8', '::1/128'])
      )
    ).to.have.property('address')
  })
})

describe('safeUrl: storage validation', () => {
  const config = configWith()

  it('UrlStorage rejects private / loopback targets with the defaults', () => {
    const urls = [
      'http://10.0.0.1/file',
      'http://192.168.1.1/x',
      'http://172.16.5.5:8080/',
      'http://localhost/',
      'http://localhost:8108/collections',
      'http://[::1]/',
      'http://2130706433/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.100.100.200/latest/meta-data/'
    ]
    for (const url of urls) {
      let error: Error
      try {
        // eslint-disable-next-line no-new
        new UrlStorage({ type: 'url', url, method: 'get' }, config)
      } catch (err) {
        error = err
      }
      expect(error, url).to.be.instanceOf(Error)
      expect(error.message, url).to.match(
        /URL is marked as unsafe|private, loopback or reserved/
      )
    }
  })

  it('UrlStorage still accepts public URLs and DNS names (checked at connect time)', () => {
    for (const url of [
      'https://example.com/file.json',
      'http://elasticsearch:9200/',
      'http://172.15.0.7:80/'
    ]) {
      const storage = new UrlStorage({ type: 'url', url, method: 'get' }, config)
      expect(storage.getDownloadUrl()).to.equal(url)
    }
  })

  it('UrlStorage requires http(s)', () => {
    expect(
      () => new UrlStorage({ type: 'url', url: 'mailto:x', method: 'get' }, config)
    ).to.throw('URL must be http:// or https://')
  })

  it('UrlStorage honours allowedPrivateUrlRanges', () => {
    const storage = new UrlStorage(
      { type: 'url', url: 'http://10.0.5.20:9000/bucket/file', method: 'get' },
      configWith(['10.0.5.20/32'])
    )
    expect(storage.validate()).to.eql([true, ''])
    expect(
      () =>
        new UrlStorage(
          { type: 'url', url: 'http://10.0.5.21:9000/bucket/file', method: 'get' },
          configWith(['10.0.5.20/32'])
        )
    ).to.throw(PRIVATE_URL_ERROR)
  })

  it('FTPStorage rejects private literals and accepts DNS names', () => {
    // 127.0.0.1 is also in the default UNSAFE_URLS regex list, so the regex message wins
    expect(
      () => new FTPStorage({ type: 'ftp', url: 'ftp://127.0.0.1/file' }, config)
    ).to.throw(/URL is marked as unsafe|private, loopback or reserved/)
    expect(
      () => new FTPStorage({ type: 'ftp', url: 'ftp://10.0.0.5/file' }, config)
    ).to.throw(PRIVATE_URL_ERROR)
    expect(
      () => new FTPStorage({ type: 'ftp', url: 'ftps://localhost/file' }, config)
    ).to.throw(PRIVATE_URL_ERROR)
    const ok = new FTPStorage({ type: 'ftp', url: 'ftp://ftp.example.com/file' }, config)
    expect(ok.validate()).to.eql([true, ''])
  })

  it('S3Storage rejects private endpoints and accepts DNS names', () => {
    const s3 = (endpoint: string) => ({
      type: 's3',
      s3Access: {
        endpoint,
        bucket: 'b',
        objectKey: 'k',
        accessKeyId: 'a',
        secretAccessKey: 's'
      }
    })
    expect(() => new S3Storage(s3('http://192.168.1.5:9000') as any, config)).to.throw(
      PRIVATE_URL_ERROR
    )
    expect(() => new S3Storage(s3('localhost:9000') as any, config)).to.throw(
      PRIVATE_URL_ERROR
    )
    expect(() => new S3Storage(s3('http://[::1]:9000') as any, config)).to.throw(
      PRIVATE_URL_ERROR
    )
    const ok = new S3Storage(s3('s3.example.com') as any, config)
    expect(ok.validate()).to.eql([true, ''])
    const lan = new S3Storage(
      s3('http://192.168.1.5:9000') as any,
      configWith(['192.168.1.0/24'])
    )
    expect(lan.validate()).to.eql([true, ''])
  })
})

describe('safeUrl: connect-time enforcement (local server)', () => {
  let server: Server
  let port: number

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect-literal') {
        res.writeHead(302, { location: 'http://10.255.255.1:8080/' })
        res.end()
        return
      }
      if (req.url === '/redirect-localhost') {
        res.writeHead(302, { location: `http://localhost:${port}/ok` })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    ;({ port } = server.address() as AddressInfo)
  })

  after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('refuses a loopback IP literal', async () => {
    const text = await rejects(
      fetchStream(`http://127.0.0.1:${port}/ok`, { dispatcher: createSafeAgent([]) })
    )
    expect(text).to.include(PRIVATE_URL_ERROR)
  })

  it('refuses a name that resolves to loopback (DNS answer is checked)', async () => {
    const text = await rejects(
      fetchStream(`http://localhost:${port}/ok`, { dispatcher: createSafeAgent([]) })
    )
    expect(text).to.include(PRIVATE_URL_ERROR)
  })

  it('validating lookup rejects when any resolved address is blocked', async () => {
    const lookup = createSafeLookup([])
    const text = await rejects(
      new Promise((resolve, reject) =>
        lookup('localhost', { all: true }, (err, address) =>
          err ? reject(err) : resolve(address)
        )
      )
    )
    expect(text).to.include(PRIVATE_URL_ERROR)
    expect(text).to.include('resolves to')
    const allowedLookup = createSafeLookup(parseAllowedRanges(['127.0.0.0/8', '::1/128']))
    const addresses = await new Promise((resolve, reject) =>
      allowedLookup('localhost', { all: true }, (err, address) =>
        err ? reject(err) : resolve(address)
      )
    )
    expect(addresses).to.be.an('array')
    expect((addresses as unknown[]).length).to.be.greaterThan(0)
  })

  it('dual-stack name: connects to the allow-listed address, never the blocked one', async () => {
    // localhost on most CI hosts answers [::1, 127.0.0.1]; only 127.0.0.1 is allow-listed
    const fake: any = (_h: string, _o: unknown, cb: any) =>
      cb(null, [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 }
      ])
    const lookup = createSafeLookup(parseAllowedRanges(['127.0.0.1/32']), fake)
    const result: any = await new Promise((resolve, reject) =>
      lookup('localhost', { all: true }, (err, address) =>
        err ? reject(err) : resolve(address)
      )
    )
    expect(result.map((entry: any) => entry.address)).to.deep.equal(['127.0.0.1'])
    // every answer blocked: refused
    const allBlocked = createSafeLookup([], fake)
    const text = await rejects(
      new Promise((resolve, reject) =>
        allBlocked('localhost', { all: true }, (err, address) =>
          err ? reject(err) : resolve(address)
        )
      )
    )
    expect(text).to.include(PRIVATE_URL_ERROR)
    // public + private mix (rebinding style): only the public one is handed out
    const mixed: any = (_h: string, _o: unknown, cb: any) =>
      cb(null, [
        { address: '10.0.0.1', family: 4 },
        { address: '93.184.216.34', family: 4 }
      ])
    const out: any = await new Promise((resolve, reject) =>
      createSafeLookup([], mixed)('x.example', { all: true }, (err, address) =>
        err ? reject(err) : resolve(address)
      )
    )
    expect(out.map((entry: any) => entry.address)).to.deep.equal(['93.184.216.34'])
  })

  it('allows it when the range is allow-listed and streams the body', async () => {
    const dispatcher = createSafeAgent(['127.0.0.0/8', '::1/128'])
    const res = await fetchStream(`http://localhost:${port}/ok`, { dispatcher })
    expect(res.httpStatus).to.equal(200)
    expect(await collect(res.stream)).to.equal('ok')
    await dispatcher.close()
  })

  it('checks every redirect hop: public first hop, private redirect target', async () => {
    // first hop allow-listed so the redirect is actually followed
    const dispatcher = createSafeAgent(['127.0.0.1/32'])
    const text = await rejects(
      fetchStream(`http://127.0.0.1:${port}/redirect-literal`, { dispatcher })
    )
    expect(text).to.include(PRIVATE_URL_ERROR)
    expect(text).to.include('10.255.255.1')
    await dispatcher.close()
  })

  it('fetchFileMetadata reports a blocked URL instead of empty metadata', async () => {
    const text = await rejects(
      fetchFileMetadata(`http://localhost:${port}/ok`, 'get', false, undefined, {
        dispatcher: createSafeAgent([])
      })
    )
    expect(text).to.include(PRIVATE_URL_ERROR)
    const ok = await fetchFileMetadata(
      `http://localhost:${port}/ok`,
      'get',
      false,
      undefined,
      {
        dispatcher: createSafeAgent(['127.0.0.0/8', '::1/128'])
      }
    )
    expect(ok.contentLength).to.equal('2')
  })

  it('getSafeDispatcher caches one agent per allow-list', () => {
    const a = getSafeDispatcher(configWith(['10.0.0.0/8']))
    const b = getSafeDispatcher(configWith(['10.0.0.0/8']))
    const c = getSafeDispatcher(configWith([]))
    expect(a).to.equal(b)
    expect(a).to.not.equal(c)
    expect(getSafeDispatcher(undefined)).to.equal(c)
  })
})

describe('safeUrl: configuration (UNSAFE_URLS additive, ALLOWED_PRIVATE_URL_RANGES)', () => {
  async function configFromEnv(vars: Record<string, string>): Promise<OceanNodeConfig> {
    const names = Object.keys(vars).map(
      (name) => ENVIRONMENT_VARIABLES[name as keyof typeof ENVIRONMENT_VARIABLES]
    )
    const overrides = buildEnvOverrideConfig(names, Object.values(vars))
    try {
      await setupEnvironment(TEST_ENV_CONFIG_PATH, overrides)
      return await getConfiguration(true)
    } finally {
      await tearDownEnvironment(overrides)
    }
  }

  it('UNSAFE_URLS entries are added to the built-in defaults', async () => {
    const config = await configFromEnv({
      UNSAFE_URLS: JSON.stringify(['^https?://custom\\.internal'])
    })
    for (const entry of DEFAULT_UNSAFE_URLS) {
      expect(config.unsafeURLs).to.include(entry)
    }
    expect(config.unsafeURLs).to.include('^https?://custom\\.internal')
    expect(config.unsafeURLs).to.have.length(DEFAULT_UNSAFE_URLS.length + 1)
  })

  it('ALLOWED_PRIVATE_URL_RANGES keeps valid CIDR / IP entries and drops the rest', async () => {
    const config = await configFromEnv({
      ALLOWED_PRIVATE_URL_RANGES: JSON.stringify([
        '10.0.0.0/8',
        'nonsense',
        '192.168.1.5',
        7
      ])
    })
    expect(config.allowedPrivateUrlRanges).to.deep.equal(['10.0.0.0/8', '192.168.1.5'])
  })

  it('defaults: built-in unsafe list, empty allow-list, malformed input never widens it', async () => {
    const config = await configFromEnv({ ALLOWED_PRIVATE_URL_RANGES: '{not json' })
    expect(config.allowedPrivateUrlRanges).to.deep.equal([])
    expect(config.unsafeURLs).to.deep.equal([...DEFAULT_UNSAFE_URLS])
  })
})
