import {
  TypesenseSearchParams,
  TypesenseCollectionCreateSchema,
  TypesenseCollectionSchema,
  TypesenseCollectionUpdateSchema,
  TypesenseConfigOptions,
  TypesenseDocumentSchema,
  TypesenseSearchResponse
} from '../../@types/index.js'
import { TYPESENSE_HITS_CAP } from '../../utils/constants.js'
import { TypesenseApi } from './typesenseApi.js'
import { TypesenseConfig } from './typesenseConfig.js'

export const convertTypesenseConfig = (url: string) => {
  const urlObject = new URL(url)
  const apiKey = urlObject.searchParams.get('apiKey')
  const config: TypesenseConfigOptions = {
    apiKey,
    nodes: [
      {
        host: urlObject.hostname,
        port: urlObject.port,
        protocol: urlObject.protocol.split(':')[0]
      }
    ]
  }
  return config
}

export class TypesenseError extends Error {
  httpStatus?: number

  constructor(message?: string) {
    super(message)
    this.name = new.target.name
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * TypesenseDocuments class implements CRUD methods
 * for interacting with documents of an individual collection
 * In addition, it implements a method for searching in documents
 */
class TypesenseDocuments {
  apiPath: string

  constructor(
    private collectionName: string,
    private api: TypesenseApi
  ) {
    this.apiPath = `/collections/${this.collectionName}/documents`
  }

  // eslint-disable-next-line require-await
  async create(document: TypesenseDocumentSchema) {
    if (!document) throw new Error('No document provided')
    return this.api.post<TypesenseDocumentSchema>(this.apiPath, document)
  }

  // eslint-disable-next-line require-await
  async retrieve(documentId: string) {
    const path = `${this.apiPath}/${documentId}`
    return this.api.get<TypesenseDocumentSchema>(path)
  }

  // eslint-disable-next-line require-await
  async delete(documentId: string) {
    const path = `${this.apiPath}/${documentId}`
    return this.api.delete<TypesenseDocumentSchema>(path)
  }

  // eslint-disable-next-line require-await
  async deleteByChainId(filterCondition: string, batchSize: number = TYPESENSE_HITS_CAP) {
    const batch = Math.min(batchSize, TYPESENSE_HITS_CAP)
    return this.api.delete<TypesenseDocumentSchema>(this.apiPath, {
      filter_by: filterCondition,
      batch_size: batch
    })
  }

  // eslint-disable-next-line require-await
  async update(documentId: string, partialDocument: Partial<TypesenseDocumentSchema>) {
    const path = `${this.apiPath}/${documentId}`
    return this.api.patch<TypesenseDocumentSchema>(path, partialDocument)
  }

  // eslint-disable-next-line require-await
  async search(
    searchParameters: TypesenseSearchParams
  ): Promise<TypesenseSearchResponse> {
    const additionalQueryParams: { [key: string]: any } = {}
    for (const key in searchParameters) {
      if (Array.isArray(searchParameters[key])) {
        additionalQueryParams[key] = searchParameters[key].join(',')
      }
    }
    const queryParams = Object.assign({}, searchParameters, additionalQueryParams)
    const path = `${this.apiPath}/search`
    return this.api.get<TypesenseSearchResponse>(
      path,
      queryParams
    ) as Promise<TypesenseSearchResponse>
  }
}

/**
 * TypesenseCollection class implements CRUD methods for interacting with an individual collection
 * It initiates class that provides access to methods of documents
 */
class TypesenseCollection {
  apiPath: string
  private readonly _documents: TypesenseDocuments

  constructor(
    private name: string,
    private api: TypesenseApi
  ) {
    this.apiPath = `/collections/${this.name}`
    this._documents = new TypesenseDocuments(this.name, this.api)
  }

  // eslint-disable-next-line require-await
  async retrieve(): Promise<TypesenseCollectionSchema> {
    return this.api.get<TypesenseCollectionSchema>(this.apiPath)
  }

  // eslint-disable-next-line require-await
  async update(
    schema: TypesenseCollectionUpdateSchema
  ): Promise<TypesenseCollectionSchema> {
    return this.api.patch<TypesenseCollectionSchema>(this.apiPath, schema)
  }

  // eslint-disable-next-line require-await
  async delete(): Promise<TypesenseCollectionSchema> {
    return this.api.delete<TypesenseCollectionSchema>(this.apiPath)
  }

  documents(): TypesenseDocuments {
    return this._documents
  }
}

/**
 * TypesenseCollections class implements the basic methods of collections
 */
export class TypesenseCollections {
  apiPath: string = '/collections'

  constructor(private api: TypesenseApi) {}

  // eslint-disable-next-line require-await
  async create(schema: TypesenseCollectionCreateSchema) {
    return this.api.post<TypesenseCollectionSchema>(this.apiPath, schema)
  }

  // eslint-disable-next-line require-await
  async retrieve() {
    return this.api.get<TypesenseCollectionSchema[]>(this.apiPath)
  }
}

/**
 * Typesense class is used to create a base instance to work with Typesense
 * It initiates classes that provides access to methods of collections
 * or an individual collection
 */
export class Typesense {
  config: TypesenseConfig
  api: TypesenseApi
  collectionsRecords: Record<string, TypesenseCollection> = {}
  private readonly _collections: TypesenseCollections

  constructor(options: TypesenseConfigOptions) {
    this.config = new TypesenseConfig(options)
    this.api = new TypesenseApi(this.config)
    this._collections = new TypesenseCollections(this.api)
  }

  collections(): TypesenseCollections
  collections(collectionName: string): TypesenseCollection
  collections(collectionName?: string): TypesenseCollection | TypesenseCollections {
    if (!collectionName) {
      return this._collections
    } else {
      if (this.collectionsRecords[collectionName] === undefined) {
        this.collectionsRecords[collectionName] = new TypesenseCollection(
          collectionName,
          this.api
        )
      }
      return this.collectionsRecords[collectionName]
    }
  }
}
