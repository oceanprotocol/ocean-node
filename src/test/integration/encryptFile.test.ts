import { expect, assert } from 'chai'
import { getConfiguration } from '../../utils/config.js'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { streamToString } from '../../utils/util.js'
import { EncryptFileHandler } from '../../components/core/encryptHandler.js'
import { EncryptFileCommand } from '../../@types/commands'

describe('Encrypt File', () => {
  let config: OceanNodeConfig
  let dbconn: Database
  let oceanNode: OceanNode

  before(async () => {
    config = await getConfiguration(true) // Force reload the configuration
    dbconn = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(dbconn)
  })

  it('should encrypt files', async () => {
    const encryptFileTask: EncryptFileCommand = {
      command: PROTOCOL_COMMANDS.ENCRYPT_FILE,
      encryptionType: 'AES',
      files: {
        type: 'url',
        url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
        method: 'GET'
      }
    }
    const response = await new EncryptFileHandler(oceanNode).handle(encryptFileTask)

    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)
  })

  it('should return unknown file type', async () => {
    const encryptFileTask: EncryptFileCommand = {
      command: PROTOCOL_COMMANDS.ENCRYPT_FILE,
      encryptionType: 'AES',
      files: {
        type: 'Unknown',
        url: 'Unknown',
        method: 'Unknown'
      }
    }
    const response = await new EncryptFileHandler(oceanNode).handle(encryptFileTask)

    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 400, 'Failed to get 200 response')
    expect(response.status.error).to.be.equal('Unknown file type')
  })
})
