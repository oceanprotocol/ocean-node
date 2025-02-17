import { execSync } from 'child_process'
import { assert } from 'chai'
import { existsSync } from 'fs'
import { join } from 'path'

describe('Dashboard Build Tests', () => {
  const buildOutput = { stdout: '', stderr: '' }

  before(function () {
    this.timeout(300000) // 5 minutes timeout for build

    try {
      buildOutput.stdout = execSync('npm run check-changes', {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PATH: process.env.PATH
        }
      }).toString()

      // Debug output
      console.log('=== Build Output Start ===')
      console.log(buildOutput.stdout)
      console.log('=== Build Output End ===')
    } catch (error: any) {
      buildOutput.stderr = error.stderr
      console.error('=== Build Error Start ===')
      console.error(error.stderr)
      console.error('=== Build Error End ===')
      throw error
    }
  })

  it('should skip Next.js build - the changes should already have been built and commited', () => {
    // Verify dashboard exists
    const dashboardPath = join(process.cwd(), 'dist', 'dashboard')
    assert(existsSync(dashboardPath), 'Dashboard directory should exist')

    // Check if the build output contains the "no changes" message
    assert(
      buildOutput.stdout.includes(
        'No changes detected in the dashboard. Skipping Next.js build.'
      ),
      'Should show no changes detected message'
    )

    // Should not contain the "Changes detected" message
    assert(
      !buildOutput.stdout.includes(
        'Changes detected in the dashboard. Cleaning old build and running Next.js build...'
      ),
      'Should not show changes detected message'
    )
  })

  it('should have created a dashboard hash file', () => {
    const hashFilePath = join(process.cwd(), 'scripts', 'dashboard.hash')
    assert(existsSync(hashFilePath), 'Hash file should exist')
  })
})
