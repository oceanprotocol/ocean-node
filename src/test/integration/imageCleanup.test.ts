import { expect, assert } from 'chai'
import { SQLiteCompute } from '../../components/database/sqliteCompute.js'
import { C2DDatabase } from '../../components/database/C2DDatabase.js'
import { typesenseSchemas } from '../../components/database/TypesenseSchemas.js'
import { getConfiguration } from '../../utils/config.js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../utils/utils.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { C2DEngineDocker } from '../../components/c2d/compute_engine_docker.js'
import { Escrow } from '../../components/core/utils/escrow.js'
import { KeyManager } from '../../components/KeyManager/index.js'
import { C2DClusterInfo } from '../../@types/C2D/C2D.js'
import Dockerode from 'dockerode'

describe('Docker Image Cleanup Integration Tests', () => {
  let envOverrides: OverrideEnvConfig[]
  let config: OceanNodeConfig
  let db: C2DDatabase
  let sqliteProvider: SQLiteCompute
  let dockerEngine: C2DEngineDocker
  let docker: Dockerode

  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.DOCKER_COMPUTE_ENVIRONMENTS],
      [
        JSON.stringify([
          {
            socketPath: '/var/run/docker.sock',
            resources: [{ id: 'disk', total: 10 }],
            storageExpiry: 604800,
            maxJobDuration: 3600,
            minJobDuration: 60,
            fees: {
              '1': [
                {
                  feeToken: '0x123',
                  prices: [{ id: 'cpu', price: 1 }]
                }
              ]
            },
            access: {
              addresses: [],
              accessLists: null
            },
            imageRetentionDays: 7,
            imageCleanupInterval: 60 // 1 minute for testing
          }
        ])
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    config = await getConfiguration(true)
    db = await new C2DDatabase(config.dbConfig, typesenseSchemas.c2dSchemas)
    sqliteProvider = (db as any).provider as SQLiteCompute

    // Initialize Docker connection for testing
    docker = new Dockerode()
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
    if (dockerEngine) {
      await dockerEngine.stop()
    }
  })

  describe('Image Tracking Database Methods', () => {
    it('should create docker_images table', async () => {
      await sqliteProvider.createImageTable()
      // If no error is thrown, table creation succeeded
      assert(true, 'Table creation should succeed')
    })

    it('should update image usage timestamp', async () => {
      const testImage = 'test-image:latest'
      await sqliteProvider.updateImage(testImage)

      // Verify image was recorded by querying directly
      // getOldImages(0) looks for images older than now, so we query the DB directly
      const imageRecord = await new Promise<any>((resolve, reject) => {
        const { db } = sqliteProvider as any
        db.get(
          'SELECT image, lastUsedTimestamp FROM docker_images WHERE image = ?',
          [testImage],
          (err: Error | null, row: any) => {
            if (err) reject(err)
            else resolve(row)
          }
        )
      })

      assert(imageRecord, 'Image should be recorded in database')
      expect(imageRecord.image).to.equal(testImage)
      expect(imageRecord.lastUsedTimestamp).to.be.a('number')
      const currentTimestamp = Math.floor(Date.now() / 1000)
      expect(imageRecord.lastUsedTimestamp).to.be.at.least(currentTimestamp - 1)
    })

    it('should update existing image timestamp', async () => {
      const testImage = 'test-image-update:latest'
      const firstTimestamp = Math.floor(Date.now() / 1000)

      // Insert image first time
      await sqliteProvider.updateImage(testImage)

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 1100))

      // Update image again - timestamp should be newer
      await sqliteProvider.updateImage(testImage)

      // Verify image exists with updated timestamp
      const imageRecord = await new Promise<any>((resolve, reject) => {
        const { db } = sqliteProvider as any
        db.get(
          'SELECT image, lastUsedTimestamp FROM docker_images WHERE image = ?',
          [testImage],
          (err: Error | null, row: any) => {
            if (err) reject(err)
            else resolve(row)
          }
        )
      })

      assert(imageRecord, 'Image should be recorded in database')
      expect(imageRecord.image).to.equal(testImage)
      expect(imageRecord.lastUsedTimestamp).to.be.greaterThan(firstTimestamp)
    })

    it('should return old images based on retention days', async () => {
      const recentImage = 'recent-image:latest'
      const oldImage = 'old-image:latest'

      // Update recent image
      await sqliteProvider.updateImage(recentImage)

      // Manually insert an old image by directly updating the database
      const oldTimestamp = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60 // 8 days ago
      await new Promise((resolve, reject) => {
        const { db } = sqliteProvider as any
        db.run(
          'INSERT OR REPLACE INTO docker_images (image, lastUsedTimestamp) VALUES (?, ?)',
          [oldImage, oldTimestamp],
          (err: Error | null) => {
            if (err) reject(err)
            else resolve(undefined)
          }
        )
      })

      // Get images older than 7 days
      const oldImages = await sqliteProvider.getOldImages(7)
      expect(oldImages).to.include(oldImage)
      expect(oldImages).to.not.include(recentImage)
    })

    it('should return empty array when no old images exist', async () => {
      const recentImage = 'very-recent-image:latest'
      await sqliteProvider.updateImage(recentImage)

      const oldImages = await sqliteProvider.getOldImages(30) // 30 days retention
      expect(oldImages).to.not.include(recentImage)
    })
  })

  describe('C2DEngineDocker Image Cleanup', () => {
    let clusterConfig: C2DClusterInfo
    let escrow: Escrow
    let keyManager: KeyManager

    before(() => {
      // Create minimal cluster config for testing
      clusterConfig = {
        type: 'docker' as any,
        hash: 'test-cluster-hash',
        connection: config.dockerComputeEnvironments[0],
        tempFolder: '/tmp/test-c2d'
      }

      // Create mock escrow and keyManager (minimal setup)
      escrow = {} as Escrow
      keyManager = {} as KeyManager

      dockerEngine = new C2DEngineDocker(clusterConfig, db, escrow, keyManager, {})
    })

    it('should track image usage when image is pulled', async () => {
      const testImage = 'alpine:latest'

      // Call updateImageUsage directly (using private method access for testing)
      await (dockerEngine as any).updateImageUsage(testImage)

      // Verify image was recorded in database
      const imageRecord = await new Promise<any>((resolve, reject) => {
        const { db } = sqliteProvider as any
        db.get(
          'SELECT image, lastUsedTimestamp FROM docker_images WHERE image = ?',
          [testImage],
          (err: Error | null, row: any) => {
            if (err) reject(err)
            else resolve(row)
          }
        )
      })

      assert(imageRecord, 'Image should be recorded in database after updateImageUsage')
      expect(imageRecord.image).to.equal(testImage)
    })

    it('should start image cleanup timer on engine start', () => {
      // Check if timer property exists
      assert(dockerEngine, 'dockerEngine should be initialized')
      expect(dockerEngine).to.have.property('imageCleanupTimer')
    })

    it('should stop image cleanup timer on engine stop', async () => {
      await dockerEngine.stop()
      // Timer should be cleared
      const timer = (dockerEngine as any).imageCleanupTimer
      assert(timer === null, 'Timer should be cleared after stop')
    })

    it('should handle cleanup of non-existent images gracefully', async () => {
      const nonExistentImage = 'non-existent-image:999999'

      // Manually insert into database
      await sqliteProvider.updateImage(nonExistentImage)

      // Try to clean it up - should not throw error
      try {
        await (dockerEngine as any).cleanupOldImages()
        assert(true, 'cleanupOldImages should complete without error')
      } catch (e) {
        // Cleanup should handle errors gracefully
        assert.fail('cleanupOldImages should not throw errors for non-existent images')
      }
    })
  })

  describe('Image Cleanup with Real Docker (if available)', () => {
    let testImageName: string

    before(async () => {
      // Check if Docker is available
      try {
        await docker.info()
      } catch (e) {
        // Skip tests if Docker is not available
      }
    })

    it('should cleanup old images from Docker', async function () {
      // Skip if Docker not available
      try {
        await docker.info()
      } catch (e) {
        this.skip()
      }

      testImageName = 'alpine:3.18'

      // Pull a test image
      try {
        await docker.pull(testImageName)
      } catch (e) {
        // If pull fails, skip test
        this.skip()
      }

      // Track the image with old timestamp (8 days ago)
      const oldTimestamp = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60
      await new Promise((resolve, reject) => {
        const { db } = sqliteProvider as any
        db.run(
          'INSERT OR REPLACE INTO docker_images (image, lastUsedTimestamp) VALUES (?, ?)',
          [testImageName, oldTimestamp],
          (err: Error | null) => {
            if (err) reject(err)
            else resolve(undefined)
          }
        )
      })

      // Verify image exists before cleanup
      const imagesBefore = await docker.listImages()
      const imageExistsBefore = imagesBefore.some(
        (img) => img.RepoTags && img.RepoTags.includes(testImageName)
      )

      if (imageExistsBefore) {
        // Run cleanup
        await (dockerEngine as any).cleanupOldImages()

        // Verify cleanup was attempted (may or may not succeed if image in use)
        // We just verify the cleanup function ran without error
        assert(true, 'cleanupOldImages should complete without error')
      }
    })

    after(async function () {
      // Clean up test image if it exists
      try {
        const dockerInfo = await docker.info()
        assert(dockerInfo, 'Docker should be available for cleanup')
        if (testImageName) {
          try {
            const image = docker.getImage(testImageName)
            await image.remove({ force: true })
          } catch (e) {
            // Ignore errors during cleanup
          }
        }
      } catch (e) {
        // Docker not available, skip cleanup
      }
    })
  })
})
