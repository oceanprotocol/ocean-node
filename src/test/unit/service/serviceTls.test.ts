import { expect } from 'chai'
import {
  validateSecureTls,
  buildServiceEndpoints,
  tlsNameFor
} from '../../../components/c2d/serviceTls.js'
import { buildCaddyServers } from '../../../components/c2d/caddyProxy.js'

describe('service TLS helpers', () => {
  it('validateSecureTls: accepts exposed ports, rejects the rest', () => {
    for (const ok of [undefined, [], [8188, 8189]])
      expect(validateSecureTls(ok, [8188, 8189])).to.equal(null)
    for (const bad of ['x', ['8188'], [8188, 8188]])
      expect(validateSecureTls(bad, [8188])).to.be.a('string')
    expect(validateSecureTls([9999], [8188])).to.contain('9999')
  })

  it('buildServiceEndpoints: https for secure ports, IPv6 in brackets', () => {
    expect(
      buildServiceEndpoints([8188, 8189], [31042, 31043], 'fd00::1', [8188])
    ).to.deep.equal([
      { containerPort: 8188, hostPort: 31042, url: 'https://[fd00::1]:31042', tls: true },
      { containerPort: 8189, hostPort: 31043, url: 'http://[fd00::1]:31043', tls: false }
    ])
  })

  it('buildCaddyServers: one host-matched proxy server per TLS endpoint', () => {
    const HOST = '157.66.255.31'
    const endpoints = buildServiceEndpoints([8188, 8189], [31042, 31043], HOST, [8188])
    expect(
      buildCaddyServers(HOST, [{ serviceId: 'abc', upstreamIp: '172.20.0.2', endpoints }])
    ).to.deep.equal({
      ocean_abc_8188: {
        listen: [':31042'],
        tls_connection_policies: [{ default_sni: HOST }],
        routes: [
          {
            match: [{ host: [HOST] }],
            handle: [
              {
                handler: 'reverse_proxy',
                upstreams: [{ dial: '172.20.0.2:8188' }],
                flush_interval: -1,
                stream_close_delay: '86400s'
              }
            ]
          }
        ]
      }
    })
  })

  it('tlsNameFor: a public IP or a domain, else null', () => {
    expect(tlsNameFor('157.66.255.31')).to.equal('157.66.255.31')
    expect(tlsNameFor('cp1.oncompute.ai')).to.equal('cp1.oncompute.ai')
    for (const bad of [
      'localhost',
      'node1',
      '10.0.0.1',
      '192.168.1.1',
      'fd00::1',
      'node.local',
      'host.docker.internal',
      undefined
    ])
      expect(tlsNameFor(bad)).to.equal(null)
  })
})
