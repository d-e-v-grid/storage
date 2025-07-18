-- Combined migration: Initial setup and core schema
-- Original migrations: 0001-initialmigration.sql, 0002-storage-schema.sql

-- Initial migration placeholder
SELECT 1;

-- Create storage schema and core tables
DO $$
BEGIN
    IF NOT EXISTS(SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'storage') THEN
        CREATE SCHEMA storage;
    END IF;
END$$;

-- Create roles and permissions
DO $$
DECLARE
    install_roles text = COALESCE(current_setting('storage.install_roles', true), 'true');
    anon_role text = COALESCE(current_setting('storage.anon_role', true), 'anon');
    authenticated_role text = COALESCE(current_setting('storage.authenticated_role', true), 'authenticated');
    service_role text = COALESCE(current_setting('storage.service_role', true), 'service_role');
BEGIN
    IF install_roles != 'true' THEN
        RETURN;
    END IF;

    -- Install ROLES
    EXECUTE 'CREATE ROLE ' || anon_role || ' NOLOGIN NOINHERIT';
    EXECUTE 'CREATE ROLE ' || authenticated_role || ' NOLOGIN NOINHERIT';
    EXECUTE 'CREATE ROLE ' || service_role || ' NOLOGIN NOINHERIT bypassrls';

    CREATE USER authenticator NOINHERIT;
    EXECUTE 'GRANT ' || anon_role || ' TO authenticator';
    EXECUTE 'GRANT ' || authenticated_role || ' TO authenticator';
    EXECUTE 'GRANT ' || service_role || ' TO authenticator';
    GRANT postgres TO authenticator;

    EXECUTE 'GRANT USAGE ON SCHEMA storage TO postgres,' ||  anon_role || ',' || authenticated_role || ',' || service_role;

    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT ALL ON TABLES TO postgres,' ||  anon_role || ',' || authenticated_role || ',' || service_role;
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT ALL ON FUNCTIONS TO postgres,' ||  anon_role || ',' || authenticated_role || ',' || service_role;
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT ALL ON SEQUENCES TO postgres,' ||  anon_role || ',' || authenticated_role || ',' || service_role;
END$$;

-- Create core tables
CREATE TABLE IF NOT EXISTS "storage"."migrations" (
    id integer PRIMARY KEY,
    name varchar(100) UNIQUE NOT NULL,
    hash varchar(40) NOT NULL, -- sha1 hex encoded hash of the file name and contents
    executed_at timestamp DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS "storage"."buckets" (
    "id" text NOT NULL,
    "name" text NOT NULL,
    "owner" uuid,
    "created_at" timestamptz DEFAULT now(),
    "updated_at" timestamptz DEFAULT now(),
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "bname" ON "storage"."buckets" USING BTREE ("name");

CREATE TABLE IF NOT EXISTS "storage"."objects" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "bucket_id" text,
    "name" text,
    "owner" uuid,
    "created_at" timestamptz DEFAULT now(),
    "updated_at" timestamptz DEFAULT now(),
    "last_accessed_at" timestamptz DEFAULT now(),
    "metadata" jsonb,
    CONSTRAINT "objects_bucketId_fkey" FOREIGN KEY ("bucket_id") REFERENCES "storage"."buckets"("id"),
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "bucketid_objname" ON "storage"."objects" USING BTREE ("bucket_id","name");
CREATE INDEX IF NOT EXISTS name_prefix_search ON storage.objects(name text_pattern_ops);

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Create utility functions
DROP FUNCTION IF EXISTS storage.foldername;
CREATE OR REPLACE FUNCTION storage.foldername(name text)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
DECLARE
_parts text[];
BEGIN
    SELECT string_to_array(name, '/') INTO _parts;
    RETURN _parts[1:array_length(_parts,1)-1];
END
$function$;

DROP FUNCTION IF EXISTS storage.filename;
CREATE OR REPLACE FUNCTION storage.filename(name text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
_parts text[];
BEGIN
    SELECT string_to_array(name, '/') INTO _parts;
    RETURN _parts[array_length(_parts,1)];
END
$function$;

DROP FUNCTION IF EXISTS storage.extension;
CREATE OR REPLACE FUNCTION storage.extension(name text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
_parts text[];
_filename text;
BEGIN
    SELECT string_to_array(name, '/') INTO _parts;
    SELECT _parts[array_length(_parts,1)] INTO _filename;
    RETURN reverse(split_part(reverse(_filename), '.', 1));
END
$function$;

-- Create initial search function
DROP FUNCTION IF EXISTS storage.search;
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
            SELECT ((string_to_array(objects.name, '/'))[levels]) AS folder
            FROM objects
            WHERE objects.name ILIKE prefix || '%'
            AND bucket_id = bucketname
            GROUP BY folder
            LIMIT limits
            OFFSET offsets
        ) 
        SELECT files_folders.folder AS name, objects.id, objects.updated_at, objects.created_at, objects.last_accessed_at, objects.metadata FROM files_folders 
        LEFT JOIN objects
        ON prefix || files_folders.folder = objects.name AND objects.bucket_id = bucketname;
END
$function$;

-- Set up super user permissions
DO $$
DECLARE
    install_roles text = COALESCE(current_setting('storage.install_roles', true), 'true');
    super_user text = COALESCE(current_setting('storage.super_user', true), 'supabase_storage_admin');
BEGIN
    IF install_roles != 'true' THEN
        RETURN;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = super_user) THEN
        EXECUTE 'CREATE USER ' || super_user || ' NOINHERIT CREATEROLE LOGIN NOREPLICATION';
    END IF;

    -- Grant privileges to Super User
    EXECUTE 'GRANT ALL PRIVILEGES ON SCHEMA storage TO ' || super_user;
    EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA storage TO ' || super_user;
    EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA storage TO ' || super_user;

    IF super_user != 'postgres' THEN
        EXECUTE 'ALTER USER ' || super_user || ' SET search_path = "storage"';
    END IF;

    EXECUTE 'ALTER TABLE "storage".objects OWNER TO ' || super_user;
    EXECUTE 'ALTER TABLE "storage".buckets OWNER TO ' || super_user;
    EXECUTE 'ALTER TABLE "storage".migrations OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".foldername(text) OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".filename(text) OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".extension(text) OWNER TO ' || super_user;
    EXECUTE 'ALTER FUNCTION "storage".search(text,text,int,int,int) OWNER TO ' || super_user;
END$$;