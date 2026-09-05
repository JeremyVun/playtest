\set ON_ERROR_STOP on
\getenv pw PLAYTEST_DB_PASSWORD
\if :{?pw}
\else
\set pw ''
\endif
SELECT (:'pw' = '')::int AS pw_empty \gset
\if :pw_empty
DO $$ BEGIN RAISE EXCEPTION 'PLAYTEST_DB_PASSWORD is required'; END $$;
\endif
SELECT format('CREATE ROLE playtest LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'playtest')
\gexec
SELECT 'CREATE DATABASE playtest OWNER playtest'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'playtest')
\gexec
