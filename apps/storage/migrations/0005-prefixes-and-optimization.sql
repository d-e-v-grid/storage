-- Combined migration: Prefixes system and optimizations
-- Original migrations: 0027-0035 (create-prefixes through add-bucket-name-length-trigger)

-- Add level column to objects
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS level INT NULL;

-- Index Functions
CREATE OR REPLACE FUNCTION "storage"."get_level"("name" text)
    RETURNS int
AS $func$
SELECT array_length(string_to_array("name", '/'), 1);
$func$ LANGUAGE SQL IMMUTABLE STRICT;

-- Create prefixes table
CREATE TABLE IF NOT EXISTS "storage"."prefixes" (
    "bucket_id" text,
    "name" text COLLATE "C" NOT NULL,
    "level" int GENERATED ALWAYS AS ("storage"."get_level"("name")) STORED,
    "created_at" timestamptz DEFAULT now(),
    "updated_at" timestamptz DEFAULT now(),
    CONSTRAINT "prefixes_bucketId_fkey" FOREIGN KEY ("bucket_id") REFERENCES "storage"."buckets"("id"),
    PRIMARY KEY ("bucket_id", "level", "name")
);

ALTER TABLE storage.prefixes ENABLE ROW LEVEL SECURITY;

-- Prefix utility functions
CREATE OR REPLACE FUNCTION "storage"."get_prefix"("name" text)
    RETURNS text
AS $func$
SELECT
    CASE WHEN strpos("name", '/') > 0 THEN
             regexp_replace("name", '[\/]{1}[^\/]+\/?$', '')
         ELSE
             ''
        END;
$func$ LANGUAGE SQL IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION "storage"."get_prefixes"("name" text)
    RETURNS text[]
AS $func$
DECLARE
    parts text[];
    prefixes text[];
    prefix text;
BEGIN
    -- Split the name into parts by '/'
    parts := string_to_array("name", '/');
    prefixes := '{}';

    -- Construct the prefixes, stopping one level below the last part
    FOR i IN 1..array_length(parts, 1) - 1 LOOP
            prefix := array_to_string(parts[1:i], '/');
            prefixes := array_append(prefixes, prefix);
    END LOOP;

    RETURN prefixes;
END;
$func$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION "storage"."add_prefixes"(
    "_bucket_id" TEXT,
    "_name" TEXT
)
RETURNS void
SECURITY DEFINER
AS $func$
DECLARE
    prefixes text[];
BEGIN
    prefixes := "storage"."get_prefixes"("_name");

    IF array_length(prefixes, 1) > 0 THEN
        INSERT INTO storage.prefixes (name, bucket_id)
        SELECT UNNEST(prefixes) AS name, "_bucket_id" ON CONFLICT DO NOTHING;
    END IF;
END;
$func$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION "storage"."delete_prefix" (
    "_bucket_id" TEXT,
    "_name" TEXT
) RETURNS boolean
SECURITY DEFINER
AS $func$
BEGIN
    -- Check if we can delete the prefix
    IF EXISTS(
        SELECT FROM "storage"."prefixes"
        WHERE "prefixes"."bucket_id" = "_bucket_id"
          AND level = "storage"."get_level"("_name") + 1
          AND "prefixes"."name" COLLATE "C" LIKE "_name" || '/%'
        LIMIT 1
    )
    OR EXISTS(
        SELECT FROM "storage"."objects"
        WHERE "objects"."bucket_id" = "_bucket_id"
          AND "storage"."get_level"("objects"."name") = "storage"."get_level"("_name") + 1
          AND "objects"."name" COLLATE "C" LIKE "_name" || '/%'
        LIMIT 1
    ) THEN
    -- There are sub-objects, skip deletion
    RETURN false;
    ELSE
        DELETE FROM "storage"."prefixes"
        WHERE "prefixes"."bucket_id" = "_bucket_id"
          AND level = "storage"."get_level"("_name")
          AND "prefixes"."name" = "_name";
        RETURN true;
    END IF;
END;
$func$ LANGUAGE plpgsql VOLATILE;

-- Update object levels based on name
UPDATE storage.objects SET level = "storage"."get_level"("name") WHERE level IS NULL;

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS objects_level_index ON storage.objects (bucket_id, level, name COLLATE "C");
CREATE INDEX IF NOT EXISTS prefixes_level_index ON storage.prefixes (bucket_id, level, name COLLATE "C");

-- Backward compatible indexes
CREATE INDEX IF NOT EXISTS idx_objects_bucket_id_name_level 
    ON storage.objects (bucket_id, name COLLATE "C", level);

CREATE INDEX IF NOT EXISTS idx_prefixes_bucket_id_name_level 
    ON storage.prefixes (bucket_id, name COLLATE "C", level);

-- Optimize search function v1
CREATE OR REPLACE FUNCTION storage.search_v1 (
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
            (
                SELECT
                    split_part(name, '/', $4) AS key,
                    name || '/' AS name,
                    NULL::uuid AS id,
                    NULL::timestamptz AS updated_at,
                    NULL::timestamptz AS created_at,
                    NULL::jsonb AS metadata
                FROM storage.prefixes
                WHERE name COLLATE "C" LIKE $1 || '%'
                AND bucket_id = $2
                AND level = $4
                AND name COLLATE "C" > $5
                ORDER BY prefixes.name COLLATE "C" LIMIT $3
            )
            UNION ALL
            (SELECT split_part(name, '/', $4) AS key,
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
            ORDER BY name COLLATE "C" LIMIT $3)
        ) obj
        ORDER BY name COLLATE "C" LIMIT $3;
        $sql$
        USING prefix, bucket_name, limits, levels, start_after;
END;
$func$ LANGUAGE plpgsql STABLE;

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

-- Create index for list_objects_with_delimiter
CREATE INDEX IF NOT EXISTS idx_objects_bucket_id_name
    ON storage.objects (bucket_id, (name COLLATE "C"));

-- Trigger functions for prefix management
CREATE OR REPLACE FUNCTION "storage"."prefixes_insert_trigger"()
    RETURNS trigger
AS $func$
BEGIN
    PERFORM "storage"."add_prefixes"(NEW."bucket_id", NEW."name");
    RETURN NEW;
END;
$func$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION "storage"."objects_insert_prefix_trigger"()
    RETURNS trigger
AS $func$
BEGIN
    PERFORM "storage"."add_prefixes"(NEW."bucket_id", NEW."name");
    NEW.level := "storage"."get_level"(NEW."name");
    RETURN NEW;
END;
$func$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION "storage"."delete_prefix_hierarchy_trigger"()
    RETURNS trigger
AS $func$
DECLARE
    prefix text;
BEGIN
    prefix := "storage"."get_prefix"(OLD."name");

    IF coalesce(prefix, '') != '' THEN
        PERFORM "storage"."delete_prefix"(OLD."bucket_id", prefix);
    END IF;

    RETURN OLD;
END;
$func$ LANGUAGE plpgsql VOLATILE;

-- Add insert trigger for prefixes
CREATE OR REPLACE TRIGGER "add_insert_trigger_prefixes"
    BEFORE INSERT ON "storage"."prefixes"
    FOR EACH ROW
EXECUTE FUNCTION "storage"."prefixes_insert_trigger"();

-- Create triggers for prefix management
CREATE OR REPLACE TRIGGER "prefixes_delete_hierarchy"
    AFTER DELETE ON "storage"."prefixes"
    FOR EACH ROW
EXECUTE FUNCTION "storage"."delete_prefix_hierarchy_trigger"();

CREATE OR REPLACE TRIGGER "objects_insert_create_prefix"
    BEFORE INSERT ON "storage"."objects"
    FOR EACH ROW
EXECUTE FUNCTION "storage"."objects_insert_prefix_trigger"();

CREATE OR REPLACE TRIGGER "objects_update_create_prefix"
    BEFORE UPDATE ON "storage"."objects"
    FOR EACH ROW
    WHEN (NEW.name != OLD.name)
EXECUTE FUNCTION "storage"."objects_insert_prefix_trigger"();

CREATE OR REPLACE TRIGGER "objects_delete_delete_prefix"
    AFTER DELETE ON "storage"."objects"
    FOR EACH ROW
EXECUTE FUNCTION "storage"."delete_prefix_hierarchy_trigger"();

-- Optimize existing functions for better performance
CREATE OR REPLACE FUNCTION storage.search(prefix text, bucketname text, limits int DEFAULT 100, levels int DEFAULT 1, offsets int DEFAULT 0, search text DEFAULT ''::text, sortcolumn text DEFAULT 'name', sortorder text DEFAULT 'asc')
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
  v_order_by text;
  v_sort_order text;
BEGIN
  CASE
    WHEN sortcolumn = 'name' THEN
      v_order_by = 'name';
    WHEN sortcolumn = 'updated_at' THEN
      v_order_by = 'updated_at';
    WHEN sortcolumn = 'created_at' THEN
      v_order_by = 'created_at';
    WHEN sortcolumn = 'last_accessed_at' THEN
      v_order_by = 'last_accessed_at';
    ELSE
      v_order_by = 'name';
  END CASE;

  CASE
    WHEN sortorder = 'asc' THEN
      v_sort_order = 'asc';
    WHEN sortorder = 'desc' THEN
      v_sort_order = 'desc';
    ELSE
      v_sort_order = 'asc';
  END CASE;

  v_order_by = v_order_by || ' ' || v_sort_order;

  RETURN QUERY EXECUTE
    'WITH folders AS (
       SELECT path_tokens[$1] AS folder
       FROM storage.objects
         WHERE objects.name ILIKE $2 || $3 || ''%''
           AND bucket_id = $4
           AND array_length(regexp_split_to_array(objects.name, ''/''), 1) <> $1
       GROUP BY folder
       ORDER BY folder ' || v_sort_order || '
     )
     (SELECT folder AS "name",
            NULL AS id,
            NULL AS updated_at,
            NULL AS created_at,
            NULL AS last_accessed_at,
            NULL AS metadata FROM folders)
     UNION ALL
     (SELECT path_tokens[$1] AS "name",
            id,
            updated_at,
            created_at,
            last_accessed_at,
            metadata
     FROM storage.objects
     WHERE objects.name ILIKE $2 || $3 || ''%''
       AND bucket_id = $4
       AND array_length(regexp_split_to_array(objects.name, ''/''), 1) = $1
     ORDER BY ' || v_order_by || ')
     LIMIT $5
     OFFSET $6' USING levels, prefix, search, bucketname, limits, offsets;
END;
$function$;

-- Add bucket name length validation
CREATE OR REPLACE FUNCTION storage.enforce_bucket_name_length()
RETURNS trigger AS $$
BEGIN
    IF length(new.name) > 100 THEN
        RAISE EXCEPTION 'bucket name "%" is too long (% characters). Max is 100.', new.name, length(new.name);
    END IF;
    RETURN new;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_bucket_name_length_trigger ON storage.buckets;
CREATE TRIGGER enforce_bucket_name_length_trigger
BEFORE INSERT OR UPDATE OF name ON storage.buckets
FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_name_length();

-- Grant permissions on prefixes table
DO $$
    DECLARE
        anon_role text = COALESCE(current_setting('storage.anon_role', true), 'anon');
        authenticated_role text = COALESCE(current_setting('storage.authenticated_role', true), 'authenticated');
        service_role text = COALESCE(current_setting('storage.service_role', true), 'service_role');
    BEGIN
        EXECUTE 'GRANT ALL ON TABLE storage.prefixes TO ' || service_role || ',' || authenticated_role || ', ' || anon_role;
END$$;

-- Update ownership for new functions
DO $$
DECLARE
    super_user text = COALESCE(current_setting('storage.super_user', true), 'supabase_storage_admin');
BEGIN
    EXECUTE 'ALTER FUNCTION "storage".get_level(text) OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".get_prefix(text) OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".get_prefixes(text) OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".add_prefixes(text,text) OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".delete_prefix(text,text) OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".search(text,text,int,int,int,text,text,text) OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".search_v1(text,text,int,int,text) OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".list_objects_with_delimiter(text,text,text,int,text,text) OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".prefixes_insert_trigger() OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".objects_insert_prefix_trigger() OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".delete_prefix_hierarchy_trigger() OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".enforce_bucket_name_length() OWNER TO ' || super_user;
    EXECUTE 'ALTER TABLE "storage".prefixes OWNER TO ' || super_user;
END$$;