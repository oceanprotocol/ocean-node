import { HeadersObject } from './headersObject'

export interface FileObject {
  type: string
  url?: string
  method?: string
  headers?: [HeadersObject]
  hash?: string
  transactionId?: string
}
