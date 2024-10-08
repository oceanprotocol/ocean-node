export interface IDdoStateQuery {
  buildQuery(did?: string, nft?: string, txId?: string): Record<string, any>
}
