const express = require("express");
const router = express.Router();
const db = require("../config/database");
const crypto = require("crypto");

// Reacciones permitidas para comentarios
const ALLOWED_REACTIONS = new Set([
  "like",
  "love",
  "haha",
  "wow",
  "sad",
  "angry",
]);

// Obtener todas las viviendas
router.get("/", (req, res) => {
  const query = "SELECT * FROM houses ORDER BY created_at DESC";

  db.query(query, (err, results) => {
    if (err) {
      console.error("Error obteniendo viviendas:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
    res.json(results);
  });
});

// Crear una nueva vivienda
router.post("/", (req, res) => {
  const { address, description, lat, lng } = req.body;

  if (!address || !description || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: "Faltan campos requeridos" });
  }

  const query =
    "INSERT INTO houses (address, description, lat, lng) VALUES (?, ?, ?, ?)";

  db.query(query, [address, description, lat, lng], (err, results) => {
    if (err) {
      console.error("Error creando vivienda:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    // Obtener la vivienda recién creada
    const selectQuery = "SELECT * FROM houses WHERE id = ?";
    db.query(selectQuery, [results.insertId], (err, houseResults) => {
      if (err) {
        console.error("Error obteniendo vivienda creada:", err);
        return res.status(500).json({ error: "Error interno del servidor" });
      }
      res.status(201).json(houseResults[0]);
    });
  });
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

// Crear un comentario para una vivienda
router.post("/:id/comments", (req, res) => {
  const id = parseInt(req.params.id);
  const { comment } = req.body;

  if (!comment || !comment.trim()) {
    return res.status(400).json({ error: "Comentario requerido" });
  }

  const q = "INSERT INTO comments (house_id, comment) VALUES (?, ?)";
  db.query(q, [id, comment.trim()], (err, results) => {
    if (err) {
      console.error("Error creando comentario:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    const selectQ =
      "SELECT id, house_id, comment, created_at FROM comments WHERE id = ?";
    db.query(selectQ, [results.insertId], (err2, rows) => {
      if (err2) {
        console.error("Error obteniendo comentario creado:", err2);
        return res.status(500).json({ error: "Error interno del servidor" });
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

// Top houses by house reaction count (but also include comment count for display)
router.get("/top", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 5;
  const q = `
    SELECT h.*,
           COALESCE(rc.reaction_count, 0) AS reaction_count,
           (SELECT COUNT(*) FROM comments WHERE house_id = h.id) AS comment_count
    FROM houses h
    LEFT JOIN (
      SELECT house_id, COUNT(*) AS reaction_count
      FROM comment_reactions
      WHERE house_id IS NOT NULL
      GROUP BY house_id
    ) rc ON rc.house_id = h.id
    ORDER BY COALESCE(rc.reaction_count, 0) DESC, h.created_at DESC
    LIMIT ?
  `;

  db.query(q, [limit], (err, rows) => {
    if (err) {
      console.error("Error obteniendo top de viviendas:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
    res.json(rows);
  });
});

module.exports = router;
