-- Fix migration: Make comment_id nullable

-- Make comment_id nullable
ALTER TABLE comment_reactions MODIFY COLUMN comment_id INT NULL;