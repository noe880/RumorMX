const redis = require('redis');

// Usa la URL completa de Redis
const redisClient = redis.createClient({
  url: process.env.REDIS_URL, // ← Esto es lo más importante
  retry_strategy: (options) => {
    if (options.error && options.error.code === 'ECONNREFUSED') {
      console.error('Redis connection refused');
      return new Error('Redis connection refused');
    }
    if (options.total_retry_time > 1000 * 60 * 60) {
      console.error('Redis retry time exhausted');
      return new Error('Retry time exhausted');
    }
    if (options.attempt > 10) {
      console.error('Redis max retry attempts reached');
      return undefined;
    }
    return Math.min(options.attempt * 100, 3000);
  }
});

// Conectar el cliente
redisClient.on('error', (err) => console.error('Redis Client Error', err));
redisClient.on('connect', () => console.log('✅ Connected to Redis'));

(async () => {
  try {
    await redisClient.connect();
    console.log('✅ Redis client connected');
  } catch (err) {
    console.warn('⚠️ Redis connection failed, falling back to in-memory cache:', err.message);
  }
})();// Importante en versiones recientes de redis

// Handle Redis connection events
redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

redisClient.on('connect', () => {
  console.log('✅ Redis client connected');
});

redisClient.on('ready', () => {
  console.log('✅ Redis client ready');
});

redisClient.on('end', () => {
  console.log('❌ Redis client disconnected');
});

// Connect to Redis (async)
(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.warn('⚠️  Redis connection failed, falling back to in-memory cache:', err.message);
  }
})();

// Cache configuration
const CACHE_TTL = {
  HOUSES_BOUNDS: 300, // 5 minutes for viewport queries
  HOUSES_POPULAR: 600, // 10 minutes for popular areas
  EMOJIS_BOUNDS: 180, // 3 minutes for emoji queries
  TOP_HOUSES: 300, // 5 minutes for top houses
};

// Cache key generators
const generateCacheKey = {
  housesBounds: (south, north, west, east, limit) =>
    `houses:bounds:${south.toFixed(4)}:${north.toFixed(4)}:${west.toFixed(4)}:${east.toFixed(4)}:${limit}`,

  housesPopular: (area) => `houses:popular:${area}`,

  emojisBounds: (south, north, west, east, limit) =>
    `emojis:bounds:${south.toFixed(4)}:${north.toFixed(4)}:${west.toFixed(4)}:${east.toFixed(4)}:${limit}`,

  topHouses: (limit) => `houses:top:${limit}`,
};

// Cache operations
class CacheManager {
  constructor() {
    this.fallbackCache = new Map(); // In-memory fallback
    this.fallbackTTL = new Map();
  }

  // Check if Redis is available
  isRedisAvailable() {
    return redisClient.isOpen;
  }

  // Get data from cache
  async get(key) {
    try {
      if (this.isRedisAvailable()) {
        const data = await redisClient.get(key);
        return data ? JSON.parse(data) : null;
      } else {
        // Fallback to in-memory cache
        const entry = this.fallbackCache.get(key);
        if (!entry) return null;

        const now = Date.now();
        if (now - entry.timestamp > (this.fallbackTTL.get(key) || 300000)) {
          this.fallbackCache.delete(key);
          this.fallbackTTL.delete(key);
          return null;
        }

        return entry.data;
      }
    } catch (err) {
      console.error('Cache get error:', err);
      return null;
    }
  }

  // Set data in cache
  async set(key, data, ttlSeconds = 300) {
    try {
      const serializedData = JSON.stringify(data);

      if (this.isRedisAvailable()) {
        await redisClient.setEx(key, ttlSeconds, serializedData);
      } else {
        // Fallback to in-memory cache
        this.fallbackCache.set(key, {
          data,
          timestamp: Date.now()
        });
        this.fallbackTTL.set(key, ttlSeconds * 1000);
      }
    } catch (err) {
      console.error('Cache set error:', err);
    }
  }

  // Delete cache entry
  async del(key) {
    try {
      if (this.isRedisAvailable()) {
        await redisClient.del(key);
      } else {
        this.fallbackCache.delete(key);
        this.fallbackTTL.delete(key);
      }
    } catch (err) {
      console.error('Cache delete error:', err);
    }
  }

  // Clear all cache entries matching pattern
  async clearPattern(pattern) {
    try {
      if (this.isRedisAvailable()) {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) {
          await redisClient.del(keys);
        }
      } else {
        // For in-memory, clear all entries (simple implementation)
        this.fallbackCache.clear();
        this.fallbackTTL.clear();
      }
    } catch (err) {
      console.error('Cache clear pattern error:', err);
    }
  }

  // Get or set with automatic caching
  async getOrSet(key, fetchFunction, ttlSeconds = 300) {
    let data = await this.get(key);
    if (data !== null) {
      return data;
    }

    // Fetch fresh data
    data = await fetchFunction();

    // Cache the result
    if (data !== null && data !== undefined) {
      await this.set(key, data, ttlSeconds);
    }

    return data;
  }

  // Specialized methods for different data types
  async getHousesBounds(south, north, west, east, limit) {
    const key = generateCacheKey.housesBounds(south, north, west, east, limit);
    return this.get(key);
  }

  async setHousesBounds(south, north, west, east, limit, data) {
    const key = generateCacheKey.housesBounds(south, north, west, east, limit);
    return this.set(key, data, CACHE_TTL.HOUSES_BOUNDS);
  }

  async getEmojisBounds(south, north, west, east, limit) {
    const key = generateCacheKey.emojisBounds(south, north, west, east, limit);
    return this.get(key);
  }

  async setEmojisBounds(south, north, west, east, limit, data) {
    const key = generateCacheKey.emojisBounds(south, north, west, east, limit);
    return this.set(key, data, CACHE_TTL.EMOJIS_BOUNDS);
  }

  async getTopHouses(limit) {
    const key = generateCacheKey.topHouses(limit);
    return this.get(key);
  }

  async setTopHouses(limit, data) {
    const key = generateCacheKey.topHouses(limit);
    return this.set(key, data, CACHE_TTL.TOP_HOUSES);
  }

  // Clear all houses-related cache
  async clearHousesCache() {
    await this.clearPattern('houses:*');
  }

  // Clear all emojis-related cache
  async clearEmojisCache() {
    await this.clearPattern('emojis:*');
  }

  // Get cache statistics
  async getStats() {
    try {
      if (this.isRedisAvailable()) {
        const info = await redisClient.info();
        return {
          type: 'redis',
          connected: true,
          info: info
        };
      } else {
        return {
          type: 'memory',
          connected: false,
          entries: this.fallbackCache.size
        };
      }
    } catch (err) {
      return {
        type: 'error',
        connected: false,
        error: err.message
      };
    }
  }
}

// Export singleton instance
const cacheManager = new CacheManager();

module.exports = cacheManager;