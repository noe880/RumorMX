-- Migration to add house_id column to comment_reactions table
-- This allows the same table to handle both comment and house reactions

-- First make comment_id nullable
ALTER TABLE comment_reactions MODIFY COLUMN comment_id INT NULL;

-- Add house_id column
ALTER TABLE comment_reactions ADD COLUMN house_id INT NULL;

-- Add foreign key constraints
ALTER TABLE comment_reactions ADD CONSTRAINT fk_comment_reactions_comment_id
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE;
ALTER TABLE comment_reactions ADD CONSTRAINT fk_house_reactions_house_id
  FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE CASCADE;

-- Add unique constraints to prevent duplicate reactions
ALTER TABLE comment_reactions ADD UNIQUE KEY unique_comment_reaction (comment_id, reaction_token);
ALTER TABLE comment_reactions ADD UNIQUE KEY unique_house_reaction (house_id, reaction_token);

-- Note: Existing comment reactions will have house_id = NULL
-- New house reactions will have comment_id = NULL and house_id set