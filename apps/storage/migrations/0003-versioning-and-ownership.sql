-- Combined migration: Versioning and ownership changes
-- Original migrations: 0016-0019 (add-version through alter-default-value-objects-id)

-- Add version column to objects table
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS version text DEFAULT null;

-- Drop owner foreign key constraint
ALTER TABLE storage.objects DROP CONSTRAINT IF EXISTS objects_owner_fkey;

-- Add owner_id columns to replace owner columns
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS owner_id text DEFAULT null;
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS owner_id text DEFAULT null;

-- Add deprecation comments
COMMENT ON COLUMN storage.objects.owner IS 'Field is deprecated, use owner_id instead';
COMMENT ON COLUMN storage.buckets.owner IS 'Field is deprecated, use owner_id instead';

-- Drop buckets owner foreign key constraint
ALTER TABLE storage.buckets DROP CONSTRAINT IF EXISTS buckets_owner_fkey;

-- Ensure objects.id has proper default value
ALTER TABLE storage.objects ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Update ownership for any new functions
DO $$
DECLARE
    super_user text = COALESCE(current_setting('storage.super_user', true), 'supabase_storage_admin');
BEGIN
    -- No new functions in this migration, but ensure existing functions are owned correctly
    NULL;
END$$;