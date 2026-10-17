# Connecting a PostgreSQL database read-only

DataSentinel only reads. Give it its own login that can read the tables you want checked and nothing else. Run these statements as a database owner or superuser, then add the source in **Data sources → Add source → PostgreSQL database (read-only)**.

## 1. Create the login

```sql
-- A long random password; store it only in DataSentinel.
CREATE ROLE datasentinel_reader LOGIN PASSWORD 'replace-with-a-long-random-password';

-- Every session is read-only, even if a grant is too wide by mistake.
ALTER ROLE datasentinel_reader SET default_transaction_read_only = on;
-- Stop runaway queries and idle sessions (DataSentinel also sets 30 s itself).
ALTER ROLE datasentinel_reader SET statement_timeout = '30s';
ALTER ROLE datasentinel_reader SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE datasentinel_reader CONNECTION LIMIT 5;
```

## 2. Grant read access to what should be checked

Replace `analytics` with your database and `public` with each schema to check.

```sql
GRANT CONNECT ON DATABASE analytics TO datasentinel_reader;
\c analytics
GRANT USAGE ON SCHEMA public TO datasentinel_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO datasentinel_reader;
-- Tables created later in this schema by the role running this:
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO datasentinel_reader;
```

Prefer granting a few schemas, or a few tables, over a whole database. On PostgreSQL 14 and newer, `GRANT pg_read_all_data TO datasentinel_reader;` reads everything; use it only for a demo.

Never grant `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE`, ownership, `SUPERUSER`, `CREATEROLE`, or membership in a role that has them.

## 3. Network and TLS

- Allow connections from DataSentinel's outbound address to the database port (usually 5432) and nothing else.
- Use TLS. In DataSentinel choose **Verify certificate** (checks the certificate and host name). **Require encryption** only encrypts; use it only when the server's certificate cannot be verified. **None** is accepted only on local development installs.
- DataSentinel refuses private, loopback, and link-local addresses on production installs (D-48). A database inside a private network needs a public endpoint with an allow-list, or a self-hosted DataSentinel.

## 4. Check it

After adding the source, select **Test connection**. A wrong password shows "The source rejected the username or password"; a firewall or wrong host shows "DataSentinel could not reach the source".

## 5. Demo database (local development)

The local services already run PostgreSQL. To try the connector against it:

```sql
CREATE DATABASE demo_shop;
\c demo_shop
CREATE TABLE orders (id bigint PRIMARY KEY, customer text, total numeric(10,2), placed_at timestamptz);
INSERT INTO orders VALUES (1, 'Ada', 42.50, now()), (2, 'Grace', NULL, now());
CREATE ROLE demo_reader LOGIN PASSWORD 'demo-reader-local-only';
ALTER ROLE demo_reader SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE demo_shop TO demo_reader;
GRANT USAGE ON SCHEMA public TO demo_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO demo_reader;
```

Then add a source with host `localhost`, port `5432`, database `demo_shop`, encryption **None**, and the `demo_reader` login.

## 6. Rotating the password

Change it in PostgreSQL (`ALTER ROLE datasentinel_reader PASSWORD '…'`), then replace it in DataSentinel with **Rotate credentials** on the source (Phase G). Revoke access with `REVOKE ALL … FROM datasentinel_reader; DROP ROLE datasentinel_reader;`.
