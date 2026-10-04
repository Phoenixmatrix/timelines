-- Preview provenance remains unset when AI creates an account's first settings row.
-- Preserve existing timestamps while removing the unrelated insertion-time default.
ALTER TABLE account_settings ADD COLUMN preview_saved_at TEXT;
UPDATE account_settings SET preview_saved_at = updated_at;
ALTER TABLE account_settings DROP COLUMN updated_at;
ALTER TABLE account_settings RENAME COLUMN preview_saved_at TO updated_at;

-- Account-wide automatic AI policy.
ALTER TABLE account_settings ADD COLUMN ai_knowledge INTEGER NOT NULL DEFAULT 1 CHECK (ai_knowledge IN (0, 1));
ALTER TABLE account_settings ADD COLUMN ai_wiki INTEGER NOT NULL DEFAULT 1 CHECK (ai_wiki IN (0, 1));
ALTER TABLE account_settings ADD COLUMN ai_atlas INTEGER NOT NULL DEFAULT 1 CHECK (ai_atlas IN (0, 1));
ALTER TABLE account_settings ADD COLUMN ai_release_notes INTEGER NOT NULL DEFAULT 1 CHECK (ai_release_notes IN (0, 1));
ALTER TABLE account_settings ADD COLUMN ai_classification_model TEXT NOT NULL DEFAULT 'clef' CHECK (ai_classification_model = 'clef');
ALTER TABLE account_settings ADD COLUMN ai_fast_model TEXT NOT NULL DEFAULT 'glm-5.3-flash' CHECK (ai_fast_model IN ('glm-5.3-flash', 'gemma-4-26b-a4b-it'));
ALTER TABLE account_settings ADD COLUMN ai_task_model TEXT NOT NULL DEFAULT 'glm-5.3-flash' CHECK (ai_task_model IN ('glm-5.3-flash', 'gemma-4-26b-a4b-it'));
ALTER TABLE account_settings ADD COLUMN ai_updated_by TEXT REFERENCES accounts (id) ON DELETE SET NULL;
ALTER TABLE account_settings ADD COLUMN ai_updated_at TEXT;

-- NULL on historical knowledge work means the explicit legacy policy, never live settings.
ALTER TABLE kg_builds ADD COLUMN ai_snapshot TEXT;
ALTER TABLE kg_page_sets ADD COLUMN ai_snapshot TEXT;

-- Release generations retain policy and input refs through continuation leases.
ALTER TABLE release_note_state ADD COLUMN ai_snapshot TEXT;
ALTER TABLE release_note_state ADD COLUMN lease_id TEXT;
ALTER TABLE release_note_state ADD COLUMN generation_refs TEXT;
UPDATE release_note_state
SET ai_snapshot = '{"version":1,"features":{"knowledge":true,"wiki":true,"atlas":true,"releaseNotes":true},"models":{"classification":"@cf/cloudflare/clef","fast":"@cf/zai-org/glm-5.3-flash","task":"@cf/qwen/qwen3.8-27b"},"updatedAt":null}'
-- 'generating' alone also describes an unstarted debounced request. A lease,
-- failure, or output newer than the last completion proves work actually started.
WHERE lease_until > 0 OR status = 'failed' OR (
  status = 'generating' AND EXISTS (
    SELECT 1 FROM release_notes
    WHERE release_notes.repo_id = release_note_state.repo_id
      AND release_notes.updated_at > COALESCE(release_note_state.generated_at, '')
  )
);
