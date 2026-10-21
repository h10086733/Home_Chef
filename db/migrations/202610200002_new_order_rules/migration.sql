UPDATE "PlatformRule"
SET "data" = "data"::jsonb || jsonb_build_object(
  'autoConfirmHours', 48,
  'settlementTrigger', 'REVIEW_OR_EXPIRE',
  'settlementDelayHours', 0
);
