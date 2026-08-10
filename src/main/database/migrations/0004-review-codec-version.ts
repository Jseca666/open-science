/* Immutable 0004 migration snapshot. Do not regenerate after release. */

// Existing Review rows predate the persistence codec. Version 0 selects the legacy decoder while
// new and rewritten rows are stamped with the current codec version by ReviewRepository.
const reviewCodecVersionMigration = {
  id: '0004_review_codec_version',
  statements: [
    `ALTER TABLE "Review" ADD COLUMN "codecVersion" INTEGER NOT NULL DEFAULT 0`
  ] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'Review',
      column: 'codecVersion'
    }
  ] as const
}

export { reviewCodecVersionMigration }
