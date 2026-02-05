/* eslint-disable no-unused-expressions */
/**
 * Integration test for Docker registry authentication functionality.
 *
 * Tests the getDockerManifest method with:
 * - Public images (no credentials)
 * - Registry auth configuration (username/password and auth string)
 * - Error handling
 */
import { expect, assert } from 'chai'
import { C2DEngineDocker } from '../../components/c2d/compute_engine_docker.js'
import { C2DClusterInfo, C2DClusterType } from '../../@types/C2D/C2D.js'
import { dockerRegistrysAuth } from '../../@types/OceanNode.js'

describe('Docker Registry Authentication Integration Tests', () => {
  describe('Public registry access (no credentials)', () => {
    it('should successfully fetch manifest for public Docker Hub image', async () => {
      // Create minimal engine instance for testing
      const clusterConfig: C2DClusterInfo = {
        type: C2DClusterType.DOCKER,
        hash: 'test-cluster-hash',
        connection: {
          socketPath: '/var/run/docker.sock'
        },
        tempFolder: '/tmp/test-docker'
      }

      // Mock minimal dependencies - we only need getDockerManifest
      const dockerEngine = new C2DEngineDocker(
        clusterConfig,
        null as any,
        null as any,
        null as any,
        {} // No auth config
      )

      // Test with a well-known public image
      const image = 'library/alpine:latest'
      const manifest = await dockerEngine.getDockerManifest(image)

      expect(manifest).to.exist
      expect(manifest).to.have.property('schemaVersion')
      expect(manifest).to.have.property('mediaType')
    }).timeout(10000)

    it('should successfully fetch manifest for public image with explicit tag', async () => {
      const clusterConfig: C2DClusterInfo = {
        type: C2DClusterType.DOCKER,
        hash: 'test-cluster-hash-2',
        connection: {
          socketPath: '/var/run/docker.sock'
        },
        tempFolder: '/tmp/test-docker-2'
      }

      const dockerEngine = new C2DEngineDocker(
        clusterConfig,
        null as any,
        null as any,
        null as any,
        {}
      )

      // Use a simple image reference that will default to Docker Hub
      const image = 'hello-world:latest'
      const manifest = await dockerEngine.getDockerManifest(image)

      expect(manifest).to.exist
      expect(manifest).to.have.property('schemaVersion')
    }).timeout(10000)
  })

  describe('Registry authentication configuration', () => {
    it('should store and retrieve username/password credentials', () => {
      const testAuth: dockerRegistrysAuth = {
        'https://registry-1.docker.io': {
          username: 'testuser',
          password: 'testpass',
          auth: ''
        }
      }

      const clusterConfig: C2DClusterInfo = {
        type: C2DClusterType.DOCKER,
        hash: 'test-cluster-hash-auth',
        connection: {
          socketPath: '/var/run/docker.sock'
        },
        tempFolder: '/tmp/test-docker-auth'
      }

      const engineWithAuth = new C2DEngineDocker(
        clusterConfig,
        null as any,
        null as any,
        null as any,
        testAuth
      )

      // Verify that getDockerRegistryAuth returns the credentials
      const auth = (engineWithAuth as any).getDockerRegistryAuth(
        'https://registry-1.docker.io'
      )
      expect(auth).to.exist
      expect(auth?.username).to.equal('testuser')
      expect(auth?.password).to.equal('testpass')
    })

    it('should use auth string when provided', () => {
      const preEncodedAuth = Buffer.from('testuser:testpass').toString('base64')
      const testAuth: dockerRegistrysAuth = {
        'https://registry-1.docker.io': {
          username: 'testuser',
          password: 'testpass',
          auth: preEncodedAuth
        }
      }

      const clusterConfig: C2DClusterInfo = {
        type: C2DClusterType.DOCKER,
        hash: 'test-cluster-hash-auth2',
        connection: {
          socketPath: '/var/run/docker.sock'
        },
        tempFolder: '/tmp/test-docker-auth2'
      }

      const engineWithAuth = new C2DEngineDocker(
        clusterConfig,
        null as any,
        null as any,
        null as any,
        testAuth
      )

      const auth = (engineWithAuth as any).getDockerRegistryAuth(
        'https://registry-1.docker.io'
      )
      expect(auth).to.exist
      expect(auth?.auth).to.equal(preEncodedAuth)
    })

    it('should return null for non-existent registry auth', () => {
      const clusterConfig: C2DClusterInfo = {
        type: C2DClusterType.DOCKER,
        hash: 'test-cluster-hash-3',
        connection: {
          socketPath: '/var/run/docker.sock'
        },
        tempFolder: '/tmp/test-docker-3'
      }

      const dockerEngine = new C2DEngineDocker(
        clusterConfig,
        null as any,
        null as any,
        null as any,
        {}
      )

      const auth = (dockerEngine as any).getDockerRegistryAuth(
        'https://nonexistent-registry.com'
      )
      expect(auth).to.be.null
    })

    it('should handle multiple registry configurations', () => {
      const testAuth: dockerRegistrysAuth = {
        'https://registry-1.docker.io': {
          username: 'user1',
          password: 'pass1',
          auth: ''
        },
        'https://ghcr.io': {
          username: 'user2',
          password: 'pass2',
          auth: ''
        }
      }

      const clusterConfig: C2DClusterInfo = {
        type: C2DClusterType.DOCKER,
        hash: 'test-cluster-hash-multi',
        connection: {
          socketPath: '/var/run/docker.sock'
        },
        tempFolder: '/tmp/test-docker-multi'
      }

      const engineWithAuth = new C2DEngineDocker(
        clusterConfig,
        null as any,
        null as any,
        null as any,
        testAuth
      )

      const dockerHubAuth = (engineWithAuth as any).getDockerRegistryAuth(
        'https://registry-1.docker.io'
      )
      expect(dockerHubAuth).to.exist
      expect(dockerHubAuth?.username).to.equal('user1')

      const ghcrAuth = (engineWithAuth as any).getDockerRegistryAuth('https://ghcr.io')
      expect(ghcrAuth).to.exist
      expect(ghcrAuth?.username).to.equal('user2')

      const unknownAuth = (engineWithAuth as any).getDockerRegistryAuth(
        'https://unknown-registry.com'
      )
      expect(unknownAuth).to.be.null
    })
  })

  describe('Error handling', () => {
    it('should handle invalid image references gracefully', async () => {
      const clusterConfig: C2DClusterInfo = {
        type: C2DClusterType.DOCKER,
        hash: 'test-cluster-hash-error',
        connection: {
          socketPath: '/var/run/docker.sock'
        },
        tempFolder: '/tmp/test-docker-error'
      }

      const dockerEngine = new C2DEngineDocker(
        clusterConfig,
        null as any,
        null as any,
        null as any,
        {}
      )

      try {
        await dockerEngine.getDockerManifest('invalid-image-reference')
        assert.fail('Should have thrown an error for invalid image')
      } catch (error: any) {
        expect(error).to.exist
        expect(error.message).to.include('Failed to get manifest')
      }
    }).timeout(10000)
  })
})
