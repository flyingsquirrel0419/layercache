interface RedisGenerationClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode?: 'NX'): Promise<unknown>
  incr(key: string): Promise<number>
}

interface RedisGenerationStoreOptions {
  /** Redis client used to persist and atomically bump the generation. */
  client: RedisGenerationClient
  /** Redis key storing the active generation. Defaults to `layercache:generation`. */
  key?: string
}

const DEFAULT_GENERATION_KEY = 'layercache:generation'

export class RedisGenerationStore {
  private readonly client: RedisGenerationClient
  private readonly key: string

  constructor(options: RedisGenerationStoreOptions) {
    this.client = options.client
    this.key = options.key ?? DEFAULT_GENERATION_KEY
  }

  async get(): Promise<number | undefined> {
    const stored = await this.client.get(this.key)
    if (stored === null) {
      return undefined
    }

    return this.parseGeneration(stored)
  }

  async getOrInitialize(initialGeneration = 0): Promise<number> {
    this.assertGeneration(initialGeneration)
    await this.client.set(this.key, String(initialGeneration), 'NX')
    const generation = await this.get()
    if (generation === undefined) {
      throw new Error(`RedisGenerationStore failed to initialize generation key "${this.key}".`)
    }
    return generation
  }

  async set(generation: number): Promise<void> {
    this.assertGeneration(generation)
    await this.client.set(this.key, String(generation))
  }

  async bump(): Promise<number> {
    const generation = await this.client.incr(this.key)
    this.assertGeneration(generation)
    return generation
  }

  private parseGeneration(value: string): number {
    const generation = Number.parseInt(value, 10)
    if (String(generation) !== value || !this.isGeneration(generation)) {
      throw new Error(`RedisGenerationStore found invalid persisted generation value for key "${this.key}".`)
    }
    return generation
  }

  private assertGeneration(value: number): void {
    if (!this.isGeneration(value)) {
      throw new Error('RedisGenerationStore generation must be a non-negative safe integer.')
    }
  }

  private isGeneration(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0
  }
}
