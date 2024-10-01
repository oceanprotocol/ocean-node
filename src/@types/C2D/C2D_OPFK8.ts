/* The following are specific to OPF_k8 compute engine */
export interface OPFK8ComputeStageInput {
  index: number
  id?: string
  remote?: any
  url?: string[]
}
export interface OPFK8ComputeStageAlgorithm {
  id?: string
  url?: string
  remote?: any
  rawcode?: string
  container?: {
    /**
     * The command to execute, or script to run inside the Docker image.
     * @type {string}
     */
    entrypoint: string

    /**
     * Name of the Docker image.
     * @type {string}
     */
    image: string

    /**
     * Tag of the Docker image.
     * @type {string}
     */
    tag: string
  }
}

export interface OPFK8ComputeOutput {
  // this is a copy of ComputeOutput, but they could diverge in the future
  publishAlgorithmLog?: boolean
  publishOutput?: boolean
  providerAddress?: string
  providerUri?: string
  metadataUri?: string
  nodeUri?: string
  owner?: string
  secretStoreUri?: string
  whitelist?: string[]
}
export interface OPFK8ComputeStage {
  index: number
  input: OPFK8ComputeStageInput[]
  algorithm: OPFK8ComputeStageAlgorithm
  compute?: {}
  output: OPFK8ComputeOutput
}

export interface OPFK8ComputeWorkflow {
  stages: OPFK8ComputeStage[]
}
export interface OPFK8ComputeStart {
  workflow: OPFK8ComputeWorkflow
  owner: string
  agreementId: string
  providerSignature: string
  providerAddress: string
  environment: string
  validUntil: number
  nonce: number
  chainId: number
}

export interface OPFK8ComputeStop {
  jobId: string
  owner: string
  agreementId?: string
  providerSignature: string //  message=owner+jobId
  providerAddress: string
  nonce: number
}

export interface OPFK8ComputeGetStatus {
  agreementId?: string
  jobId?: string
  owner?: string
  providerSignature: string //  message=owner+jobId(if any)
  providerAddress: string
  nonce: number
}

export interface OPFK8ComputeGetResult {
  jobId: string
  owner: string
  index: number
  providerSignature: string //  message=owner+jobId
  providerAddress: string
  nonce: number
}
