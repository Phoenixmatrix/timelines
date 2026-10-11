-- Update only the original system-owned copy; preserve customized agent profiles.
UPDATE agents
SET description = 'Timelines'' built-in assistant, acting for you from chat and gm ask.'
WHERE name = 'assistant'
  AND description = 'Gitmatrix''s built-in assistant, acting for you from chat and gm ask.';
