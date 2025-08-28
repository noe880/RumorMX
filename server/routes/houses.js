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

module.exports = router;
