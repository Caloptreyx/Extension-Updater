-- GitHub answers (repository list, release lists, Metadata.toml of release tags) with their ETag
-- or feed fingerprint, plus the updater's own scheduling state. Kept in the database because every
-- update restarts the panel, and an unauthenticated panel only gets 60 GitHub API requests an hour.
CREATE TABLE dev_caloptreyx_updater_cache (
    key VARCHAR(255) NOT NULL PRIMARY KEY,
    etag VARCHAR(255),
    fingerprint VARCHAR(255),
    value TEXT NOT NULL,
    updated TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The archive each extension had before the updater last replaced it: put back when the rebuild
-- fails, and offered as "Roll back". An empty archive means the extension was not installed.
CREATE TABLE dev_caloptreyx_updater_backups (
    package_name VARCHAR(255) NOT NULL PRIMARY KEY,
    version VARCHAR(255) NOT NULL,
    archive BYTEA NOT NULL,
    sha256 CHAR(64) NOT NULL,
    saved TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per batch of archives installed with one rebuild, and how it ended.
CREATE TABLE dev_caloptreyx_updater_runs (
    id BIGSERIAL PRIMARY KEY,
    user_uuid uuid,
    automatic BOOLEAN NOT NULL DEFAULT false,
    kind VARCHAR(31) NOT NULL,
    items TEXT NOT NULL,
    build_id BIGINT,
    after_build_id BIGINT,
    state VARCHAR(31) NOT NULL,
    message TEXT,
    failed_extensions TEXT NOT NULL DEFAULT '[]',
    created TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished TIMESTAMPTZ
);

CREATE INDEX dev_caloptreyx_updater_runs_state_idx ON dev_caloptreyx_updater_runs (state);
