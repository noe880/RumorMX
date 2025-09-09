-- Migration to create donation progress table (single record for manual control)
CREATE TABLE IF NOT EXISTS donation_progress (
    id INT AUTO_INCREMENT PRIMARY KEY,
    current_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    goal_amount DECIMAL(10,2) NOT NULL DEFAULT 50000.00,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert initial record
INSERT INTO donation_progress (current_amount, goal_amount) VALUES (0.00, 50000.00)
ON DUPLICATE KEY UPDATE current_amount = VALUES(current_amount), goal_amount = VALUES(goal_amount);