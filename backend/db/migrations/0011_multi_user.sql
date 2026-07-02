-- Multi-user support (td-d3af9d).
-- Roles become admin | user | viewer:
--   admin  — full data-owning account + user management in /settings
--   user   — full data-owning account, no user management
--   viewer — read-only view of one admin/user account's trips, linked
--            via views_user_id (column name matches the birds repo)
-- trips.owner_id / packing_templates.owner_id keep their names; they point
-- at the owning admin/user account.

ALTER TABLE users
    ADD COLUMN views_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

-- Role migration: the single existing 'owner' becomes 'admin'; future
-- data-owning accounts are created as 'user'.
ALTER TABLE users DROP CONSTRAINT users_role_check;
UPDATE users SET role = 'admin' WHERE role = 'owner';
ALTER TABLE users
    ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'user', 'viewer'));
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';

-- Existing viewers were implicitly viewers of "the owner" — make it explicit.
UPDATE users
   SET views_user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
 WHERE role = 'viewer';

-- Only and always viewers carry the link. (Added after the backfill.)
ALTER TABLE users
    ADD CONSTRAINT users_views_matches_role
    CHECK ((role = 'viewer') = (views_user_id IS NOT NULL));

-- Cross-row integrity the CHECK can't express (a CHECK sees one row only):
--   * a viewer must view an admin/user account, never another viewer or itself;
--   * an account can't become a viewer while it still owns trips or packing
--     templates, or while other viewers point at it (no "trips owned by a
--     viewer", no dangling viewer chains).
-- The app re-checks these for friendly errors; this trigger is the backstop.
CREATE OR REPLACE FUNCTION enforce_users_role_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_role TEXT;
BEGIN
    IF NEW.views_user_id IS NOT NULL THEN
        IF NEW.views_user_id = NEW.id THEN
            RAISE EXCEPTION 'a viewer cannot view itself (user id %)', NEW.id;
        END IF;
        SELECT role INTO target_role FROM users WHERE id = NEW.views_user_id;
        IF target_role IS NULL OR target_role NOT IN ('admin', 'user') THEN
            RAISE EXCEPTION
                'views_user_id % must reference an admin or user account (found %)',
                NEW.views_user_id, COALESCE(target_role, 'no row');
        END IF;
    END IF;

    IF NEW.role = 'viewer'
       AND (TG_OP = 'INSERT' OR OLD.role IS DISTINCT FROM NEW.role) THEN
        IF EXISTS (SELECT 1 FROM trips WHERE owner_id = NEW.id) THEN
            RAISE EXCEPTION
                'cannot make user % a viewer: it still owns trips', NEW.id;
        END IF;
        IF EXISTS (SELECT 1 FROM packing_templates WHERE owner_id = NEW.id) THEN
            RAISE EXCEPTION
                'cannot make user % a viewer: it still owns packing templates', NEW.id;
        END IF;
        IF EXISTS (SELECT 1 FROM users WHERE views_user_id = NEW.id AND id <> NEW.id) THEN
            RAISE EXCEPTION
                'cannot make user % a viewer: other viewers point at it', NEW.id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER users_role_integrity
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION enforce_users_role_integrity();
