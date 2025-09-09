-- Examples of how to manually update the donation progress
-- Replace the values with your current donation amounts

-- Update current amount to $2,500 (keeping goal at $50,000)
UPDATE donation_progress
SET current_amount = 2500.00, updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

-- Update both current amount and goal
UPDATE donation_progress
SET current_amount = 7500.00, goal_amount = 50000.00, updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

-- View current progress
SELECT current_amount, goal_amount,
       ROUND((current_amount / goal_amount) * 100, 2) as percentage
FROM donation_progress
WHERE id = 1;

-- Reset to zero
UPDATE donation_progress
SET current_amount = 0.00, updated_at = CURRENT_TIMESTAMP
WHERE id = 1;