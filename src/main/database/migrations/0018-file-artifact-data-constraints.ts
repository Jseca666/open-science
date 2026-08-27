/* Immutable 0018 migration snapshot. Do not regenerate after release. */

const fileArtifactDataConstraintsMigration = {
  id: '0018_file_artifact_data_constraints',
  statements: [] as const,
  operations: [
    {
      kind: 'add-column-if-missing',
      version: 1,
      tableName: 'ManagedFileSessionSync',
      columnName: 'isComplete',
      definition: 'BOOLEAN NOT NULL DEFAULT true'
    },
    {
      kind: 'execute-statements',
      version: 1,
      statements: [
        `UPDATE "ManagedFileSessionSync" SET "filesRevision" = 0, "isComplete" = false WHERE "filesRevision" = -1`,
        `UPDATE "ManagedFile" SET "deleteOperationId" = 'migration-0018:' || "seq" WHERE "deletedAt" IS NOT NULL AND "deleteOperationId" IS NULL`,
        `UPDATE "ManagedFileSessionSync" SET "deleteOperationId" = 'migration-0018:' || "projectId" || ':' || "sessionId" WHERE "deletedAt" IS NOT NULL AND "deleteOperationId" IS NULL`,
        `UPDATE "ArtifactMessageSnapshot" SET "state" = 'staging' WHERE "state" = 'ready' AND "checksum" = ''`
      ]
    },
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'ManagedFile',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ManagedFile" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "source" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "sourceVersionId" TEXT,
    "checksum" TEXT,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT,
    "displayName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "mtimeMs" BIGINT,
    "sortAtMs" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "deleteOperationId" TEXT,
    CONSTRAINT "ManagedFile_source_check" CHECK ("source" IN ('artifact', 'upload')),
    CONSTRAINT "ManagedFile_nonnegative_check" CHECK ("sizeBytes" >= 0 AND ("mtimeMs" IS NULL OR "mtimeMs" >= 0) AND "sortAtMs" >= 0),
    CONSTRAINT "ManagedFile_storageKey_check" CHECK (length(trim("storageKey")) > 0),
    CONSTRAINT "ManagedFile_deletion_check" CHECK ((("deletedAt" IS NULL AND "deleteOperationId" IS NULL) OR ("deletedAt" IS NOT NULL AND "deleteOperationId" IS NOT NULL)))
);`,
          columns: [
            'seq',
            'source',
            'sourceFileId',
            'sourceVersionId',
            'checksum',
            'projectId',
            'sessionId',
            'messageId',
            'displayName',
            'storageKey',
            'mimeType',
            'sizeBytes',
            'mtimeMs',
            'sortAtMs',
            'createdAt',
            'updatedAt',
            'deletedAt',
            'deleteOperationId'
          ]
        },
        {
          tableName: 'ManagedFileSessionSync',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ManagedFileSessionSync" (
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "filesRevision" INTEGER NOT NULL,
    "isComplete" BOOLEAN NOT NULL DEFAULT true,
    "groupSortAtMs" BIGINT NOT NULL,
    "artifactCount" INTEGER NOT NULL DEFAULT 0,
    "uploadCount" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    "deleteOperationId" TEXT,

    PRIMARY KEY ("projectId", "sessionId"),
    CONSTRAINT "ManagedFileSessionSync_nonnegative_check" CHECK ("filesRevision" >= 0 AND "artifactCount" >= 0 AND "uploadCount" >= 0),
    CONSTRAINT "ManagedFileSessionSync_isComplete_check" CHECK ("isComplete" IN (false, true)),
    CONSTRAINT "ManagedFileSessionSync_deletion_check" CHECK ((("deletedAt" IS NULL AND "deleteOperationId" IS NULL) OR ("deletedAt" IS NOT NULL AND "deleteOperationId" IS NOT NULL)))
);`,
          columns: [
            'projectId',
            'sessionId',
            'filesRevision',
            'isComplete',
            'groupSortAtMs',
            'artifactCount',
            'uploadCount',
            'syncedAt',
            'deletedAt',
            'deleteOperationId'
          ]
        },
        {
          tableName: 'UploadVersion',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "UploadVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadFileId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "contentStorageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdAt" DATETIME,
    "registeredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadVersion_uploadFileId_fkey" FOREIGN KEY ("uploadFileId") REFERENCES "UploadFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UploadVersion_state_check" CHECK ("state" IN ('staging', 'ready')),
    CONSTRAINT "UploadVersion_metadata_check" CHECK ("versionNumber" >= 1 AND "sizeBytes" >= 0 AND length(trim("contentStorageKey")) > 0 AND length(trim("filename")) > 0 AND length(trim("originalFilename")) > 0 AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*')
);`,
          columns: [
            'id',
            'uploadFileId',
            'versionNumber',
            'state',
            'contentStorageKey',
            'filename',
            'originalFilename',
            'contentType',
            'sizeBytes',
            'checksum',
            'createdAt',
            'registeredAt',
            'updatedAt'
          ]
        },
        {
          tableName: 'VisionEvidence',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "VisionEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "uploadVersionId" TEXT,
    "sourceMessageId" TEXT,
    "sourceImageId" TEXT,
    "imageChecksum" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "extractorFingerprint" TEXT NOT NULL,
    "evidenceSchemaVersion" INTEGER NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "evidenceChecksum" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VisionEvidence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VisionEvidence_uploadVersionId_fkey" FOREIGN KEY ("uploadVersionId") REFERENCES "UploadVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VisionEvidence_sourceKind_check" CHECK ("sourceKind" IN ('upload-version', 'message-image')),
    CONSTRAINT "VisionEvidence_sourceIdentity_check" CHECK ((("sourceKind" = 'upload-version' AND "uploadVersionId" IS NOT NULL AND "sourceMessageId" IS NULL AND "sourceImageId" IS NULL) OR ("sourceKind" = 'message-image' AND "uploadVersionId" IS NULL AND "sourceMessageId" IS NOT NULL AND "sourceImageId" IS NOT NULL))),
    CONSTRAINT "VisionEvidence_schemaVersion_check" CHECK ("evidenceSchemaVersion" >= 1),
    CONSTRAINT "VisionEvidence_imageChecksum_check" CHECK (length("imageChecksum") = 64 AND "imageChecksum" NOT GLOB '*[^0-9a-f]*'),
    CONSTRAINT "VisionEvidence_extractorFingerprint_check" CHECK (length("extractorFingerprint") = 64 AND "extractorFingerprint" NOT GLOB '*[^0-9a-f]*'),
    CONSTRAINT "VisionEvidence_evidenceChecksum_check" CHECK (length("evidenceChecksum") = 64 AND "evidenceChecksum" NOT GLOB '*[^0-9a-f]*'),
    CONSTRAINT "VisionEvidence_evidenceJson_check" CHECK (json_valid("evidenceJson") AND json_type("evidenceJson") = 'object')
);`,
          columns: [
            'id',
            'projectId',
            'sessionId',
            'sourceKind',
            'uploadVersionId',
            'sourceMessageId',
            'sourceImageId',
            'imageChecksum',
            'mimeType',
            'extractorFingerprint',
            'evidenceSchemaVersion',
            'evidenceJson',
            'evidenceChecksum',
            'createdAt',
            'updatedAt'
          ]
        },
        {
          tableName: 'ArtifactMessageSnapshot',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ArtifactMessageSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "rootFrameId" TEXT NOT NULL,
    "agentFrameId" TEXT NOT NULL,
    "messageBranchId" TEXT NOT NULL,
    "terminalMessageId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT NOT NULL DEFAULT '',
    "messageCount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtifactMessageSnapshot_projectId_sessionId_fkey" FOREIGN KEY ("projectId", "sessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactMessageSnapshot_state_check" CHECK ("state" IN ('staging', 'ready')),
    CONSTRAINT "ArtifactMessageSnapshot_messageCount_check" CHECK ("messageCount" >= 0),
    CONSTRAINT "ArtifactMessageSnapshot_readyChecksum_check" CHECK ("state" <> 'ready' OR (length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*'))
);`,
          columns: [
            'id',
            'projectId',
            'sessionId',
            'rootFrameId',
            'agentFrameId',
            'messageBranchId',
            'terminalMessageId',
            'state',
            'storageKey',
            'checksum',
            'messageCount',
            'createdAt',
            'updatedAt'
          ]
        },
        {
          tableName: 'ArtifactVersion',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ArtifactVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifactId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "artifactRunId" TEXT NOT NULL,
    "writeOperationId" TEXT,
    "writeRequestChecksum" TEXT,
    "rootFrameId" TEXT NOT NULL,
    "agentFrameId" TEXT NOT NULL,
    "messageBranchId" TEXT NOT NULL,
    "runtimeSegmentId" TEXT NOT NULL,
    "promptMessageId" TEXT NOT NULL,
    "notebookSessionId" TEXT,
    "producerRunId" TEXT,
    "producerRunIndex" INTEGER,
    "messageId" TEXT,
    "messageSnapshotId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "contentStorageKey" TEXT NOT NULL,
    "evidenceStorageKey" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "evidenceChecksum" TEXT NOT NULL,
    "evidenceSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "executionSnapshotJson" TEXT,
    "executionSnapshotChecksum" TEXT,
    "executionSnapshotStorageKey" TEXT,
    "executionSnapshotSchemaVersion" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtifactVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "ArtifactLineage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersion_messageSnapshotId_fkey" FOREIGN KEY ("messageSnapshotId") REFERENCES "ArtifactMessageSnapshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersion_state_check" CHECK ("state" IN ('staging', 'pending', 'finalized')),
    CONSTRAINT "ArtifactVersion_filename_check" CHECK (length("filename") > 0),
    CONSTRAINT "ArtifactVersion_evidenceJson_check" CHECK (json_valid("evidenceJson") AND json_type("evidenceJson") = 'object'),
    CONSTRAINT "ArtifactVersion_executionSnapshotJson_check" CHECK ("executionSnapshotJson" IS NULL OR (json_valid("executionSnapshotJson") AND json_type("executionSnapshotJson") = 'object')),
    CONSTRAINT "ArtifactVersion_executionSnapshotBundle_check" CHECK ((("executionSnapshotJson" IS NULL AND "executionSnapshotChecksum" IS NULL AND "executionSnapshotStorageKey" IS NULL AND "executionSnapshotSchemaVersion" IS NULL) OR ("executionSnapshotJson" IS NOT NULL AND "executionSnapshotChecksum" IS NOT NULL AND "executionSnapshotStorageKey" IS NOT NULL AND "executionSnapshotSchemaVersion" IS NOT NULL))),
    CONSTRAINT "ArtifactVersion_nonnegative_check" CHECK ("versionNumber" >= 1 AND "sizeBytes" >= 0 AND "evidenceSchemaVersion" >= 1 AND ("executionSnapshotSchemaVersion" IS NULL OR "executionSnapshotSchemaVersion" >= 1)),
    CONSTRAINT "ArtifactVersion_producerRun_check" CHECK ((("producerRunId" IS NULL AND "producerRunIndex" IS NULL) OR ("producerRunId" IS NOT NULL AND length(trim("producerRunId")) > 0 AND "producerRunIndex" IS NOT NULL AND "producerRunIndex" >= 0))),
    CONSTRAINT "ArtifactVersion_publishedMetadata_check" CHECK ("state" NOT IN ('pending', 'finalized') OR (length(trim("contentStorageKey")) > 0 AND length(trim("evidenceStorageKey")) > 0 AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*' AND length("evidenceChecksum") = 64 AND "evidenceChecksum" NOT GLOB '*[^0-9a-f]*'))
);`,
          columns: [
            'id',
            'artifactId',
            'versionNumber',
            'filename',
            'artifactRunId',
            'writeOperationId',
            'writeRequestChecksum',
            'rootFrameId',
            'agentFrameId',
            'messageBranchId',
            'runtimeSegmentId',
            'promptMessageId',
            'notebookSessionId',
            'producerRunId',
            'producerRunIndex',
            'messageId',
            'messageSnapshotId',
            'state',
            'contentStorageKey',
            'evidenceStorageKey',
            'contentType',
            'sizeBytes',
            'checksum',
            'evidenceJson',
            'evidenceChecksum',
            'evidenceSchemaVersion',
            'executionSnapshotJson',
            'executionSnapshotChecksum',
            'executionSnapshotStorageKey',
            'executionSnapshotSchemaVersion',
            'createdAt',
            'updatedAt'
          ]
        },
        {
          tableName: 'ArtifactVersionInput',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ArtifactVersionInput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifactVersionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "inputFileVersionId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "sourceArtifactVersionId" TEXT,
    "sourceUploadVersionId" TEXT,
    "sourceVersionNumber" INTEGER,
    "sourceCreatedAt" DATETIME,
    "sourceProjectId" TEXT NOT NULL,
    "sourceSessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "strongestAssociation" TEXT NOT NULL,
    CONSTRAINT "ArtifactVersionInput_artifactVersionId_fkey" FOREIGN KEY ("artifactVersionId") REFERENCES "ArtifactVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceArtifactVersionId_fkey" FOREIGN KEY ("sourceArtifactVersionId") REFERENCES "ArtifactVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceUploadVersionId_fkey" FOREIGN KEY ("sourceUploadVersionId") REFERENCES "UploadVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceProjectId_sourceSessionId_fkey" FOREIGN KEY ("sourceProjectId", "sourceSessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceKind_check" CHECK ("sourceKind" IN ('artifact-version', 'upload-version')),
    CONSTRAINT "ArtifactVersionInput_sourceIdentity_check" CHECK ((("sourceKind" = 'artifact-version' AND "sourceArtifactVersionId" IS NOT NULL AND "sourceUploadVersionId" IS NULL AND "inputFileVersionId" = "sourceArtifactVersionId") OR ("sourceKind" = 'upload-version' AND "sourceArtifactVersionId" IS NULL AND "sourceUploadVersionId" IS NOT NULL AND "inputFileVersionId" = "sourceUploadVersionId"))),
    CONSTRAINT "ArtifactVersionInput_strongestAssociation_check" CHECK ("strongestAssociation" IN ('turn-attached', 'resolver-accessed', 'captured-version')),
    CONSTRAINT "ArtifactVersionInput_metadata_check" CHECK ("ordinal" >= 0 AND ("sourceVersionNumber" IS NULL OR "sourceVersionNumber" >= 1) AND "sizeBytes" >= 0 AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*' AND length(trim("storageKey")) > 0)
);`,
          columns: [
            'id',
            'artifactVersionId',
            'ordinal',
            'inputFileVersionId',
            'sourceKind',
            'sourceFileId',
            'sourceArtifactVersionId',
            'sourceUploadVersionId',
            'sourceVersionNumber',
            'sourceCreatedAt',
            'sourceProjectId',
            'sourceSessionId',
            'filename',
            'contentType',
            'sizeBytes',
            'checksum',
            'storageKey',
            'strongestAssociation'
          ]
        }
      ],
      dropOrder: [
        'ArtifactVersionInput',
        'VisionEvidence',
        'ArtifactVersion',
        'ArtifactMessageSnapshot',
        'UploadVersion',
        'ManagedFile',
        'ManagedFileSessionSync'
      ],
      indexes: [
        `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "deletedAt", "sortAtMs", "seq");`,
        `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "source", "deletedAt", "sortAtMs", "seq");`,
        `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_sessionId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "sessionId", "source", "deletedAt", "sortAtMs", "seq");`,
        `CREATE INDEX IF NOT EXISTS "ManagedFile_sessionId_deletedAt_idx" ON "ManagedFile"("sessionId", "deletedAt");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_sourceFileId_key" ON "ManagedFile"("projectId", "source", "sourceFileId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_storageKey_key" ON "ManagedFile"("projectId", "source", "storageKey");`,
        `CREATE INDEX IF NOT EXISTS "ManagedFileSessionSync_projectId_deletedAt_groupSortAtMs_sessionId_idx" ON "ManagedFileSessionSync"("projectId", "deletedAt", "groupSortAtMs", "sessionId");`,
        `CREATE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_state_registeredAt_idx" ON "UploadVersion"("uploadFileId", "state", "registeredAt");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_versionNumber_key" ON "UploadVersion"("uploadFileId", "versionNumber");`,
        `CREATE INDEX IF NOT EXISTS "VisionEvidence_projectId_sessionId_idx" ON "VisionEvidence"("projectId", "sessionId");`,
        `CREATE INDEX IF NOT EXISTS "VisionEvidence_sessionId_idx" ON "VisionEvidence"("sessionId");`,
        `CREATE INDEX IF NOT EXISTS "VisionEvidence_uploadVersionId_idx" ON "VisionEvidence"("uploadVersionId");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactMessageSnapshot_projectId_sessionId_state_idx" ON "ArtifactMessageSnapshot"("projectId", "sessionId", "state");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactMessageSnapshot_projectId_sessionId_agentFrameId_messageBranchId_terminalMessageId_key" ON "ArtifactMessageSnapshot"("projectId", "sessionId", "agentFrameId", "messageBranchId", "terminalMessageId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_writeOperationId_key" ON "ArtifactVersion"("writeOperationId");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_createdAt_idx" ON "ArtifactVersion"("artifactId", "createdAt");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactRunId_state_idx" ON "ArtifactVersion"("artifactRunId", "state");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersion_rootFrameId_agentFrameId_messageBranchId_promptMessageId_idx" ON "ArtifactVersion"("rootFrameId", "agentFrameId", "messageBranchId", "promptMessageId");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageId_idx" ON "ArtifactVersion"("messageId");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageSnapshotId_idx" ON "ArtifactVersion"("messageSnapshotId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_versionNumber_key" ON "ArtifactVersion"("artifactId", "versionNumber");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceKind_inputFileVersionId_idx" ON "ArtifactVersionInput"("sourceKind", "inputFileVersionId");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceArtifactVersionId_idx" ON "ArtifactVersionInput"("sourceArtifactVersionId");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceUploadVersionId_idx" ON "ArtifactVersionInput"("sourceUploadVersionId");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceProjectId_sourceSessionId_idx" ON "ArtifactVersionInput"("sourceProjectId", "sourceSessionId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_sourceKind_inputFileVersionId_key" ON "ArtifactVersionInput"("artifactVersionId", "sourceKind", "inputFileVersionId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_ordinal_key" ON "ArtifactVersionInput"("artifactVersionId", "ordinal");`
      ]
    }
  ] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'ManagedFileSessionSync',
      column: 'isComplete'
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'ManagedFile',
          constraints: [
            {
              name: 'ManagedFile_nonnegative_check',
              expression: `"sizeBytes" >= 0 AND ("mtimeMs" IS NULL OR "mtimeMs" >= 0) AND "sortAtMs" >= 0`
            },
            {
              name: 'ManagedFile_storageKey_check',
              expression: `length(trim("storageKey")) > 0`
            },
            {
              name: 'ManagedFile_deletion_check',
              expression: `(("deletedAt" IS NULL AND "deleteOperationId" IS NULL) OR ("deletedAt" IS NOT NULL AND "deleteOperationId" IS NOT NULL))`
            }
          ]
        },
        {
          table: 'ManagedFileSessionSync',
          constraints: [
            {
              name: 'ManagedFileSessionSync_nonnegative_check',
              expression: `"filesRevision" >= 0 AND "artifactCount" >= 0 AND "uploadCount" >= 0`
            },
            {
              name: 'ManagedFileSessionSync_isComplete_check',
              expression: `"isComplete" IN (false, true)`
            },
            {
              name: 'ManagedFileSessionSync_deletion_check',
              expression: `(("deletedAt" IS NULL AND "deleteOperationId" IS NULL) OR ("deletedAt" IS NOT NULL AND "deleteOperationId" IS NOT NULL))`
            }
          ]
        },
        {
          table: 'UploadVersion',
          constraints: [
            {
              name: 'UploadVersion_metadata_check',
              expression: `"versionNumber" >= 1 AND "sizeBytes" >= 0 AND length(trim("contentStorageKey")) > 0 AND length(trim("filename")) > 0 AND length(trim("originalFilename")) > 0 AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*'`
            }
          ]
        },
        {
          table: 'ArtifactMessageSnapshot',
          constraints: [
            {
              name: 'ArtifactMessageSnapshot_messageCount_check',
              expression: `"messageCount" >= 0`
            },
            {
              name: 'ArtifactMessageSnapshot_readyChecksum_check',
              expression: `"state" <> 'ready' OR (length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*')`
            }
          ]
        },
        {
          table: 'ArtifactVersion',
          constraints: [
            {
              name: 'ArtifactVersion_nonnegative_check',
              expression: `"versionNumber" >= 1 AND "sizeBytes" >= 0 AND "evidenceSchemaVersion" >= 1 AND ("executionSnapshotSchemaVersion" IS NULL OR "executionSnapshotSchemaVersion" >= 1)`
            },
            {
              name: 'ArtifactVersion_producerRun_check',
              expression: `(("producerRunId" IS NULL AND "producerRunIndex" IS NULL) OR ("producerRunId" IS NOT NULL AND length(trim("producerRunId")) > 0 AND "producerRunIndex" IS NOT NULL AND "producerRunIndex" >= 0))`
            },
            {
              name: 'ArtifactVersion_publishedMetadata_check',
              expression: `"state" NOT IN ('pending', 'finalized') OR (length(trim("contentStorageKey")) > 0 AND length(trim("evidenceStorageKey")) > 0 AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*' AND length("evidenceChecksum") = 64 AND "evidenceChecksum" NOT GLOB '*[^0-9a-f]*')`
            }
          ]
        },
        {
          table: 'ArtifactVersionInput',
          constraints: [
            {
              name: 'ArtifactVersionInput_metadata_check',
              expression: `"ordinal" >= 0 AND ("sourceVersionNumber" IS NULL OR "sourceVersionNumber" >= 1) AND "sizeBytes" >= 0 AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*' AND length(trim("storageKey")) > 0`
            }
          ]
        }
      ]
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'ManagedFile_projectId_deletedAt_sortAtMs_seq_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "deletedAt", "sortAtMs", "seq");`
        },
        {
          name: 'ManagedFile_projectId_source_deletedAt_sortAtMs_seq_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "source", "deletedAt", "sortAtMs", "seq");`
        },
        {
          name: 'ManagedFile_projectId_sessionId_source_deletedAt_sortAtMs_seq_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_sessionId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "sessionId", "source", "deletedAt", "sortAtMs", "seq");`
        },
        {
          name: 'ManagedFile_sessionId_deletedAt_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ManagedFile_sessionId_deletedAt_idx" ON "ManagedFile"("sessionId", "deletedAt");`
        },
        {
          name: 'ManagedFile_projectId_source_sourceFileId_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_sourceFileId_key" ON "ManagedFile"("projectId", "source", "sourceFileId");`
        },
        {
          name: 'ManagedFile_projectId_source_storageKey_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_storageKey_key" ON "ManagedFile"("projectId", "source", "storageKey");`
        },
        {
          name: 'ManagedFileSessionSync_projectId_deletedAt_groupSortAtMs_sessionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ManagedFileSessionSync_projectId_deletedAt_groupSortAtMs_sessionId_idx" ON "ManagedFileSessionSync"("projectId", "deletedAt", "groupSortAtMs", "sessionId");`
        },
        {
          name: 'UploadVersion_uploadFileId_state_registeredAt_idx',
          sql: `CREATE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_state_registeredAt_idx" ON "UploadVersion"("uploadFileId", "state", "registeredAt");`
        },
        {
          name: 'UploadVersion_uploadFileId_versionNumber_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_versionNumber_key" ON "UploadVersion"("uploadFileId", "versionNumber");`
        },
        {
          name: 'VisionEvidence_projectId_sessionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "VisionEvidence_projectId_sessionId_idx" ON "VisionEvidence"("projectId", "sessionId");`
        },
        {
          name: 'VisionEvidence_sessionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "VisionEvidence_sessionId_idx" ON "VisionEvidence"("sessionId");`
        },
        {
          name: 'VisionEvidence_uploadVersionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "VisionEvidence_uploadVersionId_idx" ON "VisionEvidence"("uploadVersionId");`
        },
        {
          name: 'ArtifactMessageSnapshot_projectId_sessionId_state_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactMessageSnapshot_projectId_sessionId_state_idx" ON "ArtifactMessageSnapshot"("projectId", "sessionId", "state");`
        },
        {
          name: 'ArtifactMessageSnapshot_projectId_sessionId_agentFrameId_messageBranchId_terminalMessageId_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactMessageSnapshot_projectId_sessionId_agentFrameId_messageBranchId_terminalMessageId_key" ON "ArtifactMessageSnapshot"("projectId", "sessionId", "agentFrameId", "messageBranchId", "terminalMessageId");`
        },
        {
          name: 'ArtifactVersion_writeOperationId_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_writeOperationId_key" ON "ArtifactVersion"("writeOperationId");`
        },
        {
          name: 'ArtifactVersion_artifactId_createdAt_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_createdAt_idx" ON "ArtifactVersion"("artifactId", "createdAt");`
        },
        {
          name: 'ArtifactVersion_artifactRunId_state_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactRunId_state_idx" ON "ArtifactVersion"("artifactRunId", "state");`
        },
        {
          name: 'ArtifactVersion_rootFrameId_agentFrameId_messageBranchId_promptMessageId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersion_rootFrameId_agentFrameId_messageBranchId_promptMessageId_idx" ON "ArtifactVersion"("rootFrameId", "agentFrameId", "messageBranchId", "promptMessageId");`
        },
        {
          name: 'ArtifactVersion_messageId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageId_idx" ON "ArtifactVersion"("messageId");`
        },
        {
          name: 'ArtifactVersion_messageSnapshotId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageSnapshotId_idx" ON "ArtifactVersion"("messageSnapshotId");`
        },
        {
          name: 'ArtifactVersion_artifactId_versionNumber_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_versionNumber_key" ON "ArtifactVersion"("artifactId", "versionNumber");`
        },
        {
          name: 'ArtifactVersionInput_sourceKind_inputFileVersionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceKind_inputFileVersionId_idx" ON "ArtifactVersionInput"("sourceKind", "inputFileVersionId");`
        },
        {
          name: 'ArtifactVersionInput_sourceArtifactVersionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceArtifactVersionId_idx" ON "ArtifactVersionInput"("sourceArtifactVersionId");`
        },
        {
          name: 'ArtifactVersionInput_sourceUploadVersionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceUploadVersionId_idx" ON "ArtifactVersionInput"("sourceUploadVersionId");`
        },
        {
          name: 'ArtifactVersionInput_sourceProjectId_sourceSessionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceProjectId_sourceSessionId_idx" ON "ArtifactVersionInput"("sourceProjectId", "sourceSessionId");`
        },
        {
          name: 'ArtifactVersionInput_artifactVersionId_sourceKind_inputFileVersionId_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_sourceKind_inputFileVersionId_key" ON "ArtifactVersionInput"("artifactVersionId", "sourceKind", "inputFileVersionId");`
        },
        {
          name: 'ArtifactVersionInput_artifactVersionId_ordinal_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_ordinal_key" ON "ArtifactVersionInput"("artifactVersionId", "ordinal");`
        }
      ]
    }
  ] as const
}

export { fileArtifactDataConstraintsMigration }
