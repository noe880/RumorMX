const mysql = require("mysql2");
require("dotenv").config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 30000, // ✅ Única opción de timeout necesaria
});

pool.getConnection((err, conn) => {
  if (err) {
    console.error("❌ Error conectando a la base de datos:", err);
    return;
  }
  console.log("✅ Pool MySQL listo");
  conn.release();
});

module.exports = pool;
