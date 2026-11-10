-- Accounts created directly by an Admin start with a temporary password.
-- The person must replace it at first sign-in; the flag clears when they do.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;