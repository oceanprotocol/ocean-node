import { OceanP2P } from "../components/P2P/index"
import { OceanProvider } from "../components/Provider/index"
import { OceanIndexer } from "../components/Indexer/index"
import {Stream} from "stream"

export interface OceanNode {
    node:OceanP2P | null,
    indexer: OceanIndexer| null,
    provider: OceanProvider| null
}


export interface P2PCommandResponse {
    status: any,
    stream: Stream | null
}