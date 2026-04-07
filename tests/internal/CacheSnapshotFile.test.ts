import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readUtf8HandleWithLimit, validateSnapshotFilePath } from '../../src/internal/CacheSnapshotFile'

describe('CacheSnapshotFile', () => {
  it('validates read and write paths inside the configured snapshot base dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-file-'))
    const filePath = join(dir, 'snapshot.json')

    try {
      await writeFile(filePath, '[]', 'utf8')
      await expect(validateSnapshotFilePath(filePath, 'read', dir)).resolves.toBe(filePath)
      await expect(validateSnapshotFilePath(filePath, 'write', dir)).resolves.toBe(filePath)
      await expect(validateSnapshotFilePath(filePath, 'write', false)).resolves.toBe(resolve(filePath))
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

  it('reads UTF-8 content with and without size limits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-read-'))
    const filePath = join(dir, 'snapshot.json')

    try {
      await writeFile(filePath, JSON.stringify([{ key: 'user:1', value: 'x'.repeat(128) }]), 'utf8')
      const handle = await open(filePath, 'r')
      await expect(readUtf8HandleWithLimit(handle, false)).resolves.toContain('user:1')
      await handle.close()

      const limitedHandle = await open(filePath, 'r')
      await expect(readUtf8HandleWithLimit(limitedHandle, 8)).rejects.toThrow(/snapshotMaxBytes/i)
      await limitedHandle.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
