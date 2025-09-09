const express = require("express");
const router = express.Router();
const db = require("../config/database");
const crypto = require("crypto");
const cacheManager = require("../cache");

// Reacciones permitidas para comentarios
const ALLOWED_REACTIONS = new Set([
  "like",
  "love",
  "haha",
  "wow",
  "sad",
  "angry",
]);

// Emojis permitidos para ubicaciones
const ALLOWED_EMOJIS = {
  NOV: "❤️",
  AMA: "💋",
  GAY: "🏳️‍🌈",
  EX: "💔",
  COM: "🚩",
  ROL: "🔥",
  FAL: "🎭",
};

// Obtener viviendas con estrategia de carga mejorada (bounds + limit + cache)
router.get("/", async (req, res) => {
  const { north, south, east, west } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);

  const hasBounds =
    north !== undefined &&
    south !== undefined &&
    east !== undefined &&
    west !== undefined;

  let query;
  let params = [];

  if (hasBounds) {
    // Filtrar por viewport y limitar resultados - solo campos básicos para rendimiento
    query = `
      SELECT id, address, lat, lng, created_at
      FROM houses
      WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
      ORDER BY created_at DESC
      LIMIT ?
    `;
    params = [south, north, west, east, limit];
  } else {
    // Fallback: limitar siempre si no hay bounds (evita traer toda la BD)
    query = `
      SELECT id, address, lat, lng, created_at
      FROM houses
      ORDER BY created_at DESC
      LIMIT ?
    `;
    params = [limit];
  }

  // Use Redis cache for better performance
  const fetchFromDB = () => {
    return new Promise((resolve, reject) => {
      db.query(query, params, (err, results) => {
        if (err) {
          console.error("Error obteniendo viviendas:", err);
          reject(err);
        } else {
          resolve(results);
        }
      });
    });
  };

  try {
    const results = await cacheManager.getOrSet(
      `houses-basic:${
        hasBounds ? `${south},${north},${west},${east}` : "no-bounds"
      }:${limit}`,
      fetchFromDB,
      600 // 10 minutes TTL para mejor persistencia
    );

    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader(
      "X-Cache-Status",
      cacheManager.isRedisAvailable() ? "redis" : "memory"
    );
    res.json(results);
  } catch (err) {
    console.error("Error obteniendo viviendas:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Obtener detalles completos de una vivienda específica
router.get("/:id/details", async (req, res) => {
  const id = parseInt(req.params.id);
  console.log(`Details request for ID: ${req.params.id}, parsed ID: ${id}`);

  if (isNaN(id) || id <= 0) {
    console.log(`Invalid house ID: ${req.params.id}`);
    return res.status(400).json({ error: "ID de vivienda inválido" });
  }

  const fetchDetailedHouse = () => {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT h.*,
               0 AS reaction_count,
               0 AS comment_count
        FROM houses h
        WHERE h.id = ?
      `;

      console.log(`Executing query for house ID ${id}:`, query);
      db.query(query, [id], (err, results) => {
        if (err) {
          console.error("Error obteniendo detalles de vivienda:", err);
          reject(err);
        } else {
          console.log(`Query results for house ID ${id}:`, results);
          resolve(results[0] || null);
        }
      });
    });
  };

  try {
    console.log(`Fetching details for house ID: ${id}`);
    const house = await cacheManager.getOrSet(
      `house-details:${id}`,
      fetchDetailedHouse,
      600 // 10 minutes TTL for detailed data
    );

    console.log(`House details result:`, house);
    if (!house) {
      console.log(`House with ID ${id} not found`);
      return res.status(404).json({ error: "Vivienda no encontrada" });
    }

    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader(
      "X-Cache-Status",
      cacheManager.isRedisAvailable() ? "redis" : "memory"
    );
    res.json(house);
  } catch (err) {
    console.error("Error obteniendo detalles de vivienda:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Crear una nueva vivienda (límite 10 por día por usuario + rate limit por IP y captcha opcional)
router.post("/", async (req, res) => {
  const { address, description, lat, lng, captcha_token } = req.body || {};

  // Validaciones básicas y sanitización
  if (
    !address ||
    !description ||
    lat === undefined ||
    lng === undefined ||
    typeof address !== "string" ||
    typeof description !== "string" ||
    typeof lat !== "number" ||
    typeof lng !== "number"
  ) {
    return res
      .status(400)
      .json({ error: "Faltan o son inválidos los campos requeridos" });
  }
  const cleanAddress = address.trim().slice(0, 200);
  const cleanDescription = description.trim().slice(0, 1000);
  if (!cleanAddress || !cleanDescription) {
    return res.status(400).json({ error: "Contenido vacío no permitido" });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: "Coordenadas inválidas" });
  }

  // Identificar al "usuario" mediante cookie persistente (reutilizamos reaction_token)
  let token = getCookieFromHeader(req, "reaction_token");
  let setCookieHeader = null;
  if (!token || token.length !== 64) {
    token = crypto.randomBytes(32).toString("hex"); // 64 chars hex
    const cookie = `reaction_token=${encodeURIComponent(token)}; Max-Age=${
      60 * 60 * 24 * 365 * 2
    }; Path=/; SameSite=Lax`;
    setCookieHeader = cookie;
  }

  // Rate limit compuesto: por token diario + por IP en ventana corta
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const dayKey = `${y}${m}${d}`;
  const rlKeyDaily = `rl:houses:${token}:${dayKey}`;
  const ip = (req.ip || "").toString();
  const ipKeyMinute = `rl:houses:ip:${ip}:m`; // ventana 60s
  const ipKeyHour = `rl:houses:ip:${ip}:h`; // ventana 1h

  try {
    // Límite diario por token (10)
    const currentDaily = (await cacheManager.get(rlKeyDaily)) || 0;
    if (currentDaily >= 10) {
      return res
        .status(429)
        .json({
          error: "Has alcanzado el límite de 10 viviendas creadas por día",
        });
    }

    // Límite por IP: máx 5 por minuto y 60 por hora
    const minuteCount = await cacheManager.incr(ipKeyMinute, 60);
    const hourCount = await cacheManager.incr(ipKeyHour, 3600);

    if (minuteCount > 5 || hourCount > 60) {
      return res
        .status(429)
        .json({
          error: "Demasiadas solicitudes desde tu IP. Intenta más tarde.",
        });
    }

    // Cooldown por token: máx 1 inserción cada 10 segundos
    const cdKey = `rl:houses:cooldown:${token}`;
    const cdCount = await cacheManager.incr(cdKey, 10);
    if (cdCount > 1) {
      return res
        .status(429)
        .json({
          error:
            "Estás enviando muy rápido. Intenta de nuevo en unos segundos.",
        });
    }

    // Anti-duplicados por contenido (hash de address+description+lat+lng)
    const contentHash = crypto
      .createHash("sha1")
      .update(`${cleanAddress}|${cleanDescription}|${lat}|${lng}`)
      .digest("hex");
    const dupKey = `rl:houses:content:${contentHash}`;
    const dupCount = await cacheManager.incr(dupKey, 600); // ventana 10 minutos
    if (dupCount > 3) {
      return res.status(409).json({ error: "Contenido duplicado detectado" });
    }
  } catch (e) {
    console.warn("RateLimit check error:", e?.message || e);
  }

  const query =
    "INSERT INTO houses (address, description, lat, lng) VALUES (?, ?, ?, ?)";

  db.query(
    query,
    [cleanAddress, cleanDescription, lat, lng],
    async (err, results) => {
      if (err) {
        console.error("Error creando vivienda:", err);
        return res.status(500).json({ error: "Error interno del servidor" });
      }

      // Incrementar contador diario y ajustar TTL hasta el inicio del próximo día UTC
      try {
        const now2 = new Date();
        const tomorrowUtc = new Date(
          Date.UTC(
            now2.getUTCFullYear(),
            now2.getUTCMonth(),
            now2.getUTCDate() + 1,
            0,
            0,
            0
          )
        );
        const ttl = Math.max(
          60,
          Math.floor((tomorrowUtc.getTime() - Date.now()) / 1000)
        );
        const prev = (await cacheManager.get(rlKeyDaily)) || 0;
        await cacheManager.set(rlKeyDaily, prev + 1, ttl);
      } catch (e) {
        console.warn("RateLimit write error:", e?.message || e);
      }

      // Clear cache for houses and top houses
      cacheManager.clearHousesCache();
      cacheManager.del("top-houses:*");

      // Obtener la vivienda recién creada
      const selectQuery = "SELECT * FROM houses WHERE id = ?";
      db.query(selectQuery, [results.insertId], (err2, houseResults) => {
        if (err2) {
          console.error("Error obteniendo vivienda creada:", err2);
          return res.status(500).json({ error: "Error interno del servidor" });
        }
        if (setCookieHeader) {
          res.setHeader("Set-Cookie", setCookieHeader);
        }
        res.status(201).json(houseResults[0]);
      });
    }
  );
});

// Actualizar una vivienda existente
router.put("/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const { address, description } = req.body;

  const query =
    "UPDATE houses SET address = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?";

  db.query(query, [address, description, id], (err, results) => {
    if (err) {
      console.error("Error actualizando vivienda:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    if (results.affectedRows === 0) {
      return res.status(404).json({ error: "Vivienda no encontrada" });
    }

    // Clear cache for houses and top houses
    cacheManager.clearHousesCache();
    cacheManager.del("top-houses:*");

    // Obtener la vivienda actualizada
    const selectQuery = "SELECT * FROM houses WHERE id = ?";
    db.query(selectQuery, [id], (err, houseResults) => {
      if (err) {
        console.error("Error obteniendo vivienda actualizada:", err);
        return res.status(500).json({ error: "Error interno del servidor" });
      }
      res.json(houseResults[0]);
    });
  });
});

// Eliminar una vivienda
router.delete("/:id", (req, res) => {
  const id = parseInt(req.params.id);

  const query = "DELETE FROM houses WHERE id = ?";

  db.query(query, [id], (err, results) => {
    if (err) {
      console.error("Error eliminando vivienda:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    if (results.affectedRows === 0) {
      return res.status(404).json({ error: "Vivienda no encontrada" });
    }

    res.status(204).send();
  });
});

// Helper simple para leer cookies
function getCookieFromHeader(req, name) {
  const raw = req.headers.cookie || "";
  const parts = raw.split(";");
  for (const p of parts) {
    const [k, ...vparts] = p.trim().split("=");
    if (k === name) return decodeURIComponent(vparts.join("="));
  }
  return null;
}

// Obtener comentarios de una vivienda con conteo de reacciones y reacción del usuario
router.get("/:id/comments", (req, res) => {
  const id = parseInt(req.params.id);
  const q =
    "SELECT id, house_id, comment, created_at FROM comments WHERE house_id = ? ORDER BY created_at ASC";

  db.query(q, [id], (err, comments) => {
    if (err) {
      console.error("Error obteniendo comentarios:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    if (!comments || comments.length === 0) {
      return res.json([]);
    }

    const commentIds = comments.map((c) => c.id);
    const token = getCookieFromHeader(req, "reaction_token");

    // Obtener conteos por reacción (solo para comentarios, no casas)
    const countsQ =
      "SELECT comment_id, reaction, COUNT(*) AS cnt FROM comment_reactions WHERE comment_id IN (?) AND house_id IS NULL GROUP BY comment_id, reaction";
    db.query(countsQ, [commentIds], (err2, countsRows) => {
      if (err2) {
        console.error("Error obteniendo conteos de reacciones:", err2);
        return res.status(500).json({ error: "Error interno del servidor" });
      }

      // Mapear conteos
      const countsMap = new Map(); // comment_id -> {reaction: count}
      for (const r of countsRows || []) {
        if (!countsMap.has(r.comment_id)) countsMap.set(r.comment_id, {});
        countsMap.get(r.comment_id)[r.reaction] = Number(r.cnt) || 0;
      }

      const attachAndSend = (userRows) => {
        const userMap = new Map(); // comment_id -> reaction
        for (const u of userRows || []) userMap.set(u.comment_id, u.reaction);

        const result = comments.map((c) => ({
          id: c.id,
          house_id: c.house_id,
          comment: c.comment,
          created_at: c.created_at,
          reactions: {
            like: countsMap.get(c.id)?.like || 0,
            love: countsMap.get(c.id)?.love || 0,
            haha: countsMap.get(c.id)?.haha || 0,
            wow: countsMap.get(c.id)?.wow || 0,
            sad: countsMap.get(c.id)?.sad || 0,
            angry: countsMap.get(c.id)?.angry || 0,
          },
          user_reaction: userMap.get(c.id) || null,
        }));
        return res.json(result);
      };

      if (!token) return attachAndSend([]);

      const userQ =
        "SELECT comment_id, reaction FROM comment_reactions WHERE reaction_token = ? AND comment_id IN (?) AND house_id IS NULL";
      db.query(userQ, [token, commentIds], (err3, userRows) => {
        if (err3) {
          console.error("Error obteniendo reacciones del usuario:", err3);
          return res.status(500).json({ error: "Error interno del servidor" });
        }
        attachAndSend(userRows);
      });
    });
  });
});

// Crear un comentario para una vivienda con límite de 10 por día por usuario
router.post("/:id/comments", async (req, res) => {
  const id = parseInt(req.params.id);
  const { comment } = req.body;

  if (!comment || !comment.trim()) {
    return res.status(400).json({ error: "Comentario requerido" });
  }

  // Identificar al "usuario" mediante cookie persistente (reutilizamos reaction_token)
  let token = getCookieFromHeader(req, "reaction_token");
  let setCookieHeader = null;
  if (!token || token.length !== 64) {
    token = crypto.randomBytes(32).toString("hex"); // 64 chars hex
    const cookie = `reaction_token=${encodeURIComponent(token)}; Max-Age=${
      60 * 60 * 24 * 365 * 2
    }; Path=/; SameSite=Lax`;
    setCookieHeader = cookie;
  }

  // Rate limit: 10 comentarios por día por token (día UTC)
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const dayKey = `${y}${m}${d}`;
  const rlKey = `rl:comments:${token}:${dayKey}`;

  try {
    const current = (await cacheManager.get(rlKey)) || 0;
    if (current >= 10) {
      return res
        .status(429)
        .json({ error: "Has alcanzado el límite de 10 comentarios por día" });
    }
  } catch (e) {
    console.warn("RateLimit read error:", e?.message || e);
  }

  const q = "INSERT INTO comments (house_id, comment) VALUES (?, ?)";
  db.query(q, [id, comment.trim()], async (err, results) => {
    if (err) {
      console.error("Error creando comentario:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    // Incrementar contador y ajustar TTL hasta el inicio del próximo día UTC
    try {
      const now2 = new Date();
      const tomorrowUtc = new Date(
        Date.UTC(
          now2.getUTCFullYear(),
          now2.getUTCMonth(),
          now2.getUTCDate() + 1,
          0,
          0,
          0
        )
      );
      const ttl = Math.max(
        60,
        Math.floor((tomorrowUtc.getTime() - Date.now()) / 1000)
      );
      const prev = (await cacheManager.get(rlKey)) || 0;
      await cacheManager.set(rlKey, prev + 1, ttl);
    } catch (e) {
      console.warn("RateLimit write error:", e?.message || e);
    }

    const selectQ =
      "SELECT id, house_id, comment, created_at FROM comments WHERE id = ?";
    db.query(selectQ, [results.insertId], (err2, rows) => {
      if (err2) {
        console.error("Error obteniendo comentario creado:", err2);
        return res.status(500).json({ error: "Error interno del servidor" });
      }
      if (setCookieHeader) {
        res.setHeader("Set-Cookie", setCookieHeader);
      }
      res.status(201).json(rows[0]);
    });
  });
});

// Crear/actualizar reacción a un comentario (una por token)
router.post("/comments/:commentId/reactions", (req, res) => {
  const commentId = parseInt(req.params.commentId, 10);
  const { reaction } = req.body || {};

  if (!ALLOWED_REACTIONS.has(reaction)) {
    return res.status(400).json({ error: "Reacción inválida" });
  }

  // Obtener o generar token de 64 chars
  let token = getCookieFromHeader(req, "reaction_token");
  let setCookieHeader = null;
  if (!token || token.length !== 64) {
    token = crypto.randomBytes(32).toString("hex"); // 64 hex chars
    // cookie por 2 años, httpOnly=false para leer en front, SameSite=Lax
    const cookie = `reaction_token=${encodeURIComponent(token)}; Max-Age=${
      60 * 60 * 24 * 365 * 2
    }; Path=/; SameSite=Lax`;
    setCookieHeader = cookie;
  }

  // UPSERT: si ya reaccionó ese token a ese comentario, actualizar; si no, insertar
  const upsertQ = `
    INSERT INTO comment_reactions (comment_id, reaction_token, reaction, house_id)
    VALUES (?, ?, ?, NULL)
    ON DUPLICATE KEY UPDATE reaction = VALUES(reaction), created_at = CURRENT_TIMESTAMP
  `;

  db.query(upsertQ, [commentId, token, reaction], (err, _result) => {
    if (err) {
      // si hay error por falta de índice único, avisar al usuario que se requiere
      console.error("Error guardando reacción:", err);
      return res.status(500).json({ error: "Error guardando reacción" });
    }

    // Devolver conteos actualizados y la reacción del usuario
    const countsQ = `
      SELECT reaction, COUNT(*) AS cnt
      FROM comment_reactions
      WHERE comment_id = ? AND house_id IS NULL
      GROUP BY reaction
    `;
    db.query(countsQ, [commentId], (err2, rows) => {
      if (err2) {
        console.error("Error obteniendo conteos:", err2);
        return res.status(500).json({ error: "Error interno del servidor" });
      }

      const counts = { like: 0, love: 0, haha: 0, wow: 0, sad: 0, angry: 0 };
      for (const r of rows || []) counts[r.reaction] = Number(r.cnt) || 0;

      const payload = {
        comment_id: commentId,
        reactions: counts,
        user_reaction: reaction,
      };
      if (setCookieHeader) {
        res.setHeader("Set-Cookie", setCookieHeader);
      }
      return res.json(payload);
    });
  });
});

// Eliminar reacción del usuario en un comentario
router.delete("/comments/:commentId/reactions", (req, res) => {
  const commentId = parseInt(req.params.commentId, 10);
  const token = getCookieFromHeader(req, "reaction_token");
  if (!token) return res.status(204).send();

  const delQ =
    "DELETE FROM comment_reactions WHERE comment_id = ? AND reaction_token = ? AND house_id IS NULL";
  db.query(delQ, [commentId, token], (err, _r) => {
    if (err) {
      console.error("Error eliminando reacción:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    // devolver conteos actualizados
    const countsQ = `
      SELECT reaction, COUNT(*) AS cnt
      FROM comment_reactions
      WHERE comment_id = ? AND house_id IS NULL
      GROUP BY reaction
    `;
    db.query(countsQ, [commentId], (err2, rows) => {
      if (err2) {
        console.error("Error obteniendo conteos:", err2);
        return res.status(500).json({ error: "Error interno del servidor" });
      }
      const counts = { like: 0, love: 0, haha: 0, wow: 0, sad: 0, angry: 0 };
      for (const r of rows || []) counts[r.reaction] = Number(r.cnt) || 0;
      return res.json({
        comment_id: commentId,
        reactions: counts,
        user_reaction: null,
      });
    });
  });
});

// Get reactions for a house
router.get("/:id/reactions", (req, res) => {
  const houseId = parseInt(req.params.id);
  const token = getCookieFromHeader(req, "reaction_token");

  // Get reaction counts for the house
  const countsQ = `
    SELECT reaction, COUNT(*) AS cnt
    FROM comment_reactions
    WHERE house_id = ?
    GROUP BY reaction
  `;

  db.query(countsQ, [houseId], (err, countsRows) => {
    if (err) {
      console.error("Error obteniendo conteos de reacciones de casa:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    const counts = { like: 0, love: 0, haha: 0, wow: 0, sad: 0, angry: 0 };
    for (const r of countsRows || []) counts[r.reaction] = Number(r.cnt) || 0;

    const attachUserReaction = (userRows) => {
      const userReaction =
        userRows && userRows.length > 0 ? userRows[0].reaction : null;
      return res.json({
        house_id: houseId,
        reactions: counts,
        user_reaction: userReaction,
      });
    };

    if (!token) return attachUserReaction([]);

    const userQ =
      "SELECT reaction FROM comment_reactions WHERE house_id = ? AND reaction_token = ?";
    db.query(userQ, [houseId, token], (err2, userRows) => {
      if (err2) {
        console.error("Error obteniendo reacción del usuario:", err2);
        return res.status(500).json({ error: "Error interno del servidor" });
      }
      attachUserReaction(userRows);
    });
  });
});

// Create/update reaction for a house
router.post("/:id/reactions", (req, res) => {
  const houseId = parseInt(req.params.id);
  const { reaction } = req.body || {};

  if (!ALLOWED_REACTIONS.has(reaction)) {
    return res.status(400).json({ error: "Reacción inválida" });
  }

  // Get or generate token
  let token = getCookieFromHeader(req, "reaction_token");
  let setCookieHeader = null;
  if (!token || token.length !== 64) {
    token = crypto.randomBytes(32).toString("hex");
    const cookie = `reaction_token=${encodeURIComponent(token)}; Max-Age=${
      60 * 60 * 24 * 365 * 2
    }; Path=/; SameSite=Lax`;
    setCookieHeader = cookie;
  }

  // UPSERT reaction for house
  const upsertQ = `
    INSERT INTO comment_reactions (house_id, reaction_token, reaction)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE reaction = VALUES(reaction), created_at = CURRENT_TIMESTAMP
  `;

  db.query(upsertQ, [houseId, token, reaction], (err, _result) => {
    if (err) {
      console.error("Error guardando reacción de casa:", err);
      return res.status(500).json({ error: "Error guardando reacción" });
    }

    // Return updated counts
    const countsQ = `
      SELECT reaction, COUNT(*) AS cnt
      FROM comment_reactions
      WHERE house_id = ?
      GROUP BY reaction
    `;
    db.query(countsQ, [houseId], (err2, rows) => {
      if (err2) {
        console.error("Error obteniendo conteos:", err2);
        return res.status(500).json({ error: "Error interno del servidor" });
      }

      const counts = { like: 0, love: 0, haha: 0, wow: 0, sad: 0, angry: 0 };
      for (const r of rows || []) counts[r.reaction] = Number(r.cnt) || 0;

      const payload = {
        house_id: houseId,
        reactions: counts,
        user_reaction: reaction,
      };
      if (setCookieHeader) {
        res.setHeader("Set-Cookie", setCookieHeader);
      }
      return res.json(payload);
    });
  });
});

// Delete user's reaction from a house
router.delete("/:id/reactions", (req, res) => {
  const houseId = parseInt(req.params.id);
  const token = getCookieFromHeader(req, "reaction_token");
  if (!token) return res.status(204).send();

  const delQ =
    "DELETE FROM comment_reactions WHERE house_id = ? AND reaction_token = ?";
  db.query(delQ, [houseId, token], (err, _r) => {
    if (err) {
      console.error("Error eliminando reacción de casa:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    // Return updated counts
    const countsQ = `
      SELECT reaction, COUNT(*) AS cnt
      FROM comment_reactions
      WHERE house_id = ?
      GROUP BY reaction
    `;
    db.query(countsQ, [houseId], (err2, rows) => {
      if (err2) {
        console.error("Error obteniendo conteos:", err2);
        return res.status(500).json({ error: "Error interno del servidor" });
      }
      const counts = { like: 0, love: 0, haha: 0, wow: 0, sad: 0, angry: 0 };
      for (const r of rows || []) counts[r.reaction] = Number(r.cnt) || 0;
      return res.json({
        house_id: houseId,
        reactions: counts,
        user_reaction: null,
      });
    });
  });
});

// Top houses with improved algorithm (time-weighted engagement)
router.get("/top", async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;

  const fetchTopHousesFromDB = () => {
    return new Promise((resolve, reject) => {
      const q = `
        SELECT h.*,
               COALESCE(rc.reaction_count, 0) AS reaction_count,
               (SELECT COUNT(*) FROM comments WHERE house_id = h.id) AS comment_count,
               (
                 -- Base score: reactions + comments * 2
                 COALESCE(rc.reaction_count, 0) +
                 (SELECT COUNT(*) FROM comments WHERE house_id = h.id) * 2 +
                 -- Recency bonus: recent activity (last 7 days) * 1.5
                 COALESCE(rc_recent.recent_reactions, 0) * 1.5 +
                 (SELECT COUNT(*) FROM comments WHERE house_id = h.id AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) * 3 +
                 -- Super recency bonus: last 24 hours * 2
                 COALESCE(rc_today.recent_reactions, 0) * 2 +
                 (SELECT COUNT(*) FROM comments WHERE house_id = h.id AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) * 4
               ) * EXP(-DATEDIFF(NOW(), h.created_at) * 0.02) AS engagement_score
        FROM houses h
        LEFT JOIN (
          SELECT house_id, COUNT(*) AS reaction_count
          FROM comment_reactions
          WHERE house_id IS NOT NULL
          GROUP BY house_id
        ) rc ON rc.house_id = h.id
        LEFT JOIN (
          SELECT house_id, COUNT(*) AS recent_reactions
          FROM comment_reactions
          WHERE house_id IS NOT NULL AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
          GROUP BY house_id
        ) rc_recent ON rc_recent.house_id = h.id
        LEFT JOIN (
          SELECT house_id, COUNT(*) AS recent_reactions
          FROM comment_reactions
          WHERE house_id IS NOT NULL AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
          GROUP BY house_id
        ) rc_today ON rc_today.house_id = h.id
        ORDER BY (engagement_score * (1 + (RAND(UNIX_TIMESTAMP(CURDATE())) * 0.6 - 0.3))) DESC, h.created_at DESC
        LIMIT ?
      `;

      db.query(q, [limit], (err, rows) => {
        if (err) {
          console.error("Error obteniendo top de viviendas:", err);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  };

  try {
    const results = await cacheManager.getOrSet(
      `top-houses:${limit}`,
      fetchTopHousesFromDB,
      300 // 5 minutes TTL
    );

    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader(
      "X-Cache-Status",
      cacheManager.isRedisAvailable() ? "redis" : "memory"
    );
    res.json(results);
  } catch (err) {
    console.error("Error obteniendo top de viviendas:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// -------- Emoji Routes --------

// Obtener emojis en un área específica (bounds + limit + cache)
router.get("/emojis", async (req, res) => {
  const { north, south, east, west } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);

  if (!north || !south || !east || !west) {
    return res.status(400).json({ error: "Faltan parámetros de límites" });
  }

  const fetchEmojisFromDB = () => {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT id, lat, lng, emoji, emoji_type, created_at
        FROM location_emojis
        WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
        ORDER BY created_at DESC
        LIMIT ?
      `;

      db.query(query, [south, north, west, east, limit], (err, results) => {
        if (err) {
          // Si la tabla no existe, devolver array vacío
          if (err.code === "ER_NO_SUCH_TABLE") {
            console.log(
              "Tabla location_emojis no existe aún, devolviendo array vacío"
            );
            resolve([]);
            return;
          }
          console.error("Error obteniendo emojis:", err);
          reject(err);
        } else {
          resolve(results);
        }
      });
    });
  };

  try {
    const results = await cacheManager.getOrSet(
      `emojis:${south},${north},${west},${east}:${limit}`,
      fetchEmojisFromDB,
      180 // 3 minutes TTL
    );

    res.setHeader("Cache-Control", "public, max-age=180");
    res.setHeader(
      "X-Cache-Status",
      cacheManager.isRedisAvailable() ? "redis" : "memory"
    );
    res.json(results);
  } catch (err) {
    console.error("Error obteniendo emojis:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Colocar un emoji en una ubicación
router.post("/emojis", (req, res) => {
  const { lat, lng, emoji_type } = req.body;

  if (!lat || !lng || !emoji_type) {
    return res.status(400).json({ error: "Faltan campos requeridos" });
  }

  if (!ALLOWED_EMOJIS[emoji_type]) {
    return res.status(400).json({ error: "Tipo de emoji inválido" });
  }

  // Obtener o generar token
  let token = getCookieFromHeader(req, "reaction_token");
  let setCookieHeader = null;
  if (!token || token.length !== 64) {
    token = crypto.randomBytes(32).toString("hex");
    const cookie = `reaction_token=${encodeURIComponent(token)}; Max-Age=${
      60 * 60 * 24 * 365 * 2
    }; Path=/; SameSite=Lax`;
    setCookieHeader = cookie;
  }

  // Verificar límite diario (5 emojis por día)
  const countQuery = `
    SELECT COUNT(*) as count
    FROM location_emojis
    WHERE reaction_token = ? AND DATE(created_at) = CURDATE()
  `;

  db.query(countQuery, [token], (err, countResults) => {
    if (err) {
      if (err.code === "ER_NO_SUCH_TABLE") {
        // Si la tabla no existe, permitir colocar emoji (count = 0)
        countResults = [{ count: 0 }];
      } else {
        console.error("Error verificando límite diario:", err);
        return res.status(500).json({ error: "Error interno del servidor" });
      }
    }

    if (countResults[0].count >= 5) {
      return res
        .status(429)
        .json({ error: "Has alcanzado el límite diario de 5 emojis" });
    }

    // Insertar emoji
    const insertQuery = `
      INSERT INTO location_emojis (lat, lng, emoji, emoji_type, reaction_token)
      VALUES (?, ?, ?, ?, ?)
    `;

    const emoji = ALLOWED_EMOJIS[emoji_type];

    db.query(
      insertQuery,
      [lat, lng, emoji, emoji_type, token],
      (err, results) => {
        if (err) {
          if (err.code === "ER_NO_SUCH_TABLE") {
            return res.status(500).json({
              error:
                "La tabla de emojis no existe. Ejecuta la migración emoji_migration.sql primero.",
            });
          }
          console.error("Error insertando emoji:", err);
          return res.status(500).json({ error: "Error interno del servidor" });
        }

        // Clear emoji cache
        cacheManager.clearEmojisCache();

        const payload = {
          id: results.insertId,
          lat,
          lng,
          emoji,
          emoji_type,
          created_at: new Date(),
        };

        if (setCookieHeader) {
          res.setHeader("Set-Cookie", setCookieHeader);
        }

        res.status(201).json(payload);
      }
    );
  });
});

// Obtener conteo diario de emojis colocados por el usuario
router.get("/emojis/daily-count", (req, res) => {
  const token = getCookieFromHeader(req, "reaction_token");

  if (!token) {
    return res.json({ count: 0, limit: 5 });
  }

  const query = `
    SELECT COUNT(*) as count
    FROM location_emojis
    WHERE reaction_token = ? AND DATE(created_at) = CURDATE()
  `;

  db.query(query, [token], (err, results) => {
    if (err) {
      if (err.code === "ER_NO_SUCH_TABLE") {
        return res.json({ count: 0, limit: 5, remaining: 5 });
      }
      console.error("Error obteniendo conteo diario:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    res.json({
      count: results[0].count,
      limit: 5,
      remaining: Math.max(0, 5 - results[0].count),
    });
  });
});

// Export all houses data as CSV or JSON
router.get("/export", async (req, res) => {
  const format = req.query.format || "json"; // 'json' or 'csv'
  const limit = parseInt(req.query.limit, 10) || 10000; // Default limit for safety

  const fetchAllHouses = () => {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT
          h.id,
          h.address,
          h.description,
          h.lat,
          h.lng,
          h.created_at,
          h.updated_at,
          COALESCE(rc.reaction_count, 0) AS total_reactions,
          (SELECT COUNT(*) FROM comments WHERE house_id = h.id) AS total_comments
        FROM houses h
        LEFT JOIN (
          SELECT house_id, COUNT(*) AS reaction_count
          FROM comment_reactions
          WHERE house_id IS NOT NULL
          GROUP BY house_id
        ) rc ON rc.house_id = h.id
        ORDER BY h.created_at DESC
        LIMIT ?
      `;

      db.query(query, [limit], (err, results) => {
        if (err) {
          console.error("Error obteniendo datos para exportación:", err);
          reject(err);
        } else {
          resolve(results);
        }
      });
    });
  };

  try {
    const houses = await cacheManager.getOrSet(
      `export-houses-${limit}`,
      fetchAllHouses,
      3600 // 1 hour TTL for export data
    );

    if (format === "csv") {
      // Generate CSV
      const csvHeaders = [
        "ID",
        "Dirección",
        "Descripción",
        "Latitud",
        "Longitud",
        "Fecha Creación",
        "Fecha Actualización",
        "Total Reacciones",
        "Total Comentarios",
      ];
      const csvRows = houses.map((house) => [
        house.id,
        `"${(house.address || "").replace(/"/g, '""')}"`,
        `"${(house.description || "").replace(/"/g, '""')}"`,
        house.lat,
        house.lng,
        house.created_at,
        house.updated_at || "",
        house.total_reactions,
        house.total_comments,
      ]);

      const csvContent = [csvHeaders, ...csvRows]
        .map((row) => row.join(","))
        .join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="rumormx_houses_${
          new Date().toISOString().split("T")[0]
        }.csv"`
      );
      res.send("\ufeff" + csvContent); // UTF-8 BOM for Excel compatibility
    } else {
      // JSON format
      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="rumormx_houses_${
          new Date().toISOString().split("T")[0]
        }.json"`
      );
      res.json({
        export_date: new Date().toISOString(),
        total_records: houses.length,
        data: houses,
      });
    }
  } catch (err) {
    console.error("Error en exportación:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;
