import {Logger} from "winston";

export interface TypesenseNode {
    host: string;
    port: number;
    protocol: string;
}

export interface TypesenseConfigOptions {
    apiKey: string;
    nodes: TypesenseNode[];
    numRetries?: number;
    retryIntervalSeconds?: number;
    connectionTimeoutSeconds?: number;
    logLevel?: string;
    logger?: Logger;
}

export type TypesenseFieldType =
    | "string"
    | "int32"
    | "int64"
    | "float"
    | "bool"
    | "geopoint"
    | "geopoint[]"
    | "string[]"
    | "int32[]"
    | "int64[]"
    | "float[]"
    | "bool[]"
    | "object"
    | "object[]"
    | "auto"
    | "string*";

export interface TypesenseCollectionFieldSchema {
    name: string;
    type: TypesenseFieldType;
    optional?: boolean;
    facet?: boolean;
    index?: boolean;
    sort?: boolean;
    locale?: string;
    infix?: boolean;
    num_dim?: number;
    [t: string]: unknown;
}

export interface TypesenseCollectionCreateSchema {
    name: string;
    enable_nested_fields?: boolean;
    fields?: TypesenseCollectionFieldSchema[];
}

export interface TypesenseCollectionSchema extends TypesenseCollectionCreateSchema {
    created_at: number;
    num_documents: number;
    num_memory_shards: number;
}