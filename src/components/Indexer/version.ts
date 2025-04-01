/**
 * Compares two semantic version strings
 * @param v1 First version
 * @param v2 Second version
 * @returns -1 if v1 < v2, 0 if v1 = v2, 1 if v1 > v2
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number)
  const parts2 = v2.split('.').map(Number)

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const part1 = i < parts1.length ? parts1[i] : 0
    const part2 = i < parts2.length ? parts2[i] : 0

    if (part1 < part2) return -1
    if (part1 > part2) return 1
  }

  return 0
}

/**
 * Checks if reindexing is needed based on version comparison
 * @param currentVersion Current node version
 * @param dbVersion Version stored in database
 * @param minVersion Minimum version that requires reindexing
 * @returns boolean indicating if reindexing is needed
 */
export function isReindexingNeeded(
  currentVersion: string,
  dbVersion: string | null,
  minVersion: string
): boolean {
  // If no DB version exists, reindexing is needed
  if (!dbVersion) return true

  // If current version is less than min version, something is wrong
  if (compareVersions(currentVersion, minVersion) < 0) {
    throw new Error(
      `Current version ${currentVersion} is less than minimum required version ${minVersion}`
    )
  }

  // If DB version is less than min version, reindexing is needed
  return compareVersions(dbVersion, minVersion) < 0
}
