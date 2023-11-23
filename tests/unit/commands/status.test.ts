// import { OceanNodeConfig } from '../../../src/@types/OceanNode.js'
// import { OceanNode } from '../../../src/index.js'

// import { expect } from 'chai'

// describe('Status command tests', () => {
//   // let oceanNode: OceanNode
//   // // let config: OceanNodeConfig
//   const url = `http://127.0.0.1:8000`
//   // before(() => {
//   //   oceanNode = new OceanNode(null)
//   //   // config = {

//   //   // }
//   // })

//   // it('should Ocean Node start', () => {
//   //   expect(oceanNode.getNode().node).to.not.eql(null)
//   //   expect(oceanNode.getNode().indexer).to.not.eql(null)
//   //   expect(oceanNode.getNode().provider).to.not.eql(null)
//   // })

//   it('Status command response', async () => {
//     const payload = {
//       command: 'status'
//     }

//     const response = await fetch(url + '/directCommand', {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json'
//       },
//       body: JSON.stringify(payload)
//     })

//     expect(response.status).to.eql(200)
//     const responseBody = await response.json()
//   })
// })
