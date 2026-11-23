-- Extensions an admin turned updates off for: not counted as updates, skipped by "Update all" and
-- automatic updates, and never installed until turned on again. Rolling back still works.
CREATE TABLE dev_caloptreyx_updater_updates_off (
    package_name VARCHAR(255) NOT NULL PRIMARY KEY,
    user_uuid uuid,
    created TIMESTAMPTZ NOT NULL DEFAULT now()
);
