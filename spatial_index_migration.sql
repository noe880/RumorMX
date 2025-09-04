-- Spatial Index Migration for RumorMX
-- This script adds spatial indexing to the houses and location_emojis tables
-- Requires MySQL 5.7+ with spatial features enabled

-- Add spatial columns to houses table
ALTER TABLE houses ADD COLUMN location POINT NOT NULL;
UPDATE houses SET location = POINT(lng, lat);
ALTER TABLE houses ADD SPATIAL INDEX idx_houses_location (location);

-- Add spatial columns to location_emojis table (if not already done)
-- Check if location column exists first
SET @column_exists = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'location_emojis'
    AND COLUMN_NAME = 'location'
);

SET @sql = IF(@column_exists = 0,
    'ALTER TABLE location_emojis ADD COLUMN location POINT NOT NULL',
    'SELECT "Location column already exists in location_emojis"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Update location column if it was just added
SET @sql = IF(@column_exists = 0,
    'UPDATE location_emojis SET location = POINT(lng, lat)',
    'SELECT "Location column already populated"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add spatial index to location_emojis if not exists
SET @index_exists = (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'location_emojis'
    AND INDEX_NAME = 'idx_location_emojis_spatial'
);

SET @sql = IF(@index_exists = 0,
    'ALTER TABLE location_emojis ADD SPATIAL INDEX idx_location_emojis_spatial (location)',
    'SELECT "Spatial index already exists on location_emojis"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Optional: Create a stored procedure for bounding box queries using spatial functions
-- This can be faster than lat/lng BETWEEN for large datasets
DELIMITER //

DROP PROCEDURE IF EXISTS get_houses_in_bounds_spatial;
CREATE PROCEDURE get_houses_in_bounds_spatial(
    IN min_lat DECIMAL(10,8),
    IN max_lat DECIMAL(10,8),
    IN min_lng DECIMAL(11,8),
    IN max_lng DECIMAL(11,8),
    IN max_results INT
)
BEGIN
    SELECT *
    FROM houses
    WHERE MBRContains(
        GeomFromText(CONCAT('POLYGON((', min_lng, ' ', min_lat, ',', max_lng, ' ', min_lat, ',', max_lng, ' ', max_lat, ',', min_lng, ' ', max_lat, ',', min_lng, ' ', min_lat, '))')),
        location
    )
    ORDER BY created_at DESC
    LIMIT max_results;
END //

DELIMITER ;

-- Note: To use the spatial procedure, call it like:
-- CALL get_houses_in_bounds_spatial(-118.4, -86.7, 14.5, 32.7, 1000);
-- But for now, we'll keep using the existing lat/lng BETWEEN queries as they work well with existing code