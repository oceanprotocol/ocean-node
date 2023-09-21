import { OceanP2P } from "../components/P2P/index"
import { OceanProvider } from "../components/Provider/index"
import { OceanIndexer } from "../components/Indexer/index"


export interface OceanNode {
    node:OceanP2P | null,
    indexer: OceanIndexer| null,
    provider: OceanProvider| null
}