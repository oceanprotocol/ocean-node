import {TypesenseCollectionCreateSchema} from "../../@types";

export type Schema = TypesenseCollectionCreateSchema
export type Schemes = {
    ddoSchemes: Schema[];
    nonceSchema: Schema;
    indexerSchema: Schema;
}
export const schemes: Schemes = {
    ddoSchemes: [
        {
            name: 'ddo_v0.1',
            enable_nested_fields: true,
            fields: [
                { name: ".*", type: "auto" },
            ],
        }
    ],
    nonceSchema: {
        name: 'nonce',
        enable_nested_fields: true,
        fields: [
            {name: 'nonce', type: 'int64'},
        ]
    },
    indexerSchema: {
        name: 'indexer',
        enable_nested_fields: true,
        fields: [
            { name: ".*", type: "auto" },
        ]
    },
};