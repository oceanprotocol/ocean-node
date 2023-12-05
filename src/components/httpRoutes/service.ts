import express from 'express'
import {getNonce} from "../core/nonceHandler.js";
import {streamToString} from "../../utils/util.js";
import {Readable} from "stream";

export const serviceRoutes = express.Router()

serviceRoutes.get('/decrypt', async (req, res) => {
    try {
        res.status(400).send()
    } catch (error) {
        res.status(500).send('Internal Server Error')
    }
})

serviceRoutes.get('/encrypt', async (req, res) => {
    try {
        res.status(400).send()
    } catch (error) {
        res.status(500).send('Internal Server Error')
    }
})

serviceRoutes.get('/download', async (req, res) => {
    try {
        res.status(400).send()
    } catch (error) {
        res.status(500).send('Internal Server Error')
    }
})

serviceRoutes.get('/initialize', async (req, res) => {
    try {
        res.status(400).send()
    } catch (error) {
        res.status(500).send('Internal Server Error')
    }
})

serviceRoutes.get('/nonce', async (req, res) => {
    try {
        const userAddress: string = String(req.query.userAddress)
        const node = req.oceanNode.getP2PNode()
        const result = await getNonce(node, userAddress)
        if (result) {
            res.json({ nonce: await streamToString(result.stream as Readable) })
        } else {
            res.status(400).send()
        }
    } catch (error) {
        res.status(500).send('Internal Server Error')
    }
})
