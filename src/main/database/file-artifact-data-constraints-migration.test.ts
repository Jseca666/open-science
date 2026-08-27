import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'
import { applySqliteMigrationOperations } from './sqlite-schema-migrations'

const MIGRATION_ID = '0018_file_artifact_data_constraints'
const CHECKSUM = 'a'.repeat(64)

const createDatabaseAtMigration0016 = async (client: PrismaClient): Promise<void> => {
  const migration0017Index = MIGRATION_MANIFEST.findIndex(
    (migration) => migration.id === MIGRATION_ID
  )
  if (migration0017Index < 0) throw new Error(`Missing ${MIGRATION_ID} from the manifest.`)
  const prefix = MIGRATION_MANIFEST.slice(0, migration0017Index)
  for (const migration of prefix) {
    for (const statement of migration.statements) await client.$executeRawUnsafe(statement)
    if ('operations' in migration) {
      await client.$transaction((transaction) =>
        applySqliteMigrationOperations(transaction, migration.operations)
      )
    }
  }
  await client.$executeRawUnsafe(`CREATE TABLE "_open_science_migrations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checksum" TEXT NOT NULL,
    "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "_open_science_migrations_checksum_check"
      CHECK (length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*')
  )`)
  for (const migration of prefix) {
    await client.$executeRawUnsafe(
      `INSERT INTO "_open_science_migrations" ("id", "checksum") VALUES (?, ?)`,
      migration.id,
      migration.checksum
    )
  }
}

describe('file and Artifact data constraints migration', () => {
  let client: PrismaClient | undefined
  let storageRoot: string | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('preserves valid provenance and repairs the supported historical states', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-file-artifact-0017-'))
    const databasePath = join(storageRoot, 'open-science.db')
    client = createProjectDbClient(storageRoot)
    await createDatabaseAtMigration0016(client)

    await client.$executeRawUnsafe(
      `INSERT INTO "Project" ("id","name","updatedAt") VALUES ('project','Project',CURRENT_TIMESTAMP)`
    )
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
      `INSERT INTO "UploadVersion" ("id","uploadFileId","versionNumber","state","contentStorageKey","filename","originalFilename","sizeBytes","checksum","updatedAt") VALUES ('upload-version','upload',1,'ready','uploads/content','input.txt','input.txt',1,'${CHECKSUM}',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "VisionEvidence" ("id","projectId","sessionId","sourceKind","uploadVersionId","imageChecksum","mimeType","extractorFingerprint","evidenceSchemaVersion","evidenceJson","evidenceChecksum","updatedAt") VALUES ('vision','project','session','upload-version','upload-version','${CHECKSUM}','image/png','${CHECKSUM}',1,'{}','${CHECKSUM}',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactMessageSnapshot" ("id","projectId","sessionId","rootFrameId","agentFrameId","messageBranchId","terminalMessageId","state","storageKey","checksum","messageCount","updatedAt") VALUES ('snapshot','project','session','root','agent','branch','message','ready','snapshots/message.json','',1,CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactVersion" ("id","artifactId","versionNumber","filename","artifactRunId","rootFrameId","agentFrameId","messageBranchId","runtimeSegmentId","promptMessageId","messageSnapshotId","state","contentStorageKey","evidenceStorageKey","sizeBytes","checksum","evidenceJson","evidenceChecksum","evidenceSchemaVersion","updatedAt") VALUES ('artifact-version','artifact',1,'result.txt','run','root','agent','branch','segment','prompt','snapshot','pending','artifacts/content','artifacts/evidence.json',1,'${CHECKSUM}','{}','${CHECKSUM}',1,CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactVersionInput" ("id","artifactVersionId","ordinal","inputFileVersionId","sourceKind","sourceFileId","sourceUploadVersionId","sourceVersionNumber","sourceProjectId","sourceSessionId","filename","sizeBytes","checksum","storageKey","strongestAssociation") VALUES ('input','artifact-version',0,'upload-version','upload-version','upload','upload-version',1,'project','session','input.txt',1,'${CHECKSUM}','uploads/content','turn-attached')`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ManagedFile" ("seq","source","sourceFileId","projectId","sessionId","displayName","storageKey","sizeBytes","sortAtMs","updatedAt","deletedAt") VALUES (41,'artifact','artifact','project','session','result.txt','artifacts/content',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ManagedFileSessionSync" ("projectId","sessionId","filesRevision","groupSortAtMs","artifactCount","uploadCount","deletedAt") VALUES ('project','session',-1,1,1,1,CURRENT_TIMESTAMP)`
    )

    await expect(migrateApplicationDatabase(client, { databasePath })).resolves.toEqual({
      adoptedLegacy: false,
      applied: [MIGRATION_ID],
      from: '0016_compute_job_sensitive_data_encryption',
      to: MIGRATION_ID
    })
    await expect(
      client.$queryRawUnsafe(
        `SELECT "filesRevision", "isComplete", "deleteOperationId" FROM "ManagedFileSessionSync" WHERE "sessionId" = 'session'`
      )
    ).resolves.toEqual([
      {
        filesRevision: 0,
        isComplete: false,
        deleteOperationId: 'migration-0018:project:session'
      }
    ])
    await expect(
      client.$queryRawUnsafe(
        `SELECT "deleteOperationId" FROM "ManagedFile" WHERE "sourceFileId" = 'artifact'`
      )
    ).resolves.toEqual([{ deleteOperationId: 'migration-0018:41' }])
    await expect(
      client.$queryRawUnsafe(
        `SELECT "state", "checksum" FROM "ArtifactMessageSnapshot" WHERE "id" = 'snapshot'`
      )
    ).resolves.toEqual([{ state: 'staging', checksum: '' }])
    await expect(client.$queryRawUnsafe('PRAGMA foreign_key_check')).resolves.toEqual([])

    await client.$executeRawUnsafe(
      `INSERT INTO "ManagedFile" ("source","sourceFileId","projectId","sessionId","displayName","storageKey","sizeBytes","sortAtMs","updatedAt") VALUES ('upload','next-file','project','session','next.txt','uploads/next',0,2,CURRENT_TIMESTAMP)`
    )
    await expect(
      client.$queryRawUnsafe(`SELECT "seq" FROM "ManagedFile" WHERE "sourceFileId" = 'next-file'`)
    ).resolves.toEqual([{ seq: 42 }])
  })

  it('fails closed and rolls back when other historical metadata is invalid', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-file-artifact-0017-invalid-'))
    const databasePath = join(storageRoot, 'open-science.db')
    client = createProjectDbClient(storageRoot)
    await createDatabaseAtMigration0016(client)
    await client.$executeRawUnsafe(
      `INSERT INTO "FileOriginSession" ("projectId","sessionId","updatedAt") VALUES ('project','session',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "UploadFile" ("id","projectId","sessionId","filename","originalFilename","updatedAt") VALUES ('upload','project','session','input.txt','input.txt',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "UploadVersion" ("id","uploadFileId","versionNumber","state","contentStorageKey","filename","originalFilename","sizeBytes","checksum","updatedAt") VALUES ('invalid','upload',1,'ready','uploads/content','input.txt','input.txt',-1,'${CHECKSUM}',CURRENT_TIMESTAMP)`
    )

    await expect(migrateApplicationDatabase(client, { databasePath })).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: MIGRATION_ID
    })
    await expect(
      client.$queryRawUnsafe(
        `SELECT "id" FROM "_open_science_migrations" ORDER BY "id" DESC LIMIT 1`
      )
    ).resolves.toEqual([{ id: '0016_compute_job_sensitive_data_encryption' }])
    await expect(
      client.$queryRawUnsafe(`PRAGMA table_info("ManagedFileSessionSync")`)
    ).resolves.not.toEqual([expect.objectContaining({ name: 'isComplete' })])
    await expect(
      client.$queryRawUnsafe(`SELECT "sizeBytes" FROM "UploadVersion" WHERE "id" = 'invalid'`)
    ).resolves.toEqual([{ sizeBytes: -1n }])
    await expect(access(`${databasePath}.before-${MIGRATION_ID}.backup`)).resolves.toBeUndefined()
  })
})
