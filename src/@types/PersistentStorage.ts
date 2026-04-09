import type { AccessList } from './AccessList'
import type { BaseFileObject } from './fileObject.js'
export type PersistentStorageType = 'localfs' | 's3'

export interface PersistentStorageLocalFSOptions {
  folder: string
}

export interface PersistentStorageS3Options {
  endpoint: string
  region?: string
  objectKey: string
  accessKeyId: string
  secretAccessKey: string
  /** If true, use path-style addressing (e.g. endpoint/bucket/key). Required for some S3-compatible services (e.g. MinIO). Default false (virtual-host style, e.g. bucket.endpoint/key). */
  forcePathStyle?: boolean
}

export interface PersistentStorageConfig {
  enabled: boolean
  type: PersistentStorageType
  accessLists: AccessList[]
  options: PersistentStorageLocalFSOptions | PersistentStorageS3Options
}

/**
 * Docker mount descriptor used by the Docker C2D engine.
 * Mirrors Dockerode `HostConfig.Mounts[]` item shape.
 */
export interface DockerMountObject {
  Type: 'bind'
  Source: string
  Target: string
  ReadOnly: boolean
}

export interface PersistentStorageObject extends BaseFileObject {
  type: 'nodePersistentStorage'
  bucketId: string
  fileName: string
}
