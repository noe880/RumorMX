const mysql = require("mysql2");
require("dotenv").config();

// Usar un pool de conexiones para evitar "connection is in closed state"
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// Probar conexión inicial (opcional)
pool.getConnection((err, conn) => {
  if (err) {
    console.error("❌ Error conectando a la base de datos:", err);
    return;
  }
  console.log("✅ Pool MySQL listo");
  conn.release();
});

module.exports = pool;
