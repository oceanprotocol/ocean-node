import {
  Storage,
  UrlStorage,
  ArweaveStorage,
  IpfsStorage
} from '../../src/components/storage'

import { expect } from 'chai'

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
  before(() => {
    storage = Storage.getStorageClass(file)
  })

  it('Storage instance', () => {
    expect(storage).to.be.instanceOf(UrlStorage)
  })
  it('URL validation passes', () => {
    expect(storage.validate()).to.be.equal([true, ''])
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
    storage = Storage.getStorageClass(file)
    expect(storage.validate()).to.be.equal([false, 'URL or method are missing!'])
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
    storage = Storage.getStorageClass(file)
    expect(storage.validate()).to.be.equal([false, 'URL or method are missing!'])
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
    storage = Storage.getStorageClass(file)
    expect(storage.validate()).to.be.equal([false, 'Invalid method for URL'])
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
    storage = Storage.getStorageClass(file)
    expect(storage.validate()).to.be.equal([false, 'URL looks like a file path'])
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
    expect(storage.getDownloadUrl()).to.be.equalIgnoreCase('http://someUrl.com/file.json')
  })
})

describe('IPFS Storage tests', () => {
  let file: any = {
    type: 'ipfs',
    hash: 'Qxchjkflsejdfklgjhfkgjkdjoiderj'
  }
  let storage: Storage

  before(() => {
    storage = Storage.getStorageClass(file)
  })

  it('Storage instance', () => {
    expect(storage).to.be.instanceOf(IpfsStorage)
  })
  it('IPFS validation passes', () => {
    expect(storage.validate()).to.be.equal([true, ''])
  })
  it('IPFS validation fails', () => {
    file = {
      type: 'ipfs'
    }
    storage = Storage.getStorageClass(file)
    expect(storage.validate()).to.be.equal([false, 'Missing CID'])
  })
})

describe('Arweave Storage tests', () => {
  let file: any = {
    type: 'arweave',
    transactionId: '0x2563ed54abc0001bcaef'
  }
  let storage: Storage
  before(() => {
    storage = Storage.getStorageClass(file)
  })

  it('Storage instance', () => {
    expect(storage).to.be.instanceOf(ArweaveStorage)
  })
  it('Arweave validation passes', () => {
    expect(storage.validate()).to.be.equal([true, ''])
  })
  it('Arweave validation fails', () => {
    file = {
      type: 'arweave'
    }
    storage = Storage.getStorageClass(file)
    expect(storage.validate()).to.be.equal([false, 'Missing transaction ID'])
  })
})
