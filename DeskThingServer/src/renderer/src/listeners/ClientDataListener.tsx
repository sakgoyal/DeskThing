import { useEffect } from 'react'
import { useClientStore } from '../stores'
import { IpcRendererCallback } from '@shared/types'

let mounted = false

/**
 * Listens for client data events and updates the client store accordingly.
 * This component is responsible for fetching and updating the following data:
 * - Clients
 * - Connections
 * - ADB Devices
 * It also sets up an initial task to help the user connect their ADB device.
 */
const ClientDataListener = (): null => {
  const setClients = useClientStore((state) => state.setClients)
  const setConnections = useClientStore((state) => state.setConnections)
  const setAdbDevices = useClientStore((state) => state.setADBDevices)
  const requestADBDevices = useClientStore((state) => state.requestADBDevices)
  const requestConnections = useClientStore((state) => state.requestConnections)
  const requestClientManifest = useClientStore((state) => state.requestClientManifest)

  if (!mounted) {
    const getInitialState = async (): Promise<void> => {
      requestConnections()
      requestADBDevices()
      requestClientManifest()
    }

    getInitialState()
    mounted = true
  }

  useEffect(() => {
    const onClientdata: IpcRendererCallback<'clients'> = (_async, data) => {
      setClients(data.data)
    }

    window.electron.ipcRenderer.on('clients', onClientdata)

    const onConnections: IpcRendererCallback<'connections'> = (_async, data) => {
      setConnections(data.data)
    }

    window.electron.ipcRenderer.on('connections', onConnections)

    const onAdbDevices: IpcRendererCallback<'adbdevices'> = (_async, data) => {
      setAdbDevices(data)
    }

    window.electron.ipcRenderer.on('adbdevices', onAdbDevices)

    // Cleanup listeners on unmount
    return () => {
      window.electron.ipcRenderer.removeAllListeners('clients')
      window.electron.ipcRenderer.removeAllListeners('connections')
      window.electron.ipcRenderer.removeAllListeners('adbdevices')
    }
  }, [setClients, setConnections, setAdbDevices])

  return null
}

export default ClientDataListener
