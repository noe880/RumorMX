const express = require("express");
const router = express.Router();
const db = require("../config/database");

// Get total donations amount
router.get("/total", (req, res) => {
  const query = `
    SELECT COALESCE(SUM(amount), 0) as total
    FROM donations
    WHERE status = 'completed'
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error("Error obteniendo total de donaciones:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    const total = parseFloat(results[0].total) || 0;
    res.json({ total });
  });
});

// Record a new donation (for webhook or manual entry)
router.post("/", (req, res) => {
  const {
    amount,
    currency = "USD",
    donor_email,
    transaction_id,
    payment_method,
    status = "completed",
  } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "Monto inválido" });
  }

  const query = `
    INSERT INTO donations (amount, currency, donor_email, transaction_id, payment_method, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  db.query(
    query,
    [amount, currency, donor_email, transaction_id, payment_method, status],
    (err, results) => {
      if (err) {
        console.error("Error registrando donación:", err);
        return res.status(500).json({ error: "Error interno del servidor" });
      }

      res.status(201).json({
        id: results.insertId,
        amount,
        currency,
        status,
      });
    }
  );
});

// Get donation progress (percentage towards goal)
router.get("/progress", (req, res) => {
  const query = `
    SELECT current_amount, goal_amount
    FROM donation_progress
    WHERE id = 1
    LIMIT 1
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error("Error obteniendo progreso de donaciones:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    if (!results || results.length === 0) {
      return res.json({
        total: 0,
        goal: 50000,
        percentage: 0,
        remaining: 50000,
      });
    }

    const total = parseFloat(results[0].current_amount) || 0;
    const goal = parseFloat(results[0].goal_amount) || 50000;
    const percentage = Math.min((total / goal) * 100, 100);

    res.json({
      total,
      goal,
      percentage: Math.round(percentage * 100) / 100, // Round to 2 decimal places
      remaining: Math.max(goal - total, 0),
    });
  });
});

// Update donation progress manually
router.put("/progress", (req, res) => {
  const { current_amount, goal_amount } = req.body;

  if (current_amount === undefined || current_amount < 0) {
    return res.status(400).json({ error: "Monto actual inválido" });
  }

  const updateData = {
    current_amount: parseFloat(current_amount),
  };

  if (goal_amount !== undefined && goal_amount > 0) {
    updateData.goal_amount = parseFloat(goal_amount);
  }

  const query = `
    UPDATE donation_progress
    SET current_amount = ?, ${
      goal_amount !== undefined ? "goal_amount = ?," : ""
    } updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `;

  const params =
    goal_amount !== undefined
      ? [updateData.current_amount, updateData.goal_amount]
      : [updateData.current_amount];

  db.query(
    query.replace(", updated_at", "updated_at"),
    params,
    (err, results) => {
      if (err) {
        console.error("Error actualizando progreso de donaciones:", err);
        return res.status(500).json({ error: "Error interno del servidor" });
      }

      if (results.affectedRows === 0) {
        return res
          .status(404)
          .json({ error: "Registro de progreso no encontrado" });
      }

      res.json({
        message: "Progreso de donaciones actualizado exitosamente",
        current_amount: updateData.current_amount,
        goal_amount: updateData.goal_amount || 50000,
      });
    }
  );
});

module.exports = router;
