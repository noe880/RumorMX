-- Migration to add location_emojis table for emoji placement feature

CREATE TABLE location_emojis (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lat DECIMAL(10, 8) NOT NULL,
  lng DECIMAL(11, 8) NOT NULL,
  emoji VARCHAR(10) NOT NULL,
  emoji_type ENUM('NOV', 'AMA', 'GAY', 'EX', 'COM', 'ROL', 'FAL') NOT NULL,
  reaction_token VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_location (lat, lng),
  INDEX idx_reaction_token (reaction_token),
  INDEX idx_emoji_type (emoji_type)
);

-- Create separate index for date-based queries
CREATE INDEX idx_created_date ON location_emojis (DATE(created_at));

-- Add spatial index for better performance on location queries
-- Note: This requires MySQL 5.7+ with spatial features enabled
-- ALTER TABLE location_emojis ADD COLUMN location POINT NOT NULL;
-- UPDATE location_emojis SET location = POINT(lng, lat);
-- ALTER TABLE location_emojis ADD SPATIAL INDEX idx_location_spatial (location);