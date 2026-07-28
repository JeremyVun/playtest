-- One environment serves one driver. A web deployment ring must never acquire
-- Appium/device state because a mobile suite happened to select it.
--
-- Existing URL-bearing rings are web even if the old suite setup bug also
-- wrote mobile keys or uploaded an artifact to them. This deliberately repairs
-- that ambiguous case in favor of the ring's pre-existing web destination.
ALTER TABLE environments
  ADD COLUMN driver TEXT NOT NULL DEFAULT 'web'
  CHECK (driver IN ('web', 'api', 'mobile'));

UPDATE environments
   SET driver = 'mobile'
 WHERE COALESCE(NULLIF(trim(json_extract(config, '$.app.base_url')), ''), '') = ''
   AND (
     COALESCE(NULLIF(trim(json_extract(config, '$.app.platform')), ''), '') <> ''
     OR COALESCE(NULLIF(trim(json_extract(config, '$.app.app')), ''), '') <> ''
     OR COALESCE(NULLIF(trim(json_extract(config, '$.app.appium_url')), ''), '') <> ''
     OR COALESCE(NULLIF(trim(json_extract(config, '$.app.device')), ''), '') <> ''
     OR app_artifact IS NOT NULL
   );

CREATE INDEX environments_project_driver_idx
  ON environments(project_id, driver);
