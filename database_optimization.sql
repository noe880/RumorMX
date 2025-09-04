-- Optimización de índices para RumorMX
-- Nota: Ejecuta este script en tu base de datos MySQL (ajusta el schema si es necesario)
-- Algunos índices pueden existir; si es así, ignora los errores de "Duplicate key name"

-- 1) houses: consultas por created_at y por ventana lat/lng
ALTER TABLE houses
  ADD INDEX idx_houses_created_at (created_at),
  ADD INDEX idx_houses_lat_lng_created_at (lat, lng, created_at);

-- 2) comments: se listan por house_id y created_at
ALTER TABLE comments
  ADD INDEX idx_comments_house_created (house_id, created_at);

-- 3) comment_reactions: upsert y conteos por comment_id/house_id, además de created_at
ALTER TABLE comment_reactions
  ADD UNIQUE KEY uniq_comment_token (comment_id, reaction_token),
  ADD UNIQUE KEY uniq_house_token (house_id, reaction_token),
  ADD INDEX idx_comment_counts (comment_id, reaction),
  ADD INDEX idx_house_counts (house_id, reaction),
  ADD INDEX idx_reactions_created (created_at);

-- 4) location_emojis: consultas por ventana lat/lng + conteo diario por token
ALTER TABLE location_emojis
  ADD INDEX idx_emojis_lat_lng_created (lat, lng, created_at),
  ADD INDEX idx_emojis_token_date (reaction_token, created_at),
  ADD INDEX idx_emojis_created (created_at);

-- Sugerencias adicionales (opcional):
-- - Considerar particionamiento por rango de fecha en tablas muy grandes (comentarios/emojis) si crecen sin límite
-- - Si se usa MySQL 8 y tipos GEOMETRY, considerar POINT + SPATIAL INDEX para búsquedas geoespaciales
