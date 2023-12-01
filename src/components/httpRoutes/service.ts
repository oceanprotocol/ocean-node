import express from 'express'
import {getNonce} from "../core/nonceHandler.js";

export const serviceRoutes = express.Router()

serviceRoutes.get('/nonce', async (req, res) => {
    try {
        const userAddress: string = String(req.query.userAddress)
        const node = req.oceanNode.getP2PNode()
        const result = await getNonce(node, userAddress)
        console.log(result)
        if (result) {
            res.json(result)
        } else {
            res.status(404).send('No logs found')
        }
    } catch (error) {
        res.status(500).send('Internal Server Error')
    }
})
