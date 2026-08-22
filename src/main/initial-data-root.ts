import { constants as fsConstants, existsSync } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { join, win32 } from 'node:path'

import { DATA_ROOT_DIRS, RELOCATABLE_DATA_DIRS } from './storage/data-directories'

const NSIS_INSTALL_MARKER = '.open-science-nsis-install'

type PrepareInitialDataRootOptions = {
  configRoot: string
  dataFolderName: string
  hadSettingsDocument: boolean
  homeDataRoot: string
  preferredFreshDataRoot: string
  settingsDataRoot?: string
  persistDataRoot: (dataRoot: string) => Promise<unknown>
  pathExists?: (path: string) => boolean
  ensureWritable?: (path: string) => Promise<void>
}

// Keep the user's home-relative path while replacing only the drive. Installation files and user
// data remain separate: C:\Users\Alice + an executable on D: becomes D:\Users\Alice, never the
// protected application directory itself. UNC and relative paths deliberately opt out.
const windowsDataParentForExecutable = (home: string, executable: string): string | undefined => {
  const homeRoot = win32.parse(home).root
  const executableRoot = win32.parse(executable).root
  if (!/^[a-z]:\\$/i.test(homeRoot) || !/^[a-z]:\\$/i.test(executableRoot)) return undefined
  if (homeRoot.toLowerCase() === executableRoot.toLowerCase()) return home
  return win32.join(executableRoot, win32.relative(homeRoot, home))
}

const defaultEnsureWritable = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true })
  await access(path, fsConstants.W_OK)
}

// A pre-relocation install with live user data directly in the hidden config root must keep the
// existing one-time migration prompt. Persisting configRoot as dataRoot would make that prompt look
// like an explicit user choice and suppress it.
const isLegacyConfigDataRoot = (
  configRoot: string,
  dataFolderName: string,
  homeDataRoot: string,
  pathExists: (path: string) => boolean
): boolean =>
  RELOCATABLE_DATA_DIRS.some((directory) => pathExists(join(configRoot, directory))) &&
  !pathExists(join(configRoot, dataFolderName)) &&
  !pathExists(homeDataRoot)

const hasHistoricalFootprint = (
  configRoot: string,
  homeDataRoot: string,
  hadSettingsDocument: boolean,
  pathExists: (path: string) => boolean
): boolean =>
  hadSettingsDocument ||
  pathExists(join(configRoot, 'open-science.db')) ||
  pathExists(join(configRoot, 'sessions')) ||
  pathExists(join(configRoot, 'deleted-sessions')) ||
  pathExists(homeDataRoot) ||
  DATA_ROOT_DIRS.some((directory) => pathExists(join(configRoot, directory)))

// Resolve and persist the initial default before any data-root owner is constructed. Existing
// settings always win. Old users with an unset field are pinned to the former home default, while a
// truly fresh NSIS install may use the installation-drive default. A non-writable alternate drive
// falls back to home without blocking onboarding.
const prepareInitialDataRoot = async ({
  configRoot,
  dataFolderName,
  hadSettingsDocument,
  homeDataRoot,
  preferredFreshDataRoot,
  settingsDataRoot,
  persistDataRoot,
  pathExists = existsSync,
  ensureWritable = defaultEnsureWritable
}: PrepareInitialDataRootOptions): Promise<string | undefined> => {
  if (settingsDataRoot?.trim()) return settingsDataRoot
  if (isLegacyConfigDataRoot(configRoot, dataFolderName, homeDataRoot, pathExists)) return undefined

  const historical = hasHistoricalFootprint(
    configRoot,
    homeDataRoot,
    hadSettingsDocument,
    pathExists
  )
  let selected = historical ? homeDataRoot : preferredFreshDataRoot
  try {
    await ensureWritable(selected)
  } catch (error) {
    if (selected === homeDataRoot) throw error
    selected = homeDataRoot
    await ensureWritable(selected)
  }

  await persistDataRoot(selected)
  return selected
}

export { NSIS_INSTALL_MARKER, prepareInitialDataRoot, windowsDataParentForExecutable }
