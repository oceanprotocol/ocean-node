import { FileObject } from '../../src/@types/fileObject'
import {
  Storage,
  UrlStorage,
  ArweaveStorage,
  IpfsStorage
} from '../../src/components/storage'

describe('URL Storage tests', () => {
  let file: FileObject = {
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
  beforeAll(() => {
    storage = Storage.getStorageClass(file)
  })

  it('Storage instance', () => {
    expect(storage).toBeInstanceOf(UrlStorage)
  })
  it('URL validation passes', () => {
    expect(storage.validate()).toStrictEqual([true, ''])
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
    expect(storage.validate()).toStrictEqual([false, 'URL or method are missing!'])
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
    expect(storage.validate()).toStrictEqual([false, 'URL or method are missing!'])
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
    expect(storage.validate()).toStrictEqual([false, 'Invalid method for URL'])
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
    expect(storage.validate()).toStrictEqual([false, 'URL looks like a file path'])
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
    expect(storage.getDownloadUrl()).toStrictEqual('http://someUrl.com/file.json')
  })
})

describe('IPFS Storage tests', () => {
  let file: FileObject = {
    type: 'ipfs',
    hash: 'Qxchjkflsejdfklgjhfkgjkdjoiderj'
  }
  let storage: Storage
  beforeAll(() => {
    storage = Storage.getStorageClass(file)
  })

  it('Storage instance', () => {
    expect(storage).toBeInstanceOf(IpfsStorage)
  })
  it('IPFS validation passes', () => {
    expect(storage.validate()).toStrictEqual([true, ''])
  })
  it('IPFS validation fails', () => {
    file = {
      type: 'ipfs'
    }
    storage = Storage.getStorageClass(file)
    expect(storage.validate()).toStrictEqual([false, 'Missing CID'])
  })
})

describe('Arweave Storage tests', () => {
  let file: FileObject = {
    type: 'arweave',
    transactionId: '0x2563ed54abc0001bcaef'
  }
  let storage: Storage
  beforeAll(() => {
    storage = Storage.getStorageClass(file)
  })

  it('Storage instance', () => {
    expect(storage).toBeInstanceOf(ArweaveStorage)
  })
  it('Arweave validation passes', () => {
    expect(storage.validate()).toStrictEqual([true, ''])
  })
  it('Arweave validation fails', () => {
    file = {
      type: 'arweave'
    }
    storage = Storage.getStorageClass(file)
    expect(storage.validate()).toStrictEqual([false, 'Missing transaction ID'])
  })
})
