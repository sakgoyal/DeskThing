import { useEffect } from 'react'
import { IpcRendererCallback } from '@shared/types'
import useMappingStore from '@renderer/stores/mappingStore'

let mounted = false
/**
 * A React component that listens for updates to mapping data and updates the mapping store accordingly.
 *
 * This component subscribes to the 'key', 'action', and 'profile' events from the Electron IPC renderer,
 * and updates the mapping store with the received data. It also requests the initial mapping data
 * when the component mounts.
 *
 * The component does not render any UI elements, it only handles the mapping data updates.
 */
const MappingsDataListener = (): null => {
  const setKeys = useMappingStore((state) => state.setKeys)
  const setActions = useMappingStore((state) => state.setActions)
  const setProfile = useMappingStore((state) => state.setProfile)
  const setCurrentProfile = useMappingStore((state) => state.setCurrentProfile)
  const requestMappings = useMappingStore((state) => state.requestMappings)

  if (!mounted) {
    requestMappings()
    mounted = true
  }

  useEffect(() => {
    const handleKeyUpdate: IpcRendererCallback<'key'> = (_event, key): void => {
      setKeys(key)
    }
    const handleActionUpdate: IpcRendererCallback<'action'> = async (
      _event,
      action
    ): Promise<void> => {
      setActions(action)
    }
    const handleProfileUpdate: IpcRendererCallback<'profile'> = async (
      _event,
      profile
    ): Promise<void> => {
      setProfile(profile)
      const currentProfile = await window.electron.getCurrentProfile()
      setCurrentProfile(currentProfile)
    }

    window.electron.ipcRenderer.on('key', handleKeyUpdate)
    window.electron.ipcRenderer.on('action', handleActionUpdate)
    window.electron.ipcRenderer.on('profile', handleProfileUpdate)

    return () => {
      window.electron.ipcRenderer.removeAllListeners('key')
      window.electron.ipcRenderer.removeAllListeners('action')
      window.electron.ipcRenderer.removeAllListeners('profile')
    }
  }, [])

  return null
}

export default MappingsDataListener
