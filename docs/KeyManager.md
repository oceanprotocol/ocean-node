# KeyManager Architecture

## Overview

KeyManager supports multiple key source types through a provider abstraction pattern. This allows the system to support different key management solutions (raw private keys, GCP KMS, AWS KMS, etc.) without changing the core KeyManager logic.

## Architecture

```
KeyManager
 ├── IKeyProvider (interface)
 │     ├── RawPrivateKeyProvider (implemented)
 │     ├── GcpKmsProvider (future)
 │     └── AwsKmsProvider (future)
 │
 └── Factory Pattern
       └── createKeyProvider(config) → IKeyProvider
```

## Components

### 1. IKeyProvider Interface (`types.ts`)

Base interface that all key providers must implement:

```typescript
interface IKeyProvider {
  getType(): KeyProviderType
  initialize(): Promise<void>
  getPeerId(): PeerId
  getLibp2pPrivateKey(): any
  getLibp2pPublicKey(): Uint8Array
  getEthAddress(): string
  getRawPrivateKeyBytes(): Uint8Array
  cleanup?(): Promise<void>
}
```

### 2. KeyProviderType Enum

Defines supported key provider types:

- `RAW` - Raw private key from environment variable

### 3. RawPrivateKeyProvider (`providers/RawPrivateKeyProvider.ts`)

Implementation for raw private keys:

- Loads private key from config
- Derives libp2p keys and peerId
- Derives Ethereum address
- Provides raw private key bytes for EVM signer creation

### 4. Factory (`factory.ts`)

Creates and initializes the appropriate key provider:

```typescript
createKeyProvider(config: KeyProviderConfig): Promise<IKeyProvider>
```

### 5. KeyManager (`index.ts`)

Main class that:

- Wraps a key provider
- Manages EVM signer caching
- Provides unified API for key access

## Usage

### Current Usage (Raw Private Key)

```typescript
import { createKeyProvider } from './components/KeyManager/index.js'

const keyManager = new KeyManager(config)
```

## Adding New Key Providers

To add a new key provider (e.g., AWS KMS):

1. **Add to KeyProviderType**:

```typescript
export type KeyProviderType = 'raw' | 'gcp-kms' | 'aws' //new
```

2. **Create provider class**:

```typescript
export class AwsKmsProvider implements IKeyProvider {
  // Implement all interface methods
}
```

3. **Update factory**:

```typescript
case 'aws'':
  provider = new AwsKmsProvider(config)
  break
```

## Benefits

1. **Extensibility**: Easy to add new key sources
2. **Testability**: Can mock key providers for testing
3. **Security**: Supports secure key management solutions (KMS)
4. **Separation of Concerns**: Key retrieval logic separated from key usage logic
