-- Combined migration: Advanced features
-- Original migrations: 0020-0026 (list-objects-with-delimiter through object-bucket-name-sorting)

-- List objects with delimiter function
CREATE OR REPLACE FUNCTION storage.list_objects_with_delimiter(bucket_id text, prefix_param text, delimiter_param text, max_keys integer DEFAULT 100, start_after text DEFAULT '', next_token text DEFAULT '')
    RETURNS TABLE (name text, id uuid, metadata jsonb, updated_at timestamptz) AS
$$
BEGIN
    RETURN QUERY EXECUTE
        'SELECT DISTINCT ON(name COLLATE "C") * FROM (
            SELECT
                CASE
                    WHEN position($2 IN substring(name from length($1) + 1)) > 0 THEN
                        substring(name from 1 for length($1) + position($2 IN substring(name from length($1) + 1)))
                    ELSE
                        name
                END AS name, id, metadata, updated_at
            FROM
                storage.objects
            WHERE
                bucket_id = $5 AND
                name ILIKE $1 || ''%'' AND
                CASE
                    WHEN $6 != '''' THEN
                    name COLLATE "C" > $6
                ELSE true END
                AND CASE
                    WHEN $4 != '''' THEN
                        CASE
                            WHEN position($2 IN substring(name from length($1) + 1)) > 0 THEN
                                substring(name from 1 for length($1) + position($2 IN substring(name from length($1) + 1))) COLLATE "C" > $4
                            ELSE
                                name COLLATE "C" > $4
                            END
                    ELSE
                        true
                END
            ORDER BY
                name COLLATE "C" ASC) AS e ORDER BY name COLLATE "C" LIMIT $3'
        USING prefix_param, delimiter_param, max_keys, next_token, bucket_id, start_after;
END;
$$ LANGUAGE plpgsql;

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_objects_bucket_id_name
    ON storage.objects (bucket_id, (name COLLATE "C"));

-- Optimize search function
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
        SELECT objects.name, objects.id, objects.updated_at, objects.created_at, objects.last_accessed_at, objects.metadata
        FROM storage.objects
        WHERE objects.name ILIKE _prefix || '%'
        AND bucket_id = _bucketname
        AND (_search = '' OR objects.name ILIKE '%' || _search || '%')
        AND array_length(path_tokens, 1) = _levels
        ORDER BY objects.name COLLATE "C"
        LIMIT limits
        OFFSET offsets;
END
$function$;

-- Operation function for better performance
CREATE OR REPLACE FUNCTION storage.operation()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
    operation_id text;
BEGIN
    SELECT coalesce(current_setting('storage.operation', true), '') INTO operation_id;
    RETURN operation_id;
END
$function$;

-- Add custom metadata column
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS user_metadata jsonb NULL;

-- Search v2 function with better performance
CREATE OR REPLACE FUNCTION storage.search_v2 (
    prefix text,
    bucket_name text,
    limits int DEFAULT 100,
    levels int DEFAULT 1,
    start_after text DEFAULT ''
) RETURNS TABLE (
    key text,
    name text,
    id uuid,
    updated_at timestamptz,
    created_at timestamptz,
    metadata jsonb
)
SECURITY INVOKER
AS $func$
BEGIN
    RETURN QUERY EXECUTE
        $sql$
        SELECT * FROM (
            SELECT split_part(name, '/', $4) AS key,
                name,
                id,
                updated_at,
                created_at,
                metadata
            FROM storage.objects
            WHERE name COLLATE "C" LIKE $1 || '%'
                AND bucket_id = $2
                AND level = $4
                AND name COLLATE "C" > $5
            ORDER BY name COLLATE "C" LIMIT $3
        ) obj
        ORDER BY name COLLATE "C" LIMIT $3;
        $sql$
        USING prefix, bucket_name, limits, levels, start_after;
END;
$func$ LANGUAGE plpgsql STABLE;

-- Object bucket name sorting improvements
CREATE INDEX IF NOT EXISTS idx_objects_bucket_name_sort
    ON storage.objects (bucket_id, name COLLATE "C");

-- Update ownership for new functions
DO $$
DECLARE
    super_user text = COALESCE(current_setting('storage.super_user', true), 'supabase_storage_admin');
BEGIN
    EXECUTE 'ALTER FUNCTION "storage".list_objects_with_delimiter(text,text,text,integer,text,text) OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".operation() OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".search_v2(text,text,int,int,text) OWNER TO ' || super_user;
END$$;