import { expect } from 'chai'
import { describeP2PError } from '../../../components/P2P/errors.js'

/**
 * Every P2P failure used to be logged as `err.message` alone, and a libp2p message is the
 * least useful part of a libp2p error.
 *
 * The names are specific and stable — `NoValidAddressesError` means nothing dialable was
 * known, `DialDeniedError` means the gater refused, `QueryAbortedError` means a DHT walk hit
 * its deadline — and the messages frequently carry none of that: several of them say nothing
 * beyond the name, and two different causes routinely produce identical prose. Reading a log
 * and being unable to tell "this peer has no addresses" from "we refused to dial it" is a
 * real cost when the whole subject is why a peer cannot be reached.
 *
 * Nothing here changes behaviour, which is exactly why it needs a test: a formatting
 * regression in a log line is invisible until the log is the only thing left to read.
 */
describe('P2P error descriptions', () => {
  it('leads with the name, which is the part that identifies the failure', () => {
    const err = new Error('')
    err.name = 'NoValidAddressesError'
    expect(describeP2PError(err)).to.equal('NoValidAddressesError: ')
  })

  it('includes a code, for the failures that identify themselves by one', () => {
    // A Node-level failure carries the generic name `Error` and puts everything in `code`,
    // so dropping it would leave a DNS failure and a refused connection indistinguishable.
    const err = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:9000'), {
      code: 'ECONNREFUSED'
    })
    const described = describeP2PError(err)
    expect(described).to.contain('code=ECONNREFUSED')
    expect(described).to.contain('connect ECONNREFUSED 1.2.3.4:9000')
  })

  it('carries the peer and the address count when the caller knows them', () => {
    const err = new Error('all addresses were denied')
    err.name = 'DialDeniedError'
    const described = describeP2PError(err, { peerId: '16Uiu2HAmExample', addresses: 3 })
    expect(described).to.contain('DialDeniedError')
    expect(described).to.contain('peer=16Uiu2HAmExample')
    expect(described).to.contain('addrs=3')
  })

  it('reports zero addresses rather than omitting the count', () => {
    // Zero versus several is the difference between a resolution failure and a
    // reachability failure, and neither the name nor the message distinguishes them — so a
    // falsy check here would hide the more informative of the two cases.
    const err = new Error('no addresses')
    err.name = 'NoValidAddressesError'
    expect(describeP2PError(err, { addresses: 0 })).to.contain('addrs=0')
  })

  it('keeps the message last and always present', () => {
    const err = new Error('the specific detail')
    err.name = 'TimeoutError'
    expect(describeP2PError(err)).to.equal('TimeoutError: the specific detail')
  })

  it('handles what was thrown not being an Error at all', () => {
    expect(describeP2PError('a bare string')).to.equal('a bare string')
    expect(describeP2PError(null)).to.equal('null')
    expect(describeP2PError(undefined)).to.equal('undefined')
  })

  it('omits a name that carries no information', () => {
    // A plain `new Error()` is named `Error`, which is true and useless — but it is also
    // not worth a special case, so what is asserted is that an *empty* name is dropped
    // rather than printed as an empty prefix.
    const err = new Error('something went wrong')
    err.name = ''
    expect(describeP2PError(err)).to.equal('something went wrong')
  })
})
