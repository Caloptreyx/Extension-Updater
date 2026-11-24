-- Release versions an admin chose to skip per extension: hidden from the banner, "Update all"
-- and automatic updates until a newer release is published or the skip is cleared.
CREATE TABLE dev_caloptreyx_updater_skipped (
    package_name VARCHAR(255) NOT NULL PRIMARY KEY,
    version VARCHAR(255) NOT NULL,
    user_uuid uuid,
    updated TIMESTAMPTZ NOT NULL DEFAULT now()
);
