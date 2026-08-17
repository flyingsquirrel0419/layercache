import * as fs from 'node:fs'
import { mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  atomicWriteTempPath,
  commitAtomicWrite,
  readUtf8HandleWithLimit,
  validateSnapshotFilePath
} from '../../src/internal/CacheSnapshotFile'

describe('CacheSnapshotFile', () => {
  it('validates read and write paths inside the configured snapshot base dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-file-'))
    const filePath = join(dir, 'nested', 'deeper', 'snapshot.json')
    const realFilePath = join(await realpath(dir), 'nested', 'deeper', 'snapshot.json')

    try {
      await expect(validateSnapshotFilePath(filePath, 'write', dir)).resolves.toBe(realFilePath)
      await expect(validateSnapshotFilePath(filePath, 'write', false)).resolves.toBe(resolve(filePath))

      await writeFile(filePath, '[]', 'utf8')
      await expect(validateSnapshotFilePath(filePath, 'read', dir)).resolves.toBe(realFilePath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('maps a symlinked logical snapshot base onto its real directory', async () => {
    const physicalBase = await mkdtemp(join(tmpdir(), 'layercache-snapshot-physical-'))
    const logicalParent = await mkdtemp(join(tmpdir(), 'layercache-snapshot-logical-'))
    const logicalBase = join(logicalParent, 'cache')
    const logicalFile = join(logicalBase, 'nested', 'snapshot.json')
    const realFile = join(await realpath(physicalBase), 'nested', 'snapshot.json')

    try {
      await symlink(physicalBase, logicalBase, 'dir')
      await expect(validateSnapshotFilePath(logicalFile, 'write', logicalBase)).resolves.toBe(realFile)
      await writeFile(logicalFile, '[]', 'utf8')
      await expect(validateSnapshotFilePath(logicalFile, 'read', logicalBase)).resolves.toBe(realFile)
    } finally {
      await rm(logicalParent, { recursive: true, force: true })
      await rm(physicalBase, { recursive: true, force: true })
    }
  })

  it('allows write validation when the existing target is a regular file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-existing-file-'))
    const filePath = join(dir, 'snapshot.json')
    const realFilePath = join(await realpath(dir), 'snapshot.json')

    try {
      await writeFile(filePath, '[]', 'utf8')
      await expect(validateSnapshotFilePath(filePath, 'write', dir)).resolves.toBe(realFilePath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid or escaping snapshot paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-file-invalid-'))
    const outsideDir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-file-outside-'))
    const outsidePath = join(outsideDir, 'snapshot.json')

    try {
      await expect(validateSnapshotFilePath('', 'write', dir)).rejects.toThrow(/must not be empty/i)
      await expect(validateSnapshotFilePath('bad\u0000path', 'write', dir)).rejects.toThrow(/null bytes/i)
      await expect(validateSnapshotFilePath(join(dir, '..', 'outside.json'), 'write', dir)).rejects.toThrow(
        /outside the allowed snapshot directory/i
      )

      const linkedDir = join(dir, 'linked')
      await symlink(outsideDir, linkedDir, 'dir')
      await expect(validateSnapshotFilePath(join(linkedDir, 'snapshot.json'), 'write', dir)).rejects.toThrow(
        /outside the allowed snapshot directory/i
      )

      const linkedFile = join(dir, 'linked-file.json')
      await writeFile(outsidePath, '[]', 'utf8')
      await symlink(outsidePath, linkedFile, 'file')
      await expect(validateSnapshotFilePath(linkedFile, 'read', dir)).rejects.toThrow(
        /outside the allowed snapshot directory/i
      )
      await expect(validateSnapshotFilePath(linkedFile, 'write', dir)).rejects.toThrow(/symbolic link/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('rethrows non-ENOENT ancestor lookup errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-file-err-'))
    const filePath = join(dir, 'nested', 'snapshot.json')
    const lstatError = Object.assign(new Error('boom'), { code: 'EACCES' })
    const lstatSpy = vi.spyOn(fs.promises, 'lstat').mockRejectedValue(lstatError)

    try {
      await expect(validateSnapshotFilePath(filePath, 'write', dir)).rejects.toThrow('boom')
    } finally {
      lstatSpy.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('walks ancestor lookup to the root when intermediate directories are missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-file-root-'))
    const filePath = join(dir, 'nested', 'snapshot.json')
    const lstatSpy = vi
      .spyOn(fs.promises, 'lstat')
      .mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))

    try {
      await expect(validateSnapshotFilePath(filePath, 'write', dir)).rejects.toThrow(
        /outside the allowed snapshot directory/i
      )
    } finally {
      lstatSpy.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects writes when an existing parent directory is swapped for a symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-race-'))
    const outsideDir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-race-outside-'))
    const parentDir = join(dir, 'nested')
    const filePath = join(parentDir, 'snapshot.json')
    await fs.promises.mkdir(parentDir, { recursive: true })

    const realMkdir = fs.promises.mkdir.bind(fs.promises)
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (...args) => {
      const [target] = args
      if (target === parentDir) {
        await rm(parentDir, { recursive: true, force: true })
        await symlink(outsideDir, parentDir, 'dir')
        return undefined
      }

      return realMkdir(...(args as Parameters<typeof fs.promises.mkdir>))
    })

    try {
      await expect(validateSnapshotFilePath(filePath, 'write', dir)).rejects.toThrow(
        /outside the allowed snapshot directory/i
      )
    } finally {
      mkdirSpy.mockRestore()
      await rm(dir, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('reads UTF-8 content with and without size limits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-read-'))
    const filePath = join(dir, 'snapshot.json')

    try {
      await writeFile(filePath, JSON.stringify([{ key: 'user:1', value: 'x'.repeat(128) }]), 'utf8')
      const handle = await open(filePath, 'r')
      await expect(readUtf8HandleWithLimit(handle, false)).resolves.toContain('user:1')
      await handle.close()

      const fullHandle = await open(filePath, 'r')
      await expect(readUtf8HandleWithLimit(fullHandle, 1_024)).resolves.toContain('user:1')
      await fullHandle.close()

      const limitedHandle = await open(filePath, 'r')
      await expect(readUtf8HandleWithLimit(limitedHandle, 8)).rejects.toThrow(/snapshotMaxBytes/i)
      await limitedHandle.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cleans up temp file and re-throws when rename fails in commitAtomicWrite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-commit-'))
    const tempPath = join(dir, 'temp-file.tmp')
    const targetPath = join(dir, 'nonexistent', 'nested', 'target.txt')

    try {
      await writeFile(tempPath, 'test', 'utf8')
      await expect(commitAtomicWrite(tempPath, targetPath)).rejects.toThrow()
      await expect(fs.promises.stat(tempPath)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects commit when the validated parent was swapped to a symlink before rename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-commit-race-'))
    const outsideDir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-commit-race-outside-'))
    const parentDir = join(dir, 'nested')
    const targetPath = join(parentDir, 'snapshot.json')

    try {
      await fs.promises.mkdir(parentDir, { recursive: true })
      const validatedTargetPath = await validateSnapshotFilePath(targetPath, 'write', dir)
      const tempPath = atomicWriteTempPath(validatedTargetPath)

      await rm(parentDir, { recursive: true, force: true })
      await symlink(outsideDir, parentDir, 'dir')
      await writeFile(tempPath, 'proof', 'utf8')

      await expect(commitAtomicWrite(tempPath, validatedTargetPath, { snapshotBaseDir: dir })).rejects.toThrow(
        /symbolic link/i
      )
      await expect(fs.promises.stat(join(outsideDir, 'snapshot.json'))).rejects.toThrow()
      await expect(fs.promises.stat(tempPath)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('rejects commit when a validated ancestor was swapped to a symlink before rename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-commit-ancestor-race-'))
    const outsideDir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-commit-ancestor-race-outside-'))
    const ancestorDir = join(dir, 'a')
    const parentDir = join(ancestorDir, 'b')
    const targetPath = join(parentDir, 'snapshot.json')

    try {
      await fs.promises.mkdir(parentDir, { recursive: true })
      const validatedTargetPath = await validateSnapshotFilePath(targetPath, 'write', dir)
      const tempPath = atomicWriteTempPath(validatedTargetPath)
      const tempName = basename(tempPath)

      await rm(ancestorDir, { recursive: true, force: true })
      await fs.promises.mkdir(join(outsideDir, 'b'), { recursive: true })
      await symlink(outsideDir, ancestorDir, 'dir')
      await writeFile(join(outsideDir, 'b', tempName), 'proof', 'utf8')

      await expect(commitAtomicWrite(tempPath, validatedTargetPath, { snapshotBaseDir: dir })).rejects.toThrow(
        /outside the allowed snapshot directory/i
      )
      await expect(fs.promises.stat(join(outsideDir, 'b', 'snapshot.json'))).rejects.toThrow()
      await expect(fs.promises.stat(join(outsideDir, 'b', tempName))).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('generates a temp path with a hex suffix for atomic writes', () => {
    const result = atomicWriteTempPath('/data/snapshot.json')
    expect(result).toMatch(/^\/data\/snapshot\.json\.tmp-[0-9a-f]{16}$/)
  })
})
