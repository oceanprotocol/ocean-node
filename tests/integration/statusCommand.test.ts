import { OceanNode } from '../../src/index.js'
import { expect } from 'chai'
import { getConfig } from '../../src/utils/index.js'

describe('Status command tests', async () => {
  let oceanNode: OceanNode
  const config = await getConfig()
  const url = `http://127.0.0.1:${config.httpPort}`
  before(() => {
    oceanNode = new OceanNode(config)
  })

  it('should Ocean Node start', () => {
    expect(oceanNode.getNode().node).to.not.eql(null)
    expect(oceanNode.getNode().indexer).to.not.eql(null)
    expect(oceanNode.getNode().provider).to.not.eql(null)
  })

  it('Status command response', async () => {
    const payload = {
      command: 'status'
    }

    const response = await fetch(url + '/directCommand', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    expect(response.status).to.eql(200)
    const responseBody = await response.json()
  })
})
