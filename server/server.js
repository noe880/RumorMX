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

// Add timeout middleware to prevent hanging requests
app.use((req, res, next) => {
  // Set timeout to 45 seconds (longer than frontend timeout)
  req.setTimeout(45000);
  res.setTimeout(45000);
  next();
});

// Handle JSON parsing errors
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res
      .status(400)
      .json({ error: "JSON inválido en el cuerpo de la solicitud" });
  }
  next(err);
});

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
