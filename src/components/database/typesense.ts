import {
    TypesenseCollectionCreateSchema,
    TypesenseCollectionSchema,
    TypesenseConfigOptions,
    TypesenseNode
} from "../../@types";
import winston, {Logger} from "winston";
import axios, {AxiosRequestConfig} from "axios";
import {setTimeout} from "timers/promises";

class TypesenseConfig {
    apiKey: string;
    nodes: TypesenseNode[];
    numRetries: number;
    retryIntervalSeconds: number;
    connectionTimeoutSeconds: number;
    logLevel: string;
    logger: Logger;

    constructor(options: TypesenseConfigOptions) {
        this.apiKey = options.apiKey;
        this.nodes = options.nodes || [];
        this.numRetries = options.numRetries || 3;
        this.connectionTimeoutSeconds = options.connectionTimeoutSeconds || 5;
        this.retryIntervalSeconds = options.retryIntervalSeconds || 0.1;
        this.logLevel = options.logLevel || 'debug';
        this.logger = options.logger || winston.createLogger({
            level: this.logLevel,
            format: winston.format.prettyPrint(),
            transports: [
                new winston.transports.Console(),
            ]
        });
    }
}

class TypesenseApi {
    currentNodeIndex = -1;

    constructor(private config: TypesenseConfig) {
    }

    async get<T>(
        endpoint: string,
        queryParameters: any = {},
    ): Promise<T> {
        return this.request<T>("get", endpoint, {
            queryParameters
        });
    }

    async post<T>(
        endpoint: string,
        bodyParameters: any = {},
        queryParameters: any = {}
    ): Promise<T> {
        return this.request<T>("post", endpoint, {
            queryParameters,
            bodyParameters,
        });
    }

    async delete<T>(endpoint: string, queryParameters: any = {}): Promise<T> {
        return this.request<T>("delete", endpoint, { queryParameters });
    }

    getNextNode(): TypesenseNode {
        let candidateNode: TypesenseNode = this.config.nodes[0];
        if (this.config.nodes.length == 1) {
            return candidateNode;
        }
        for (let i = 0; i <= this.config.nodes.length; i++) {
            this.currentNodeIndex = (this.currentNodeIndex + 1) % this.config.nodes.length;
            candidateNode = this.config.nodes[this.currentNodeIndex];
            this.config.logger.debug(`Updated current node to Node ${candidateNode}`);
            return candidateNode;
        }
    }

    async request<T>(
        requestType: string,
        endpoint: string,
        {
            queryParameters = null,
            bodyParameters = null,
            skipConnectionTimeout = false,
        }: {
            queryParameters?: any;
            bodyParameters?: any;
            skipConnectionTimeout?: boolean;
        }
    ): Promise<T> {
        this.config.logger.debug(`Request ${endpoint}`);
        let lastException;
        for (let numTries = 1; numTries <= this.config.numRetries + 1; numTries++) {
            const node = this.getNextNode();
            this.config.logger.debug(`Request ${endpoint}: Attempting ${requestType.toUpperCase()} request Try #${numTries} to Node ${node.host}`);

            try {
                const url = `${node.protocol}://${node.host}:${node.port}${endpoint}`;
                const requestOptions: AxiosRequestConfig = {
                    method: requestType,
                    url,
                    headers: {"X-TYPESENSE-API-KEY": this.config.apiKey},
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    validateStatus: (status) => {
                        return status > 0;
                    },
                    transformResponse: [
                        (data, headers) => {
                            let transformedData = data;
                            if (
                                headers !== undefined &&
                                typeof data === "string" &&
                                headers["content-type"] &&
                                headers["content-type"].startsWith("application/json")
                            ) {
                                transformedData = JSON.parse(data);
                            }
                            return transformedData;
                        },
                    ],
                };

                if (skipConnectionTimeout !== true) {
                    requestOptions.timeout = this.config.connectionTimeoutSeconds * 1000;
                }

                if (queryParameters !== null) {
                    requestOptions.params = queryParameters;
                }

                if (bodyParameters !== null) {
                    requestOptions.data = bodyParameters;
                }

                const response = await axios(requestOptions);
                this.config.logger.debug(`Request ${endpoint}: Request to Node ${node.host} was made. Response Code was ${response.status}.`);

                if (response.status >= 200 && response.status < 300) {
                    return Promise.resolve(response.data);
                } else if (response.status < 500) {
                    return Promise.reject(new Error(response.data?.message));
                } else {
                    throw new Error(response.data?.message);
                }
            } catch (error: any) {
                lastException = error;
                this.config.logger.debug(
                    `Request ${endpoint}: Request to Node ${node.host} failed due to "${error.code} ${error.message}"`
                );
                this.config.logger.debug(
                    `Request ${endpoint}: Sleeping for ${this.config.retryIntervalSeconds}s and then retrying request...`
                );
                await setTimeout(this.config.retryIntervalSeconds);
            }
        }
        this.config.logger.debug(`Request: No retries left. Raising last error`);
        return Promise.reject(lastException);
    }
}

class TypesenseCollection {
    apiPath: string;

    constructor(private name: string, private api: TypesenseApi) {
        this.apiPath = `/collections/${this.name}`
    }

    async delete(): Promise<TypesenseCollectionSchema> {
        return this.api.delete<TypesenseCollectionSchema>(this.apiPath);
    }
}

export class TypesenseCollections {
    apiPath: string = "/collections";

    constructor(private api: TypesenseApi) {
    }

    async create(schema: TypesenseCollectionCreateSchema) {
        return this.api.post<TypesenseCollectionSchema>(this.apiPath, schema);
    }

    async retrieve() {
        return this.api.get<TypesenseCollectionSchema[]>(this.apiPath);
    }
}

export default class Typesense {
    config: TypesenseConfig
    api: TypesenseApi
    collectionsRecords: Record<string, TypesenseCollection> = {};
    private readonly _collections: TypesenseCollections;

    constructor(options: TypesenseConfigOptions) {
        this.config = new TypesenseConfig(options);
        this.api = new TypesenseApi(this.config);
        this._collections = new TypesenseCollections(this.api);
    }

    collections(): TypesenseCollections;
    collections(collectionName: string): TypesenseCollection;
    collections(collectionName?: string): TypesenseCollection | TypesenseCollections {
        if (collectionName === undefined) {
            return this._collections;
        } else {
            if (this.collectionsRecords[collectionName] === undefined) {
                this.collectionsRecords[collectionName] = new TypesenseCollection(collectionName, this.api);
            }
            return this.collectionsRecords[collectionName];
        }
    }

}
