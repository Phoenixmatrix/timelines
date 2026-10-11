-- CORE-359: highlights exist only for organizations; drop the site and repository summaries.
DELETE FROM release_highlights WHERE scope <> 'tracker';
