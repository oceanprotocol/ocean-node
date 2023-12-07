import express from 'express'
import {streamToString} from "../../utils/util.js";
import {Readable} from "stream";
import {handleGetDdoCommand} from "../core/ddoHandler.js";
import {PROTOCOL_COMMANDS} from "../../utils/constants.js";

export const aquariusRoutes = express.Router()

aquariusRoutes.get('/assets/ddo/:did', async (req, res) => {
    try {
        const did = req.params.did;
        const node = req.oceanNode.getP2PNode()
        const result = await handleGetDdoCommand(node, { id: did, command: PROTOCOL_COMMANDS.GET_DDO })
        if (result.stream) {
            res.json(await streamToString(result.stream as Readable))
        } else {
            res.status(result.status.httpStatus).send(result.status.error)
        }
    } catch (error) {
        res.status(500).send('Internal Server Error')
    }
})
