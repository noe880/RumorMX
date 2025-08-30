const express = require("express");
const router = express.Router();
const db = require("../config/database");

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

// Obtener comentarios de una vivienda
router.get("/:id/comments", (req, res) => {
  const id = parseInt(req.params.id);
  const q =
    "SELECT id, house_id, comment, created_at FROM comments WHERE house_id = ? ORDER BY created_at ASC";

  db.query(q, [id], (err, rows) => {
    if (err) {
      console.error("Error obteniendo comentarios:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
    res.json(rows);
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

module.exports = router;
