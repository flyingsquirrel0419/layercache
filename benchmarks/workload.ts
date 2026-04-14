import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface UserRecord {
  id: number
  email: string
  name: string
  profile: {
    plan: string
    region: string
    score: number
  }
  tags: string[]
}

const REGIONS = ['us-east', 'eu-west', 'ap-northeast', 'sa-east'] as const
const PLANS = ['starter', 'growth', 'enterprise'] as const

export function buildUserDataset(count: number): UserRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1
    const plan = PLANS[index % PLANS.length] ?? PLANS[0]
    const region = REGIONS[index % REGIONS.length] ?? REGIONS[0]

    return {
      id,
      email: `user${id}@example.com`,
      name: `User ${id}`,
      profile: {
        plan,
        region,
        score: (id * 37) % 1000
      },
      tags: [`segment-${id % 10}`, `cohort-${id % 4}`]
    }
  })
}

export function findUserById(users: UserRecord[], id: number): UserRecord {
  const user = users.find((entry) => entry.id === id)
  if (!user) {
    throw new Error(`User ${id} not found`)
  }

  return user
}

export async function ensureFixtureFile(filePath: string, count = 5000): Promise<void> {
  try {
    await readFile(filePath, 'utf8')
    return
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error
    }
  }

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(buildUserDataset(count)), 'utf8')
}

export async function loadUserFromFixture(filePath: string, userId: number, hashRounds = 600): Promise<UserRecord> {
  const raw = await readFile(filePath, 'utf8')
  const users = JSON.parse(raw) as UserRecord[]
  const user = findUserById(users, userId)

  let digest = JSON.stringify(user)
  for (let index = 0; index < hashRounds; index += 1) {
    digest = createHash('sha256').update(digest).digest('hex')
  }

  return {
    ...user,
    tags: [...user.tags, digest.slice(0, 12)]
  }
}
