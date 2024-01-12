import {
  Storage,
  UrlStorage,
  ArweaveStorage,
  IpfsStorage
} from '../../components/storage/index.js'

import { expect } from 'chai'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  tearDownEnvironment
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'

describe('URL Storage tests', () => {
  let file: any = {
    type: 'url',
    url: 'http://someUrl.com/file.json',
    method: 'get',
    headers: [
      {
        'Content-Type': 'application/json',
        Authorization: 'Bearer auth_token_X'
      }
    ]
  }
  let storage: Storage
  let error: Error
  before(() => {
    storage = Storage.getStorageClass(file)
  })

  it('Storage instance', () => {
    expect(storage).to.be.instanceOf(UrlStorage)
  })
  it('URL validation passes', () => {
    expect(storage.validate()).to.eql([true, ''])
  })
  it('URL validation fails on missing URL', () => {
    file = {
      type: 'url',
      method: 'get',
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
    }
    try {
      Storage.getStorageClass(file)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql(
      'Error validationg the URL file: URL or method are missing'
    )
    file = {
      type: 'url',
      url: 'http://someUrl.com/file.json',
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
    }
    try {
      Storage.getStorageClass(file)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql(
      'Error validationg the URL file: URL or method are missing'
    )
  })
  it('URL validation fails on invalid method', () => {
    file = {
      type: 'url',
      url: 'http://someUrl.com/file.json',
      method: 'put',
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
    }
    try {
      Storage.getStorageClass(file)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql('Error validationg the URL file: Invalid method for URL')
  })

  it('URL validation fails on filename', () => {
    file = {
      type: 'url',
      url: './../dir/file.json',
      method: 'get',
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
    }
    try {
      Storage.getStorageClass(file)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql(
      'Error validationg the URL file: URL looks like a file path'
    )
  })
  it('Gets download URL', () => {
    file = {
      type: 'url',
      url: 'http://someUrl.com/file.json',
      method: 'get',
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
    }
    storage = Storage.getStorageClass(file)
    expect(storage.getDownloadUrl()).to.eql('http://someUrl.com/file.json')
  })

  it('Gets readable stream', async () => {
    file = {
      type: 'url',
      url: 'https://stock-api.oceanprotocol.com/stock/stock.json',
      method: 'get'
    }
    const storage = Storage.getStorageClass(file)
    const stream = await storage.getReadableStream()
    expect(stream).not.to.eql(null)
  })
})

describe('IPFS Storage tests', () => {
  let file: any = {
    type: 'ipfs',
    hash: 'Qxchjkflsejdfklgjhfkgjkdjoiderj'
  }
  let error: Error
  let previousConfiguration: OverrideEnvConfig[]

  before(() => {
    previousConfiguration = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.IPFS_GATEWAY],
      ['https://ipfs.io']
    )
  })

  it('Storage instance', () => {
    expect(Storage.getStorageClass(file)).to.be.instanceOf(IpfsStorage)
  })
  it('IPFS validation passes', () => {
    expect(Storage.getStorageClass(file).validate()).to.eql([true, ''])
  })
  it('IPFS validation fails', () => {
    file = {
      type: 'ipfs'
    }
    try {
      Storage.getStorageClass(file)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql('Error validationg the IPFS file: Missing CID')
  })

  after(() => {
    tearDownEnvironment(previousConfiguration)
  })
})

describe('Arweave Storage tests', () => {
  let file: any = {
    type: 'arweave',
    transactionId: '0x2563ed54abc0001bcaef'
  }

  let error: Error
  let previousConfiguration: OverrideEnvConfig[]

  before(() => {
    previousConfiguration = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY],
      ['https://snaznabndfe3.arweave.net/nnLNdp6nuTb8mJ-qOgbUEx-9SBtBXQc_jejYOWzYEkM']
    )
  })

  it('Storage instance', () => {
    expect(Storage.getStorageClass(file)).to.be.instanceOf(ArweaveStorage)
  })
  it('Arweave validation passes', () => {
    expect(Storage.getStorageClass(file).validate()).to.eql([true, ''])
  })
  it('Arweave validation fails', () => {
    file = {
      type: 'arweave'
    }
    try {
      Storage.getStorageClass(file)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql(
      'Error validationg the Arweave file: Missing transaction ID'
    )
  })

  after(() => {
    tearDownEnvironment(previousConfiguration)
  })
})
