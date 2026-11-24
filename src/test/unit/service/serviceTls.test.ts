import { expect } from 'chai'
import {
  validateSecureTls,
  buildServiceEndpoints,
  buildCaddyServers,
  tlsNameFor
} from '../../../components/c2d/serviceTls.js'

describe('service TLS helpers', () => {
  describe('validateSecureTls', () => {
    it('undefined is valid (feature not requested)', () => {
      expect(validateSecureTls(undefined, [8188])).to.equal(null)
    })
    it('an empty list is valid (turns TLS off on restart)', () => {
      expect(validateSecureTls([], [8188])).to.equal(null)
    })
    it('accepts exposed ports', () => {
      expect(validateSecureTls([8188, 8189], [8188, 8189])).to.equal(null)
    })
    it('rejects a non-array', () => {
      expect(validateSecureTls('x', [8188])).to.be.a('string')
      expect(validateSecureTls({ port: 8188 }, [8188])).to.be.a('string')
    })
    it('rejects a port that is not exposed and names it', () => {
      expect(validateSecureTls([9999], [8188])).to.contain('9999')
    })
    it('rejects entries that are not port numbers', () => {
      expect(validateSecureTls(['8188'], [8188])).to.be.a('string')
      expect(validateSecureTls([{ port: 8188 }], [8188])).to.be.a('string')
      expect(validateSecureTls([null], [8188])).to.be.a('string')
      expect(validateSecureTls([undefined], [8188])).to.be.a('string')
    })
    it('rejects a duplicate port', () => {
      expect(validateSecureTls([8188, 8188], [8188])).to.be.a('string')
    })
    it('returns an error instead of throwing when exposedPorts is not an integer array', () => {
      expect(validateSecureTls([8188], 8188 as any)).to.be.a('string')
      expect(validateSecureTls([8188], ['8188'] as any)).to.be.a('string')
    })
  })

  describe('buildServiceEndpoints', () => {
    it('brackets an IPv6 literal in both http and https URLs', () => {
      const eps = buildServiceEndpoints(
        [8188, 8189],
        [31042, 31043],
        '2a01:4f8::1',
        [8188]
      )
      expect(eps.map((e) => e.url)).to.deep.equal([
        'https://[2a01:4f8::1]:31042',
        'http://[2a01:4f8::1]:31043'
      ])
    })

    it('marks secure ports https and the rest http', () => {
      expect(
        buildServiceEndpoints([8188, 8189], [31042, 31043], '157.66.255.31', [8188])
      ).to.deep.equal([
        {
          containerPort: 8188,
          hostPort: 31042,
          url: 'https://157.66.255.31:31042',
          tls: true
        },
        {
          containerPort: 8189,
          hostPort: 31043,
          url: 'http://157.66.255.31:31043',
          tls: false
        }
      ])
    })
  })

  describe('buildCaddyServers', () => {
    const HOST = '157.66.255.31'
    const endpoints = buildServiceEndpoints(
      [8188, 8189],
      [31042, 31043],
      HOST,
      [8188, 8189]
    )
    const svc = (secureTls: number[], upstreamIp = '172.20.0.2') => ({
      serviceId: 'abc',
      upstreamIp,
      secureTls,
      endpoints
    })
    const server = (hostPort: number, dial: string) => ({
      listen: [`:${hostPort}`],
      tls_connection_policies: [{ default_sni: HOST }],
      routes: [
        {
          match: [{ host: [HOST] }],
          handle: [
            {
              handler: 'reverse_proxy',
              upstreams: [{ dial }],
              flush_interval: -1,
              stream_close_delay: '24h'
            }
          ]
        }
      ]
    })

    it('one host-matched proxy server per secure port', () => {
      expect(buildCaddyServers(HOST, [svc([8188, 8189])])).to.deep.equal({
        ocean_abc_8188: server(31042, '172.20.0.2:8188'),
        ocean_abc_8189: server(31043, '172.20.0.2:8189')
      })
    })

    it('brackets an IPv6 upstream', () => {
      expect(buildCaddyServers(HOST, [svc([8188], 'fd00::2')])).to.deep.equal({
        ocean_abc_8188: server(31042, '[fd00::2]:8188')
      })
    })

    it('skips a port without an endpoint, and no services → no servers', () => {
      expect(buildCaddyServers(HOST, [svc([9999])])).to.deep.equal({})
      expect(buildCaddyServers(HOST, [])).to.deep.equal({})
    })
  })

  describe('tlsNameFor', () => {
    it('keeps a public IP and a domain', () => {
      expect(tlsNameFor('157.66.255.31')).to.equal('157.66.255.31')
      expect(tlsNameFor('cp1.oncompute.ai')).to.equal('cp1.oncompute.ai')
    })
    for (const bad of [
      'localhost',
      'node1',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.1.1',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '203.0.113.9',
      'node.localhost',
      '',
      undefined
    ]) {
      it(`returns null for ${JSON.stringify(bad)}`, () => {
        expect(tlsNameFor(bad)).to.equal(null)
      })
    }
    it('does not treat 172.32.x or 100.128.x as private', () => {
      expect(tlsNameFor('172.32.0.1')).to.equal('172.32.0.1')
      expect(tlsNameFor('100.128.0.1')).to.equal('100.128.0.1')
    })
  })
})
