export interface HeadersObject {
  [key: string]: string
}

export interface UrlFileObject {
  type: string
  url: string
  method: string
  headers?: [HeadersObject]
}
