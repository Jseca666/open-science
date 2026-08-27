import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from './migration-service'

describe('database domain constraints', () => {
  let client: PrismaClient | undefined
  let storageRoot: string | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { force: true, recursive: true })
  })

  it('rejects domain values that bypass the TypeScript write boundaries', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-domain-constraints-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)

    await client.$executeRawUnsafe(
      `INSERT INTO "Review" ("id","projectId","sessionId","turnMessageId","lifecycle","updatedAt") VALUES ('base-review','p','s','m','running',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "Finding" ("id","reviewId","status") VALUES ('base-finding','base-review','warn')`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ReviewFindingDisposition" ("id","sourceFindingId","sequence","trigger","outcome") VALUES ('base-disposition','base-finding',1,'aborted','unaddressed')`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ComputeJob" ("id","providerId","shape","sessionId","projectId","status","intent","command","commandHash") VALUES ('base-job','ssh:h','direct_ssh','s','p','submitted','i','c','h')`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ComputeHost" ("id","providerId","displayName","sshAlias","updatedAt") VALUES ('base-host','ssh:h','h','h',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "GrantedLocalRoot" ("id","path","name","access","updatedAt") VALUES ('base-root','/tmp/base','base','ro',CURRENT_TIMESTAMP)`
    )

    const invalidWrites = [
      {
        name: 'Review.lifecycle',
        sql: `UPDATE "Review" SET "lifecycle" = 'unknown' WHERE "id" = 'base-review'`
      },
      {
        name: 'Review.outcome',
        sql: `UPDATE "Review" SET "outcome" = 'unknown' WHERE "id" = 'base-review'`
      },
      {
        name: 'Review running state',
        sql: `UPDATE "Review" SET "outcome" = 'pass' WHERE "id" = 'base-review'`
      },
      {
        name: 'Review complete state',
        sql: `UPDATE "Review" SET "lifecycle" = 'complete' WHERE "id" = 'base-review'`
      },
      {
        name: 'Review error state',
        sql: `UPDATE "Review" SET "lifecycle" = 'error' WHERE "id" = 'base-review'`
      },
      {
        name: 'Finding.status',
        sql: `UPDATE "Finding" SET "status" = 'unknown' WHERE "id" = 'base-finding'`
      },
      {
        name: 'Finding.resolution',
        sql: `UPDATE "Finding" SET "resolution" = 'unknown' WHERE "id" = 'base-finding'`
      },
      {
        name: 'Finding.artifactBindingState',
        sql: `UPDATE "Finding" SET "artifactBindingState" = 'unknown' WHERE "id" = 'base-finding'`
      },
      {
        name: 'Finding.sortIndex',
        sql: `UPDATE "Finding" SET "sortIndex" = -1 WHERE "id" = 'base-finding'`
      },
      {
        name: 'Finding.reflagCount',
        sql: `UPDATE "Finding" SET "reflagCount" = -1 WHERE "id" = 'base-finding'`
      },
      {
        name: 'Finding pass resolution',
        sql: `UPDATE "Finding" SET "status" = 'pass', "resolution" = 'resolved' WHERE "id" = 'base-finding'`
      },
      {
        name: 'Finding validated artifact binding',
        sql: `UPDATE "Finding" SET "artifactBindingState" = 'scope_validated' WHERE "id" = 'base-finding'`
      },
      {
        name: 'ReviewFindingDisposition.sequence',
        sql: `UPDATE "ReviewFindingDisposition" SET "sequence" = 0 WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ReviewFindingDisposition.trigger',
        sql: `UPDATE "ReviewFindingDisposition" SET "trigger" = 'unknown' WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ReviewFindingDisposition.outcome',
        sql: `UPDATE "ReviewFindingDisposition" SET "outcome" = 'unknown' WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ReviewFindingDisposition review submission cause',
        sql: `UPDATE "ReviewFindingDisposition" SET "trigger" = 'review_submission', "outcome" = 'resolved' WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ReviewFindingDisposition review submission outcome',
        sql: `UPDATE "ReviewFindingDisposition" SET "trigger" = 'review_submission', "causeReviewId" = 'base-review' WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ReviewFindingDisposition terminal cause',
        sql: `UPDATE "ReviewFindingDisposition" SET "causeReviewId" = 'base-review' WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ReviewFindingDisposition terminal outcome',
        sql: `UPDATE "ReviewFindingDisposition" SET "outcome" = 'resolved' WHERE "id" = 'base-disposition'`
      },
      {
        name: 'ComputeJob.shape',
        sql: `UPDATE "ComputeJob" SET "shape" = 'unknown' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob.status',
        sql: `UPDATE "ComputeJob" SET "status" = 'unknown' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob.errorCode',
        sql: `UPDATE "ComputeJob" SET "errorCode" = 'unknown' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob.timeoutSeconds lower bound',
        sql: `UPDATE "ComputeJob" SET "timeoutSeconds" = 0 WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob.timeoutSeconds upper bound',
        sql: `UPDATE "ComputeJob" SET "timeoutSeconds" = 604801 WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob notification state',
        sql: `UPDATE "ComputeJob" SET "notificationConsumedAt" = CURRENT_TIMESTAMP WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob harvest payload',
        sql: `UPDATE "ComputeJob" SET "harvestError" = 'failed' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob harvest state',
        sql: `UPDATE "ComputeJob" SET "harvestedAt" = CURRENT_TIMESTAMP WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob error code state',
        sql: `UPDATE "ComputeJob" SET "errorCode" = 'dispatch_failed' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeJob error status state',
        sql: `UPDATE "ComputeJob" SET "status" = 'error' WHERE "id" = 'base-job'`
      },
      {
        name: 'ComputeHost.shape',
        sql: `UPDATE "ComputeHost" SET "shape" = 'unknown' WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost.scratchPinned',
        sql: `UPDATE "ComputeHost" SET "scratchPinned" = 2 WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost.concurrencyLimit',
        sql: `UPDATE "ComputeHost" SET "concurrencyLimit" = 0 WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost.concurrencyLimit upper bound',
        sql: `UPDATE "ComputeHost" SET "concurrencyLimit" = 501 WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost.detailsUpdatedBy',
        sql: `UPDATE "ComputeHost" SET "detailsUpdatedBy" = 'unknown' WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost details author without time',
        sql: `UPDATE "ComputeHost" SET "detailsUpdatedBy" = 'agent' WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost details time without author',
        sql: `UPDATE "ComputeHost" SET "detailsUpdatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'base-host'`
      },
      {
        name: 'ComputeHost pinned scratch root',
        sql: `UPDATE "ComputeHost" SET "scratchPinned" = true WHERE "id" = 'base-host'`
      },
      {
        name: 'GrantedLocalRoot.access',
        sql: `UPDATE "GrantedLocalRoot" SET "access" = 'admin' WHERE "id" = 'base-root'`
      }
    ]

    const accepted: string[] = []
    for (const invalidWrite of invalidWrites) {
      try {
        await client.$executeRawUnsafe(invalidWrite.sql)
        accepted.push(invalidWrite.name)
      } catch {
        // Expected: the SQLite CHECK contract rejects the write.
      }
    }
    expect(accepted).toEqual([])
  })

  it('rejects invalid managed-file and immutable provenance metadata', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-file-artifact-constraints-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)

    const checksum = 'a'.repeat(64)
    await client.$executeRawUnsafe(
      `INSERT INTO "FileOriginSession" ("projectId","sessionId","updatedAt") VALUES ('project','session',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactLineage" ("id","projectId","sessionId","normalizedFilename","filename","updatedAt") VALUES ('artifact','project','session','result.txt','result.txt',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "UploadFile" ("id","projectId","sessionId","filename","originalFilename","updatedAt") VALUES ('upload','project','session','input.txt','input.txt',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "UploadVersion" ("id","uploadFileId","versionNumber","state","contentStorageKey","filename","originalFilename","sizeBytes","checksum","updatedAt") VALUES ('upload-version','upload',1,'ready','uploads/content','input.txt','input.txt',1,'${checksum}',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactMessageSnapshot" ("id","projectId","sessionId","rootFrameId","agentFrameId","messageBranchId","terminalMessageId","state","storageKey","checksum","messageCount","updatedAt") VALUES ('snapshot','project','session','root','agent','branch','message','staging','snapshots/message.json','${checksum}',1,CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactVersion" ("id","artifactId","versionNumber","filename","artifactRunId","rootFrameId","agentFrameId","messageBranchId","runtimeSegmentId","promptMessageId","state","contentStorageKey","evidenceStorageKey","sizeBytes","checksum","evidenceJson","evidenceChecksum","evidenceSchemaVersion","updatedAt") VALUES ('artifact-version','artifact',1,'result.txt','run','root','agent','branch','segment','prompt','pending','artifacts/content','artifacts/evidence.json',1,'${checksum}','{}','${checksum}',1,CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactVersionInput" ("id","artifactVersionId","ordinal","inputFileVersionId","sourceKind","sourceFileId","sourceArtifactVersionId","sourceVersionNumber","sourceProjectId","sourceSessionId","filename","sizeBytes","checksum","storageKey","strongestAssociation") VALUES ('input','artifact-version',0,'artifact-version','artifact-version','artifact','artifact-version',1,'project','session','result.txt',1,'${checksum}','artifacts/content','turn-attached')`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ManagedFile" ("source","sourceFileId","projectId","sessionId","displayName","storageKey","sizeBytes","mtimeMs","sortAtMs","updatedAt") VALUES ('artifact','artifact','project','session','result.txt','artifacts/content',1,1,1,CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ManagedFileSessionSync" ("projectId","sessionId","filesRevision","groupSortAtMs","artifactCount","uploadCount") VALUES ('project','session',1,1,1,1)`
    )

    const invalidWrites = [
      {
        name: 'ManagedFile.sizeBytes',
        sql: `UPDATE "ManagedFile" SET "sizeBytes" = -1 WHERE "sourceFileId" = 'artifact'`,
        restore: `UPDATE "ManagedFile" SET "sizeBytes" = 1 WHERE "sourceFileId" = 'artifact'`
      },
      {
        name: 'ManagedFile.mtimeMs',
        sql: `UPDATE "ManagedFile" SET "mtimeMs" = -1 WHERE "sourceFileId" = 'artifact'`,
        restore: `UPDATE "ManagedFile" SET "mtimeMs" = 1 WHERE "sourceFileId" = 'artifact'`
      },
      {
        name: 'ManagedFile.sortAtMs',
        sql: `UPDATE "ManagedFile" SET "sortAtMs" = -1 WHERE "sourceFileId" = 'artifact'`,
        restore: `UPDATE "ManagedFile" SET "sortAtMs" = 1 WHERE "sourceFileId" = 'artifact'`
      },
      {
        name: 'ManagedFile.storageKey',
        sql: `UPDATE "ManagedFile" SET "storageKey" = ' ' WHERE "sourceFileId" = 'artifact'`,
        restore: `UPDATE "ManagedFile" SET "storageKey" = 'artifacts/content' WHERE "sourceFileId" = 'artifact'`
      },
      {
        name: 'ManagedFile deletedAt without operation',
        sql: `UPDATE "ManagedFile" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "sourceFileId" = 'artifact'`,
        restore: `UPDATE "ManagedFile" SET "deletedAt" = NULL WHERE "sourceFileId" = 'artifact'`
      },
      {
        name: 'ManagedFile operation without deletedAt',
        sql: `UPDATE "ManagedFile" SET "deleteOperationId" = 'delete' WHERE "sourceFileId" = 'artifact'`,
        restore: `UPDATE "ManagedFile" SET "deleteOperationId" = NULL WHERE "sourceFileId" = 'artifact'`
      },
      {
        name: 'ManagedFileSessionSync.filesRevision',
        sql: `UPDATE "ManagedFileSessionSync" SET "filesRevision" = -2 WHERE "sessionId" = 'session'`,
        restore: `UPDATE "ManagedFileSessionSync" SET "filesRevision" = 1 WHERE "sessionId" = 'session'`
      },
      {
        name: 'ManagedFileSessionSync.artifactCount',
        sql: `UPDATE "ManagedFileSessionSync" SET "artifactCount" = -1 WHERE "sessionId" = 'session'`,
        restore: `UPDATE "ManagedFileSessionSync" SET "artifactCount" = 1 WHERE "sessionId" = 'session'`
      },
      {
        name: 'ManagedFileSessionSync.uploadCount',
        sql: `UPDATE "ManagedFileSessionSync" SET "uploadCount" = -1 WHERE "sessionId" = 'session'`,
        restore: `UPDATE "ManagedFileSessionSync" SET "uploadCount" = 1 WHERE "sessionId" = 'session'`
      },
      {
        name: 'ManagedFileSessionSync deletedAt without operation',
        sql: `UPDATE "ManagedFileSessionSync" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "sessionId" = 'session'`,
        restore: `UPDATE "ManagedFileSessionSync" SET "deletedAt" = NULL WHERE "sessionId" = 'session'`
      },
      {
        name: 'ManagedFileSessionSync operation without deletedAt',
        sql: `UPDATE "ManagedFileSessionSync" SET "deleteOperationId" = 'delete' WHERE "sessionId" = 'session'`,
        restore: `UPDATE "ManagedFileSessionSync" SET "deleteOperationId" = NULL WHERE "sessionId" = 'session'`
      },
      {
        name: 'UploadVersion.versionNumber',
        sql: `UPDATE "UploadVersion" SET "versionNumber" = 0 WHERE "id" = 'upload-version'`,
        restore: `UPDATE "UploadVersion" SET "versionNumber" = 1 WHERE "id" = 'upload-version'`
      },
      {
        name: 'UploadVersion.sizeBytes',
        sql: `UPDATE "UploadVersion" SET "sizeBytes" = -1 WHERE "id" = 'upload-version'`,
        restore: `UPDATE "UploadVersion" SET "sizeBytes" = 1 WHERE "id" = 'upload-version'`
      },
      {
        name: 'UploadVersion.contentStorageKey',
        sql: `UPDATE "UploadVersion" SET "contentStorageKey" = ' ' WHERE "id" = 'upload-version'`,
        restore: `UPDATE "UploadVersion" SET "contentStorageKey" = 'uploads/content' WHERE "id" = 'upload-version'`
      },
      {
        name: 'UploadVersion.filename',
        sql: `UPDATE "UploadVersion" SET "filename" = ' ' WHERE "id" = 'upload-version'`,
        restore: `UPDATE "UploadVersion" SET "filename" = 'input.txt' WHERE "id" = 'upload-version'`
      },
      {
        name: 'UploadVersion.originalFilename',
        sql: `UPDATE "UploadVersion" SET "originalFilename" = ' ' WHERE "id" = 'upload-version'`,
        restore: `UPDATE "UploadVersion" SET "originalFilename" = 'input.txt' WHERE "id" = 'upload-version'`
      },
      {
        name: 'UploadVersion.checksum',
        sql: `UPDATE "UploadVersion" SET "checksum" = ' ' WHERE "id" = 'upload-version'`,
        restore: `UPDATE "UploadVersion" SET "checksum" = '${checksum}' WHERE "id" = 'upload-version'`
      },
      {
        name: 'ArtifactMessageSnapshot.messageCount',
        sql: `UPDATE "ArtifactMessageSnapshot" SET "messageCount" = -1 WHERE "id" = 'snapshot'`,
        restore: `UPDATE "ArtifactMessageSnapshot" SET "messageCount" = 1 WHERE "id" = 'snapshot'`
      },
      {
        name: 'ArtifactMessageSnapshot ready checksum',
        sql: `UPDATE "ArtifactMessageSnapshot" SET "state" = 'ready', "checksum" = 'invalid' WHERE "id" = 'snapshot'`,
        restore: `UPDATE "ArtifactMessageSnapshot" SET "state" = 'staging', "checksum" = '${checksum}' WHERE "id" = 'snapshot'`
      },
      {
        name: 'ArtifactVersion.versionNumber',
        sql: `UPDATE "ArtifactVersion" SET "versionNumber" = 0 WHERE "id" = 'artifact-version'`,
        restore: `UPDATE "ArtifactVersion" SET "versionNumber" = 1 WHERE "id" = 'artifact-version'`
      },
      {
        name: 'ArtifactVersion.sizeBytes',
        sql: `UPDATE "ArtifactVersion" SET "sizeBytes" = -1 WHERE "id" = 'artifact-version'`,
        restore: `UPDATE "ArtifactVersion" SET "sizeBytes" = 1 WHERE "id" = 'artifact-version'`
      },
      {
        name: 'ArtifactVersion.evidenceSchemaVersion',
        sql: `UPDATE "ArtifactVersion" SET "evidenceSchemaVersion" = 0 WHERE "id" = 'artifact-version'`,
        restore: `UPDATE "ArtifactVersion" SET "evidenceSchemaVersion" = 1 WHERE "id" = 'artifact-version'`
      },
      {
        name: 'ArtifactVersion.executionSnapshotSchemaVersion',
        sql: `UPDATE "ArtifactVersion" SET "executionSnapshotJson" = '{}', "executionSnapshotChecksum" = '${checksum}', "executionSnapshotStorageKey" = 'artifacts/execution.json', "executionSnapshotSchemaVersion" = 0 WHERE "id" = 'artifact-version'`,
        restore: `UPDATE "ArtifactVersion" SET "executionSnapshotJson" = NULL, "executionSnapshotChecksum" = NULL, "executionSnapshotStorageKey" = NULL, "executionSnapshotSchemaVersion" = NULL WHERE "id" = 'artifact-version'`
      },
      {
        name: 'ArtifactVersion producer id without index',
        sql: `UPDATE "ArtifactVersion" SET "producerRunId" = 'producer' WHERE "id" = 'artifact-version'`,
        restore: `UPDATE "ArtifactVersion" SET "producerRunId" = NULL WHERE "id" = 'artifact-version'`
      },
      {
        name: 'ArtifactVersion producer index without id',
        sql: `UPDATE "ArtifactVersion" SET "producerRunIndex" = 0 WHERE "id" = 'artifact-version'`,
        restore: `UPDATE "ArtifactVersion" SET "producerRunIndex" = NULL WHERE "id" = 'artifact-version'`
      },
      {
        name: 'ArtifactVersion negative producer index',
        sql: `UPDATE "ArtifactVersion" SET "producerRunId" = 'producer', "producerRunIndex" = -1 WHERE "id" = 'artifact-version'`,
        restore: `UPDATE "ArtifactVersion" SET "producerRunId" = NULL, "producerRunIndex" = NULL WHERE "id" = 'artifact-version'`
      },
      {
        name: 'ArtifactVersion published content storage',
        sql: `UPDATE "ArtifactVersion" SET "contentStorageKey" = ' ' WHERE "id" = 'artifact-version'`,
        restore: `UPDATE "ArtifactVersion" SET "contentStorageKey" = 'artifacts/content' WHERE "id" = 'artifact-version'`
      },
      {
        name: 'ArtifactVersion published evidence storage',
        sql: `UPDATE "ArtifactVersion" SET "evidenceStorageKey" = ' ' WHERE "id" = 'artifact-version'`,
        restore: `UPDATE "ArtifactVersion" SET "evidenceStorageKey" = 'artifacts/evidence.json' WHERE "id" = 'artifact-version'`
      },
      {
        name: 'ArtifactVersion published content checksum',
        sql: `UPDATE "ArtifactVersion" SET "checksum" = 'invalid' WHERE "id" = 'artifact-version'`,
        restore: `UPDATE "ArtifactVersion" SET "checksum" = '${checksum}' WHERE "id" = 'artifact-version'`
      },
      {
        name: 'ArtifactVersion published evidence checksum',
        sql: `UPDATE "ArtifactVersion" SET "evidenceChecksum" = 'invalid' WHERE "id" = 'artifact-version'`,
        restore: `UPDATE "ArtifactVersion" SET "evidenceChecksum" = '${checksum}' WHERE "id" = 'artifact-version'`
      },
      {
        name: 'ArtifactVersionInput.ordinal',
        sql: `UPDATE "ArtifactVersionInput" SET "ordinal" = -1 WHERE "id" = 'input'`,
        restore: `UPDATE "ArtifactVersionInput" SET "ordinal" = 0 WHERE "id" = 'input'`
      },
      {
        name: 'ArtifactVersionInput.sourceVersionNumber',
        sql: `UPDATE "ArtifactVersionInput" SET "sourceVersionNumber" = 0 WHERE "id" = 'input'`,
        restore: `UPDATE "ArtifactVersionInput" SET "sourceVersionNumber" = 1 WHERE "id" = 'input'`
      },
      {
        name: 'ArtifactVersionInput.sizeBytes',
        sql: `UPDATE "ArtifactVersionInput" SET "sizeBytes" = -1 WHERE "id" = 'input'`,
        restore: `UPDATE "ArtifactVersionInput" SET "sizeBytes" = 1 WHERE "id" = 'input'`
      },
      {
        name: 'ArtifactVersionInput.checksum',
        sql: `UPDATE "ArtifactVersionInput" SET "checksum" = ' ' WHERE "id" = 'input'`,
        restore: `UPDATE "ArtifactVersionInput" SET "checksum" = '${checksum}' WHERE "id" = 'input'`
      },
      {
        name: 'ArtifactVersionInput.storageKey',
        sql: `UPDATE "ArtifactVersionInput" SET "storageKey" = ' ' WHERE "id" = 'input'`,
        restore: `UPDATE "ArtifactVersionInput" SET "storageKey" = 'artifacts/content' WHERE "id" = 'input'`
      }
    ]

    const accepted: string[] = []
    for (const invalidWrite of invalidWrites) {
      try {
        await client.$executeRawUnsafe(invalidWrite.sql)
        accepted.push(invalidWrite.name)
        await client.$executeRawUnsafe(invalidWrite.restore)
      } catch {
        // Expected: the SQLite CHECK contract rejects the write.
      }
    }
    expect(accepted).toEqual([])
  })
})
