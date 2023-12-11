import express from 'express'
import { getNonce } from '../core/nonceHandler.js'
import { streamToString } from '../../utils/util.js'
import { Readable } from 'stream'
import { encrypt } from '../../utils/crypt.js'
import { calculateFee } from '../core/feesHandler.js'
import { DDO } from '../../@types/DDO/DDO'

export const providerRoutes = express.Router()

providerRoutes.post('/encrypt', async (req, res) => {
  try {
    const data = Uint8Array.from(req.body)
    const encryptedData = await encrypt(data, 'ECIES')
    if (encryptedData) {
      res.send(encryptedData)
    } else {
      res.status(400).send()
    }
  } catch (error) {
    res.status(500).send('Internal Server Error')
  }
})

providerRoutes.get('/download', async (req, res) => {
  try {
    res.status(400).send()
  } catch (error) {
    res.status(500).send('Internal Server Error')
  }
})

providerRoutes.get('/initialize', async (req, res) => {
  try {
    const did = String(req.query.documentId)
    const consumerAddress = String(req.query.consumerAddress)
    const serviceId = String(req.query.serviceId)

    const node = req.oceanNode.getP2PNode()
    const ddo = (await node.getDatabase().ddo.retrieve(did)) as DDO

    if (!ddo) {
      res.status(400).send('Cannot resolve DID')
      return
    }

    const service = ddo.services.find((service) => service.id === serviceId)
    if (!service) {
      res.status(400).send('Invalid serviceId')
      return
    }
    if (service.type === 'compute') {
      res
        .status(400)
        .send('Use the initializeCompute endpoint to initialize compute jobs')
      return
    }

    const datatoken = service.datatokenAddress
    const nonceResult = await getNonce(node, consumerAddress)
    const nonce = nonceResult.stream
      ? await streamToString(nonceResult.stream as Readable)
      : nonceResult.stream
    const providerFee = await calculateFee(ddo, serviceId)

    const response = {
      datatoken,
      nonce,
      providerFee
    }

    res.json(response)
  } catch (error) {
    res.status(500).send('Internal Server Error')
  }
})

providerRoutes.get('/nonce', async (req, res) => {
  try {
    const userAddress = String(req.query.userAddress)
    const node = req.oceanNode.getP2PNode()
    const result = await getNonce(node, userAddress)
    if (result.stream) {
      res.json({ nonce: await streamToString(result.stream as Readable) })
    } else {
      res.status(400).send()
    }
  } catch (error) {
    res.status(500).send('Internal Server Error')
  }
})
