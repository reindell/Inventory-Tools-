-- Accounts created directly by an Admin start with a temporary password.
-- The person must replace it at first sign-in; the flag clears when they do.
IF COL_LENGTH(N'dbo.users', N'must_change_password') IS NULL
 ALTER TABLE dbo.users ADD must_change_password bit NOT NULL CONSTRAINT DF_users_must_change_password DEFAULT 0;