import express from 'express'
import {getNonce} from "../core/nonceHandler.js";
import {streamToString} from "../../utils/util.js";
import {Readable} from "stream";
import {encrypt} from "../../utils/crypt.js";

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
        res.status(400).send()
    } catch (error) {
        res.status(500).send('Internal Server Error')
    }
})

providerRoutes.get('/nonce', async (req, res) => {
    try {
        const userAddress: string = String(req.query.userAddress)
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
