const redis = require("redis");

// Utilidad: obtener URLs de Redis desde env (REDIS_URLS separado por comas o REDIS_URL único)
function getRedisUrls() {
  const urlsEnv = process.env.REDIS_URLS || process.env.REDIS_URL || "";
  return urlsEnv
    .split(/[ ,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Crear múltiples clientes Redis (uno por URL)
function createRedisClients() {
  const urls = getRedisUrls();
  // Si no hay URLs, devolvemos arreglo vacío y se usará fallback in-memory
  const clients = urls.map((url, idx) => {
    const client = redis.createClient({
      url,
      // Configuración de reconexión para redis v4
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10)
            return new Error("Redis max retry attempts reached");
          return Math.min(retries * 100, 3000);
        },
      },
    });

    // Eventos de conexión
    client.on("error", (err) =>
      console.error(`Redis[${idx}] Client Error:`, err)
    );
    client.on("connect", () =>
      console.log(`✅ Redis[${idx}] client connected (${url})`)
    );
    client.on("ready", () => console.log(`✅ Redis[${idx}] client ready`));
    client.on("end", () => console.log(`❌ Redis[${idx}] client disconnected`));

    return client;
  });

  return clients;
}

const redisClients = createRedisClients();

// Conectar todos los clientes de forma async (si existen)
(async () => {
  for (const client of redisClients) {
    try {
      // Evitar doble conexión si ya está abierto
      if (!client.isOpen) await client.connect();
    } catch (err) {
      console.warn("⚠️  Redis connection failed:", err.message);
    }
  }
})();

// Helpers
function getHealthyClients() {
  return redisClients.filter((c) => c && c.isOpen);
}

// Cache configuration
const CACHE_TTL = {
  HOUSES_BOUNDS: 600, // 10 minutes
  HOUSES_POPULAR: 600, // 10 minutes
  EMOJIS_BOUNDS: 180, // 3 minutes
  TOP_HOUSES: 300, // 5 minutes
};

// Cache key generators
const generateCacheKey = {
  housesBounds: (south, north, west, east, limit) =>
    `houses:bounds:${south.toFixed(4)}:${north.toFixed(4)}:${west.toFixed(
      4
    )}:${east.toFixed(4)}:${limit}`,

  housesPopular: (area) => `houses:popular:${area}`,

  emojisBounds: (south, north, west, east, limit) =>
    `emojis:bounds:${south.toFixed(4)}:${north.toFixed(4)}:${west.toFixed(
      4
    )}:${east.toFixed(4)}:${limit}`,

  topHouses: (limit) => `houses:top:${limit}`,
};

// Cache operations con soporte multi-Redis
class CacheManager {
  constructor() {
    this.fallbackCache = new Map(); // In-memory fallback (key -> {data, timestamp})
    this.fallbackTTL = new Map(); // In-memory TTL for cache keys (ms)
    this.fallbackCounters = new Map(); // In-memory counters (key -> {count, expiresAt})
  }

  // Atomic-like increment with TTL. Returns the new count.
  async incr(key, ttlSeconds = 60) {
    const clients = getHealthyClients();
    // Try Redis instances first
    for (const client of clients) {
      try {
        const count = await client.incr(key);
        if (count === 1) {
          // Set expiry only on first creation
          await client.expire(key, ttlSeconds);
        }
        return count;
      } catch (e) {
        console.warn("Redis incr error, trying next client:", e.message);
      }
    }

    // Fallback to in-memory counter
    const now = Date.now();
    const entry = this.fallbackCounters.get(key);
    if (!entry || entry.expiresAt <= now) {
      const expiresAt = now + Math.max(1, ttlSeconds) * 1000;
      this.fallbackCounters.set(key, { count: 1, expiresAt });
      return 1;
    } else {
      entry.count += 1;
      return entry.count;
    }
  }

  // Hay al menos un Redis conectado
  isRedisAvailable() {
    return getHealthyClients().length > 0;
  }

  // GET: intenta secuencialmente en los Redis saludables; si ninguno responde con dato, usa memoria
  async get(key) {
    try {
      const clients = getHealthyClients();
      for (const client of clients) {
        try {
          const data = await client.get(key);
          if (data != null) return JSON.parse(data);
        } catch (e) {
          // Continúa con el siguiente cliente
          console.warn("Redis get error, trying next client:", e.message);
        }
      }

      // Fallback a memoria
      const entry = this.fallbackCache.get(key);
      if (!entry) return null;

      const now = Date.now();
      if (now - entry.timestamp > (this.fallbackTTL.get(key) || 300000)) {
        this.fallbackCache.delete(key);
        this.fallbackTTL.delete(key);
        return null;
      }

      return entry.data;
    } catch (err) {
      console.error("Cache get error:", err);
      return null;
    }
  }

  // SET: escribe en todos los Redis saludables; si ninguno disponible, escribe en memoria
  async set(key, data, ttlSeconds = 300) {
    try {
      const serializedData = JSON.stringify(data);
      const clients = getHealthyClients();

      if (clients.length > 0) {
        const ops = clients.map((c) =>
          c.setEx(key, ttlSeconds, serializedData)
        );
        await Promise.allSettled(ops);
      } else {
        // Fallback to in-memory cache
        this.fallbackCache.set(key, {
          data,
          timestamp: Date.now(),
        });
        this.fallbackTTL.set(key, ttlSeconds * 1000);
      }
    } catch (err) {
      console.error("Cache set error:", err);
    }
  }

  // DEL: elimina en todos los Redis saludables o en memoria
  async del(key) {
    try {
      const clients = getHealthyClients();
      if (clients.length > 0) {
        const ops = clients.map((c) => c.del(key));
        await Promise.allSettled(ops);
      }
      this.fallbackCache.delete(key);
      this.fallbackTTL.delete(key);
    } catch (err) {
      console.error("Cache delete error:", err);
    }
  }

  // Clear all cache entries matching pattern
  async clearPattern(pattern) {
    try {
      const clients = getHealthyClients();
      if (clients.length > 0) {
        for (const c of clients) {
          try {
            // Usar scanIterator para evitar bloquear con KEYS
            const keys = [];
            for await (const key of c.scanIterator({ MATCH: pattern })) {
              keys.push(key);
              if (keys.length >= 500) {
                // Borrar en lotes
                await c.del(keys.splice(0, keys.length));
              }
            }
            if (keys.length > 0) await c.del(keys);
          } catch (e) {
            console.warn("Redis clearPattern error:", e.message);
          }
        }
      }
      // Limpiar fallback en memoria
      this.fallbackCache.clear();
      this.fallbackTTL.clear();
    } catch (err) {
      console.error("Cache clear pattern error:", err);
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
    await this.clearPattern("houses:*");
  }

  // Clear all emojis-related cache
  async clearEmojisCache() {
    await this.clearPattern("emojis:*");
  }

  // Get cache statistics
  async getStats() {
    try {
      const clients = getHealthyClients();
      if (clients.length > 0) {
        // Tomamos info del primero disponible
        try {
          const info = await clients[0].info();
          return {
            type: "redis",
            connected: true,
            instances: clients.length,
            info: info,
          };
        } catch (e) {
          return {
            type: "redis",
            connected: true,
            instances: clients.length,
            info: null,
            note: "info() falló en el primer cliente",
          };
        }
      } else {
        return {
          type: "memory",
          connected: false,
          entries: this.fallbackCache.size,
        };
      }
    } catch (err) {
      return {
        type: "error",
        connected: false,
        error: err.message,
      };
    }
  }
}

// Export singleton instance
const cacheManager = new CacheManager();

module.exports = cacheManager;
