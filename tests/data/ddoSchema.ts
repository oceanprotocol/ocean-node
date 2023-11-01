import {TypesenseCollectionCreateSchema} from "../../src/@types";

export const ddoSchema: TypesenseCollectionCreateSchema = {
    name: "ddo",
    enable_nested_fields: true,
    fields: [
        {name: "@context", type: "string[]"},
        {name: "chainId", type: "int64"},
        {name: "version", type: "string"},
        {name: "nftAddress", type: "string"},
        {name: "nft.address", type: "string"},
        {name: "nft.name", type: "string"},
        {name: "nft.symbol", type: "string"},
        {name: "nft.tokenURI", type: "string"},
        {name: "nft.owner", type: "string"},
        {name: "nft.state", type: "int64"},
        {name: "nft.created", type: "string"},
    ]
};