import { FileObject } from '../../src/@types/fileObject'
import { Storage } from '../../src/components/storage'
import { ArweaveStorage } from '../../src/components/storage/arweave'
import { IpfsStorage } from '../../src/components/storage/ipfs'
import { UrlStorage } from '../../src/components/storage/url'

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
    expect(storage.validate()).toBe([true, ''])
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
    expect(storage.validate()).toBe([false, 'URL or method are missing!'])
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
    expect(storage.validate()).toBe([false, 'URL or method are missing!'])
  })
  it('URL validation fails on invalid method', () => {
    file = {
      type: 'url',
      method: 'put',
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
    }
    storage = Storage.getStorageClass(file)
    expect(storage.validate()).toBe([false, 'Invalid method for URL'])
  })

  it('URL validation fails on filename', () => {
    file = {
      type: 'url',
      url: 'http://someUrl.com/../dir/.file.json',
      method: 'get',
      headers: [
        {
          'Content-Type': 'application/json',
          Authorization: 'Bearer auth_token_X'
        }
      ]
    }
    storage = Storage.getStorageClass(file)
    expect(storage.validate()).toBe([false, 'URL looks like a file path'])
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
    expect(storage.getDownloadUrl()).toBe('http://someUrl.com/file.json')
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
    expect(storage.validate()).toBe([true, ''])
  })
  it('IPFS validation fails', () => {
    file = {
      type: 'ipfs'
    }
    storage = Storage.getStorageClass(file)
    expect(storage.validate()).toBe([false, 'Missing CID'])
  })
})

describe('Arweave Storage tests', () => {
  let file: FileObject = {
    type: 'arweave',
    hash: '0x2563ed54abc0001bcaef'
  }
  let storage: Storage
  beforeAll(() => {
    storage = Storage.getStorageClass(file)
  })

  it('Storage instance', () => {
    expect(storage).toBeInstanceOf(ArweaveStorage)
  })
  it('Arweave validation passes', () => {
    expect(storage.validate()).toBe([true, ''])
  })
  it('Arweave validation fails', () => {
    file = {
      type: 'arweave'
    }
    storage = Storage.getStorageClass(file)
    expect(storage.validate()).toBe([false, 'Missing transaction ID'])
  })
})
