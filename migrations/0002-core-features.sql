-- Combined migration: Core features and enhancements
-- Original migrations: 0003-0015 (pathtoken-column through add-can-insert-object-function)

-- Add path tokens column for improved search performance
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS path_tokens text[] GENERATED ALWAYS AS (string_to_array("name", '/')) STORED;

-- Update search function to use path tokens
CREATE OR REPLACE FUNCTION storage.search(prefix text, bucketname text, limits int DEFAULT 100, levels int DEFAULT 1, offsets int DEFAULT 0)
 RETURNS TABLE (
    name text,
    id uuid,
    updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ,
    last_accessed_at TIMESTAMPTZ,
    metadata jsonb
  )
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY 
        WITH files_folders AS (
            SELECT path_tokens[levels] AS folder
            FROM storage.objects
            WHERE objects.name ILIKE prefix || '%'
            AND bucket_id = bucketname
            GROUP BY folder
            LIMIT limits
            OFFSET offsets
        ) 
        SELECT files_folders.folder AS name, objects.id, objects.updated_at, objects.created_at, objects.last_accessed_at, objects.metadata FROM files_folders 
        LEFT JOIN storage.objects
        ON prefix || files_folders.folder = objects.name
        WHERE objects.id IS NULL OR objects.bucket_id = bucketname;
END
$function$;

-- Enable RLS on migrations table
ALTER TABLE storage.migrations ENABLE ROW LEVEL SECURITY;

-- Add size calculation functions
CREATE OR REPLACE FUNCTION storage.get_size_by_bucket()
 RETURNS TABLE (
    size bigint,
    bucket_id text
  )
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
        SELECT SUM((metadata->>'size')::int) AS size, objects.bucket_id
        FROM storage.objects
        GROUP BY objects.bucket_id;
END
$function$;

-- Fix column name in get_size function
CREATE OR REPLACE FUNCTION storage.get_size_by_bucket()
 RETURNS TABLE (
    size bigint,
    bucket_id text
  )
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
        SELECT SUM((metadata->>'size')::bigint) AS size, objects.bucket_id
        FROM storage.objects
        GROUP BY objects.bucket_id;
END
$function$;

-- Enable RLS on buckets table
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;

-- Add public column to buckets
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS "public" boolean DEFAULT false;

-- Improved search function with better performance
CREATE OR REPLACE FUNCTION storage.search(prefix text, bucketname text, limits int DEFAULT 100, levels int DEFAULT 1, offsets int DEFAULT 0, search text DEFAULT ''::text)
 RETURNS TABLE (
    name text,
    id uuid,
    updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ,
    last_accessed_at TIMESTAMPTZ,
    metadata jsonb
  )
 LANGUAGE plpgsql
AS $function$
DECLARE
    _bucketname text;
    _prefix text;
    _search text;
    _levels int;
BEGIN
    _bucketname := bucketname;
    _prefix := prefix;
    _search := search;
    _levels := levels;
    
    RETURN QUERY
        WITH files_folders AS (
            SELECT path_tokens[_levels] AS folder
            FROM storage.objects
            WHERE objects.name ILIKE _prefix || '%'
            AND bucket_id = _bucketname
            AND (_search = '' OR objects.name ILIKE '%' || _search || '%')
            GROUP BY folder
            LIMIT limits
            OFFSET offsets
        ) 
        SELECT files_folders.folder AS name, objects.id, objects.updated_at, objects.created_at, objects.last_accessed_at, objects.metadata FROM files_folders 
        LEFT JOIN storage.objects
        ON _prefix || files_folders.folder = objects.name
        WHERE objects.id IS NULL OR objects.bucket_id = _bucketname;
END
$function$;

-- Add search function for files
CREATE OR REPLACE FUNCTION storage.search_files(prefix text, bucketname text, limits int DEFAULT 100, levels int DEFAULT 1, offsets int DEFAULT 0, search text DEFAULT ''::text)
 RETURNS TABLE (
    name text,
    id uuid,
    updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ,
    last_accessed_at TIMESTAMPTZ,
    metadata jsonb
  )
 LANGUAGE plpgsql
AS $function$
DECLARE
    _bucketname text;
    _prefix text;
    _search text;
    _levels int;
BEGIN
    _bucketname := bucketname;
    _prefix := prefix;
    _search := search;
    _levels := levels;
    
    RETURN QUERY
        SELECT objects.name, objects.id, objects.updated_at, objects.created_at, objects.last_accessed_at, objects.metadata
        FROM storage.objects
        WHERE objects.name ILIKE _prefix || '%'
        AND bucket_id = _bucketname
        AND (_search = '' OR objects.name ILIKE '%' || _search || '%')
        AND array_length(path_tokens, 1) = _levels
        ORDER BY objects.name
        LIMIT limits
        OFFSET offsets;
END
$function$;

-- Add trigger to auto-update updated_at column
CREATE OR REPLACE FUNCTION storage.update_updated_at_column()
 RETURNS TRIGGER 
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$;

CREATE TRIGGER update_objects_updated_at 
    BEFORE UPDATE ON storage.objects 
    FOR EACH ROW 
    EXECUTE FUNCTION storage.update_updated_at_column();

CREATE TRIGGER update_buckets_updated_at 
    BEFORE UPDATE ON storage.buckets 
    FOR EACH ROW 
    EXECUTE FUNCTION storage.update_updated_at_column();

-- Add AVIF autodetection flag to buckets
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS avif_autodetection bool DEFAULT false;

-- Add bucket custom limits
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS file_size_limit bigint;
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS allowed_mime_types text[];

-- Use bytes for max size instead of previous units
-- This is handled by the file_size_limit column above

-- Add function to check if object can be inserted
CREATE OR REPLACE FUNCTION storage.can_insert_object(bucketid text, name text, owner uuid, metadata jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
    bucket_file_size_limit bigint;
    bucket_allowed_mime_types text[];
    _file_size bigint;
    _mime_type text;
BEGIN
    SELECT file_size_limit, allowed_mime_types INTO bucket_file_size_limit, bucket_allowed_mime_types
    FROM storage.buckets
    WHERE id = bucketid;

    _file_size := (metadata->>'size')::bigint;
    _mime_type := metadata->>'mimetype';

    -- Check file size limit
    IF bucket_file_size_limit IS NOT NULL AND _file_size > bucket_file_size_limit THEN
        RAISE EXCEPTION 'File size exceeds bucket limit';
    END IF;

    -- Check allowed mime types
    IF bucket_allowed_mime_types IS NOT NULL AND NOT (_mime_type = ANY(bucket_allowed_mime_types)) THEN
        RAISE EXCEPTION 'File type not allowed in bucket';
    END IF;
END
$function$;

-- Update ownership for new functions
DO $$
DECLARE
    super_user text = COALESCE(current_setting('storage.super_user', true), 'supabase_storage_admin');
BEGIN
    EXECUTE 'ALTER FUNCTION "storage".get_size_by_bucket() OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".search_files(text,text,int,int,int,text) OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".update_updated_at_column() OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".can_insert_object(text,text,uuid,jsonb) OWNER TO ' || super_user;
END$$;