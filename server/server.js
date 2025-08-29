const express = require("express");
const cors = require("cors");
const path = require("path");
const houseRoutes = require("./routes/houses");
require("./config/database");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Corregir la ruta del directorio público (agregar ../)
app.use(express.static(path.join(__dirname, "../public")));

// Rutas
app.use("/api/houses", houseRoutes);

// Servir la aplicación frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public", "index.html"));
});

// Manejo de errores
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Algo salió mal!" });
});

// Manejo de rutas no encontradas
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

app.listen(PORT, () => {
  console.log(`Servidor ejecutándose en https://localhost:${PORT}`);
});
