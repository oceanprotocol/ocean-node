import {
  Storage,
  UrlStorage,
  ArweaveStorage,
  IpfsStorage
} from '../../components/storage/index.js'
import axios from 'axios'
import { StorageReadable, FileInfoRequest } from '../../@types/fileObject.js'

import { expect, assert } from 'chai'

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

  before(() => {
    process.env.IPFS_GATEWAY = 'https://ipfs.io'
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
})

describe('Arweave Storage tests', () => {
  let file: any = {
    type: 'arweave',
    transactionId: '0x2563ed54abc0001bcaef'
  }

  let error: Error
  let arweaveGateway: string
  before(() => {
    arweaveGateway = process.env.ARWEAVE_GATEWAY
    process.env.ARWEAVE_GATEWAY =
      'https://snaznabndfe3.arweave.net/nnLNdp6nuTb8mJ-qOgbUEx-9SBtBXQc_jejYOWzYEkM'
  })
  after(() => {
    process.env.ARWEAVE_GATEWAY = arweaveGateway
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
})

describe('URL Storage getFileInfo tests', () => {
  let storage: UrlStorage
  beforeEach(() => {
    storage = new UrlStorage({
      type: 'url',
      url: 'https://stock-api.oceanprotocol.com/stock/stock.json',
      method: 'get'
    })
  })

  it('Successfully retrieves file info for a URL', async () => {
    const fileInfoRequest: FileInfoRequest = {
      type: 'url',
      url: 'https://stock-api.oceanprotocol.com/stock/stock.json'
    }
    const fileInfo = await storage.getFileInfo(fileInfoRequest)

    assert(fileInfo.valid, 'File info is valid')
    expect(fileInfo.contentLength).to.equal('1069668')
    expect(fileInfo.contentType).to.equal('application/json; charset=utf-8')
    expect(fileInfo.name).to.equal('stock.json')
    expect(fileInfo.type).to.equal('url')
  })

  it('Throws error when URL is missing in request', async () => {
    const fileInfoRequest: FileInfoRequest = { type: 'url' }
    try {
      await storage.getFileInfo(fileInfoRequest)
    } catch (err) {
      expect(err.message).to.equal('URL is required for type url')
    }
  })
})

describe('Arweave Storage getFileInfo tests', () => {
  let storage: ArweaveStorage

  beforeEach(() => {
    storage = new ArweaveStorage({
      type: 'arweave',
      transactionId: '0x2563ed54abc0001bcaef'
    })
  })

  it('Successfully retrieves file info for an Arweave transaction', async () => {
    const fileInfoRequest: FileInfoRequest = {
      type: 'arweave',
      transactionId: 'gPPDyusRh2ZyFl-sQ2ODK6hAwCRBAOwp0OFKr0n23QE'
    }
    const fileInfo = await storage.getFileInfo(fileInfoRequest)

    assert(fileInfo.valid, 'File info is valid')
    assert(fileInfo.type === 'arweave', 'Type is incorrect')
    assert(
      fileInfo.contentType === 'text/csv; charset=utf-8',
      'Content type is incorrect'
    )
    assert(fileInfo.contentLength === '680782', 'Content length is incorrect')
    // Add additional expectations based on mocked axios response
  })

  it('Throws error when transaction ID is missing in request', async () => {
    const fileInfoRequest: FileInfoRequest = { type: 'arweave' }
    try {
      await storage.getFileInfo(fileInfoRequest)
    } catch (err) {
      expect(err.message).to.equal('Transaction ID is required for type arweave')
    }
  })
})
