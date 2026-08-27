const literaturePersistenceIndexes = [
  {
    name: 'LiteratureExtraction_uploadVersionId_state_idx',
    sql: `CREATE INDEX "LiteratureExtraction_uploadVersionId_state_idx" ON "LiteratureExtraction"("uploadVersionId", "state")`
  },
  {
    name: 'LiteratureExtraction_indexState_lastAccessedAt_idx',
    sql: `CREATE INDEX "LiteratureExtraction_indexState_lastAccessedAt_idx" ON "LiteratureExtraction"("indexState", "lastAccessedAt")`
  },
  {
    name: 'LiteratureExtraction_uploadVersionId_extractorFingerprint_extractionSchemaVersion_key',
    sql: `CREATE UNIQUE INDEX "LiteratureExtraction_uploadVersionId_extractorFingerprint_extractionSchemaVersion_key" ON "LiteratureExtraction"("uploadVersionId", "extractorFingerprint", "extractionSchemaVersion")`
  },
  {
    name: 'LiteratureEvidence_projectId_sessionId_sourceMessageId_idx',
    sql: `CREATE INDEX "LiteratureEvidence_projectId_sessionId_sourceMessageId_idx" ON "LiteratureEvidence"("projectId", "sessionId", "sourceMessageId")`
  },
  {
    name: 'LiteratureEvidence_uploadVersionId_idx',
    sql: `CREATE INDEX "LiteratureEvidence_uploadVersionId_idx" ON "LiteratureEvidence"("uploadVersionId")`
  },
  {
    name: 'LiteratureEvidence_extractionId_idx',
    sql: `CREATE INDEX "LiteratureEvidence_extractionId_idx" ON "LiteratureEvidence"("extractionId")`
  },
  {
    name: 'LiteratureEvidence_documentChecksum_pageStart_idx',
    sql: `CREATE INDEX "LiteratureEvidence_documentChecksum_pageStart_idx" ON "LiteratureEvidence"("documentChecksum", "pageStart")`
  }
] as const

const extractionChecks = [
  {
    name: 'LiteratureExtraction_state_check',
    expression: `"state" IN ('queued', 'extracting', 'ready', 'partial', 'failed')`
  },
  {
    name: 'LiteratureExtraction_textOrigin_check',
    expression: `"textOrigin" IS NULL OR "textOrigin" IN ('embedded', 'ocr', 'hybrid')`
  },
  {
    name: 'LiteratureExtraction_indexState_check',
    expression: `"indexState" IN ('absent', 'queued', 'building', 'ready', 'failed')`
  },
  {
    name: 'LiteratureExtraction_checksum_check',
    expression: `length("documentChecksum") = 64 AND "documentChecksum" NOT GLOB '*[^0-9a-f]*' AND length("extractorFingerprint") = 64 AND "extractorFingerprint" NOT GLOB '*[^0-9a-f]*' AND ("contentChecksum" IS NULL OR (length("contentChecksum") = 64 AND "contentChecksum" NOT GLOB '*[^0-9a-f]*')) AND ("detectedMetadataChecksum" IS NULL OR (length("detectedMetadataChecksum") = 64 AND "detectedMetadataChecksum" NOT GLOB '*[^0-9a-f]*')) AND ("indexFingerprint" IS NULL OR (length("indexFingerprint") = 64 AND "indexFingerprint" NOT GLOB '*[^0-9a-f]*'))`
  },
  {
    name: 'LiteratureExtraction_shape_check',
    expression: `"mimeType" = 'application/pdf' AND "extractionSchemaVersion" >= 1 AND ("pageCount" IS NULL OR "pageCount" > 0) AND ("characterCount" IS NULL OR "characterCount" >= 0) AND ("indexedChunkCount" IS NULL OR "indexedChunkCount" >= 0)`
  },
  {
    name: 'LiteratureExtraction_contentBundle_check',
    expression: `(("contentStorageKey" IS NULL AND "contentChecksum" IS NULL) OR ("contentStorageKey" IS NOT NULL AND length(trim("contentStorageKey")) > 0 AND "contentChecksum" IS NOT NULL))`
  },
  {
    name: 'LiteratureExtraction_metadataBundle_check',
    expression: `(("detectedMetadataJson" IS NULL AND "detectedMetadataChecksum" IS NULL) OR ("detectedMetadataJson" IS NOT NULL AND json_valid("detectedMetadataJson") AND json_type("detectedMetadataJson") = 'object' AND "detectedMetadataChecksum" IS NOT NULL))`
  },
  {
    name: 'LiteratureExtraction_indexBundle_check',
    expression: `(("indexState" = 'absent' AND "indexFingerprint" IS NULL AND "indexedChunkCount" IS NULL) OR ("indexState" IN ('queued', 'building', 'failed') AND "indexFingerprint" IS NOT NULL) OR ("indexState" = 'ready' AND "indexFingerprint" IS NOT NULL AND "indexedChunkCount" IS NOT NULL))`
  },
  {
    name: 'LiteratureExtraction_lifecycle_check',
    expression: `(("state" IN ('queued', 'extracting') AND "errorCode" IS NULL) OR ("state" IN ('ready', 'partial') AND "textOrigin" IS NOT NULL AND "pageCount" IS NOT NULL AND "characterCount" IS NOT NULL AND "contentStorageKey" IS NOT NULL AND "errorCode" IS NULL) OR ("state" = 'failed' AND "errorCode" IS NOT NULL AND length(trim("errorCode")) > 0))`
  }
] as const

const evidenceChecks = [
  {
    name: 'LiteratureEvidence_origin_check',
    expression: `"origin" IN ('selection', 'retrieval')`
  },
  {
    name: 'LiteratureEvidence_identity_check',
    expression: `length(trim("sessionId")) > 0 AND length(trim("sourceMessageId")) > 0 AND "pageStart" >= 1 AND "pageEnd" >= "pageStart" AND "evidenceSchemaVersion" >= 1`
  },
  {
    name: 'LiteratureEvidence_checksum_check',
    expression: `length("documentChecksum") = 64 AND "documentChecksum" NOT GLOB '*[^0-9a-f]*' AND length("extractorFingerprint") = 64 AND "extractorFingerprint" NOT GLOB '*[^0-9a-f]*' AND length("evidenceChecksum") = 64 AND "evidenceChecksum" NOT GLOB '*[^0-9a-f]*'`
  },
  {
    name: 'LiteratureEvidence_json_check',
    expression: `json_valid("evidenceJson") AND json_type("evidenceJson") = 'object'`
  }
] as const

const literatureExtractionDdl = `CREATE TABLE "LiteratureExtraction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadVersionId" TEXT NOT NULL,
    "documentChecksum" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "extractorFingerprint" TEXT NOT NULL,
    "extractionSchemaVersion" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "textOrigin" TEXT,
    "pageCount" INTEGER,
    "characterCount" BIGINT,
    "contentStorageKey" TEXT,
    "contentChecksum" TEXT,
    "detectedMetadataJson" TEXT,
    "detectedMetadataChecksum" TEXT,
    "indexState" TEXT NOT NULL DEFAULT 'absent',
    "indexFingerprint" TEXT,
    "indexedChunkCount" INTEGER,
    "errorCode" TEXT,
    "lastAccessedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LiteratureExtraction_uploadVersionId_fkey" FOREIGN KEY ("uploadVersionId") REFERENCES "UploadVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ${extractionChecks.map(({ name, expression }) => `CONSTRAINT "${name}" CHECK (${expression})`).join(',\n    ')}
)`

const literatureEvidenceDdl = `CREATE TABLE "LiteratureEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "uploadVersionId" TEXT,
    "extractionId" TEXT,
    "documentChecksum" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "pageStart" INTEGER NOT NULL,
    "pageEnd" INTEGER NOT NULL,
    "extractorFingerprint" TEXT NOT NULL,
    "evidenceSchemaVersion" INTEGER NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "evidenceChecksum" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LiteratureEvidence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiteratureEvidence_uploadVersionId_fkey" FOREIGN KEY ("uploadVersionId") REFERENCES "UploadVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LiteratureEvidence_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "LiteratureExtraction" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ${evidenceChecks.map(({ name, expression }) => `CONSTRAINT "${name}" CHECK (${expression})`).join(',\n    ')}
)`

const literaturePersistenceMigration = {
  id: '0018_literature_persistence',
  statements: [
    literatureExtractionDdl,
    literatureEvidenceDdl,
    ...literaturePersistenceIndexes.map(({ sql }) => sql)
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'LiteratureExtraction' },
    { kind: 'table-exists', version: 1, table: 'LiteratureEvidence' },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'LiteratureExtraction',
      column: 'uploadVersionId',
      referencedTable: 'UploadVersion',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'LiteratureEvidence',
      column: 'projectId',
      referencedTable: 'Project',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'LiteratureEvidence',
      column: 'uploadVersionId',
      referencedTable: 'UploadVersion',
      referencedColumn: 'id',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'LiteratureEvidence',
      column: 'extractionId',
      referencedTable: 'LiteratureExtraction',
      referencedColumn: 'id',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        { table: 'LiteratureExtraction', constraints: extractionChecks },
        { table: 'LiteratureEvidence', constraints: evidenceChecks }
      ]
    },
    { kind: 'indexes-exist', version: 1, indexes: literaturePersistenceIndexes }
  ] as const
}

export { literaturePersistenceMigration }
