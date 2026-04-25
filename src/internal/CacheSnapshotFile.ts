import { randomBytes } from 'node:crypto'
import { type FileHandle, rename, unlink } from 'node:fs/promises'

function isWithinSnapshotBase(
  realBaseDir: string,
  candidatePath: string,
  pathSeparator: string,
  path: typeof import('node:path')
): boolean {
  const relative = path.relative(realBaseDir, candidatePath)
  return !(relative === '..' || relative.startsWith(`..${pathSeparator}`) || path.isAbsolute(relative))
}

async function findExistingAncestor(
  directory: string,
  fs: typeof import('node:fs/promises'),
  path: typeof import('node:path')
): Promise<string> {
  let current = directory
  while (true) {
    try {
      await fs.lstat(current)
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return current
    }
    current = parent
  }
}

export async function validateSnapshotFilePath(
  filePath: string,
  mode: 'read' | 'write',
  snapshotBaseDir: string | false | undefined,
  cwd = process.cwd()
): Promise<string> {
  if (filePath.length === 0) {
    throw new Error('filePath must not be empty.')
  }

  if (filePath.includes('\u0000')) {
    throw new Error('filePath must not contain null bytes.')
  }

  const { promises: fs } = await import('node:fs')
  const path = await import('node:path')
  const resolved = path.resolve(filePath)
  const baseDir = snapshotBaseDir === false ? false : path.resolve(snapshotBaseDir ?? cwd)

  if (baseDir === false) {
    return resolved
  }

  await fs.mkdir(baseDir, { recursive: true })
  const realBaseDir = await fs.realpath(baseDir)
  if (!isWithinSnapshotBase(realBaseDir, resolved, path.sep, path)) {
    throw new Error(`filePath is outside the allowed snapshot directory: ${realBaseDir}`)
  }

  if (mode === 'read') {
    const realTarget = await fs.realpath(resolved)
    if (!isWithinSnapshotBase(realBaseDir, realTarget, path.sep, path)) {
      throw new Error(`filePath is outside the allowed snapshot directory: ${realBaseDir}`)
    }
    return realTarget
  }

  const parentDir = path.dirname(resolved)
  const existingAncestor = await findExistingAncestor(parentDir, fs, path)
  const realExistingAncestor = await fs.realpath(existingAncestor)
  if (!isWithinSnapshotBase(realBaseDir, realExistingAncestor, path.sep, path)) {
    throw new Error(`filePath is outside the allowed snapshot directory: ${realBaseDir}`)
  }

  await fs.mkdir(parentDir, { recursive: true })
  const realParentDir = await fs.realpath(parentDir)
  if (!isWithinSnapshotBase(realBaseDir, realParentDir, path.sep, path)) {
    throw new Error(`filePath is outside the allowed snapshot directory: ${realBaseDir}`)
  }

  const targetPath = path.join(realParentDir, path.basename(resolved))

  try {
    const existing = await fs.lstat(targetPath)
    if (existing.isSymbolicLink()) {
      throw new Error('filePath must not point to a symbolic link.')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  return targetPath
}

export async function readUtf8HandleWithLimit(handle: FileHandle, byteLimit: number | false): Promise<string> {
  if (byteLimit === false) {
    return handle.readFile({ encoding: 'utf8' })
  }

  const chunks: Buffer[] = []
  let totalBytes = 0
  let position = 0

  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, byteLimit - totalBytes + 1))
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position)
    if (bytesRead === 0) {
      break
    }

    totalBytes += bytesRead
    if (totalBytes > byteLimit) {
      throw new Error(`Snapshot file exceeds snapshotMaxBytes limit (${totalBytes} bytes > ${byteLimit} bytes).`)
    }

    chunks.push(buffer.subarray(0, bytesRead))
    position += bytesRead
  }

  return Buffer.concat(chunks).toString('utf8')
}

export function atomicWriteTempPath(targetPath: string): string {
  return `${targetPath}.tmp-${randomBytes(8).toString('hex')}`
}

export async function commitAtomicWrite(tempPath: string, targetPath: string): Promise<void> {
  try {
    await rename(tempPath, targetPath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}
