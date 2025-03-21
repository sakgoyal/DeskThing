// Types
import {
  AppDataInterface,
  SettingsType,
  AppSettings,
  ServerEvent,
  Step,
  Task,
  SEND_TYPES
} from '@DeskThing/types'
import { TaskReference, CacheableStore, FullTaskList } from '@shared/types'
import { TaskStoreClass } from '@shared/stores/taskStore'
import { AppStoreClass } from '@shared/stores/appStore'
import {
  addSettingsOptions,
  AppDataStoreClass,
  AppDataStoreListener,
  AppDataStoreListenerEvents,
  AppDataStoreListeners,
  NotifyListenersType
} from '@shared/stores/appDataStore'

// Utils
import Logger from '@server/utils/logger'

// Services
import {
  getData,
  overwriteData,
  purgeAppData,
  setData
} from '@server/services/files/dataFileService'
import { getIcon } from '@server/services/apps/appUtils'
import { isValidAppDataInterface, isValidAppSettings } from '@server/services/apps/appValidator'

// Validation
import { isValidStep, isValidTask } from '@server/services/task'

export class AppDataStore implements CacheableStore, AppDataStoreClass {
  private listeners: AppDataStoreListeners = {
    appData: [],
    settings: [],
    data: [],
    tasks: [],
    keys: [],
    actions: []
  }

  private appDataCache: Record<string, AppDataInterface> = {}

  private functionTimeouts: Record<string, NodeJS.Timeout> = {}

  private appStore: AppStoreClass

  constructor(appStore: AppStoreClass) {
    this.appStore = appStore
    this.initAppCache()
    this.initAppListeners()
  }

  private initAppListeners = (): void => {
    this.appStore.onAppMessage(SEND_TYPES.GET, async (data) => {
      switch (data.request) {
        case 'data': {
          const appData = await this.getData(data.source)
          this.appStore.sendDataToApp(data.source, {
            type: ServerEvent.DATA,
            request: 'data',
            payload: appData
          })
          break
        }
        case 'appData': {
          const appData = await this.getAppData(data.source)
          this.appStore.sendDataToApp(data.source, {
            type: ServerEvent.APPDATA,
            request: 'data',
            payload: appData
          })
          break
        }
        case 'settings': {
          const settings = await this.getSettings(data.source)
          this.appStore.sendDataToApp(data.source, {
            type: ServerEvent.SETTINGS,
            request: 'data',
            payload: settings
          })
          break
        }
        case 'config': {
          Logger.warn(
            `[handleAppData]: ${data.source} tried accessing "Config" data type which is depreciated and no longer in use!`,
            {
              source: 'AppDataStore',
              domain: 'SERVER.' + data.source,
              function: 'handleRequestGetConfig'
            }
          )
          break
        }
      }
    })

    this.appStore.onAppMessage(SEND_TYPES.SET, async (data) => {
      switch (data.request) {
        case 'appData': {
          try {
            isValidAppDataInterface(data.payload)
            await this.addAppData(data.source, data.payload)
          } catch (error) {
            Logger.error(`[handleRequestSetAppData]: Error setting app data`, {
              error: error as Error,
              source: 'appCommunication',
              function: 'handleRequestSetAppData'
            })
          }
          break
        }
        case 'data': {
          await this.addData(data.source, data.payload)
          break
        }
        case 'settings': {
          await this.addSettings(data.source, data.payload, { notifyApp: false })
          break
        }
      }
    })

    this.appStore.onAppMessage(SEND_TYPES.DELETE, async (data) => {
      switch (data.request) {
        case 'data': {
          await this.delData(data.source, data.payload)
          break
        }
        case 'settings': {
          await this.delSettings(data.source, data.payload)
          break
        }
      }
    })
  }
  private initAppCache = async (): Promise<void> => {
    const apps = this.getAvailableData()
    await Promise.all(apps.map(async (app) => this.initCacheVersion(app)))
  }

  /**
   * @implements CacheableStore
   */
  clearCache = async (): Promise<void> => {
    // Clear all values in appDataCache except version
    await this.saveDataAllData(false)
    Object.values(this.functionTimeouts).forEach((timeout) => {
      clearTimeout(timeout)
    })
    this.functionTimeouts = {}
  }

  private getAvailableData = (): string[] => {
    const apps = [...this.appStore.getOrder(), 'server']
    return apps
  }

  private notifyGlobal = async (): Promise<void> => {
    Logger.debug(`Saving apps to file`, {
      source: 'AppDataStore',
      function: 'saveAppsToFile'
    })
    this.notifyListeners('appData', this.appDataCache)
  }

  private notifyAppFields = async (name: string, notifyApp = true): Promise<void> => {
    const fieldsToUpdate: (keyof Omit<AppDataInterface, 'version'>)[] = Object.keys(
      this.appDataCache[name]
    ).filter(
      (field) => this.appDataCache[name][field] !== undefined || field == 'version'
    ) as (keyof Omit<AppDataInterface, 'version'>)[]
    if (fieldsToUpdate.length === 0) return

    Logger.debug(`Saving ${name} to file and notifying apps listeners`, {
      source: 'AppDataStore',
      domain: name,
      function: 'saveAppToFile'
    })

    // Notify each individual field
    fieldsToUpdate.forEach((field) => {
      if (!this.appDataCache[name][field]) return

      this.notifyListeners(field, {
        appId: name,
        data: this.appDataCache[name][field]
      } as AppDataStoreListenerEvents[typeof field])
      if (notifyApp && name != 'server') {
        switch (field) {
          case 'data':
            this.appStore.sendDataToApp(name, {
              type: ServerEvent.DATA,
              request: '',
              payload: this.appDataCache[name][field]
            })
            break
          case 'settings':
            this.appStore.sendDataToApp(name, {
              type: ServerEvent.SETTINGS,
              request: '',
              payload: this.appDataCache[name][field]
            })
            break
          case 'tasks':
            this.appStore.sendDataToApp(name, {
              type: ServerEvent.TASKS,
              request: 'update',
              payload: this.appDataCache[name][field]
            })
            break
        }
      }
    })
  }

  private async saveDataAllData(notifyApp = true): Promise<void> {
    if (this.functionTimeouts['server-saveApps']) {
      Logger.debug(`Cancelling previous saveApps timeout and starting a new one`, {
        source: 'AppDataStore',
        function: 'saveAppsToFile'
      })
      clearTimeout(this.functionTimeouts['server-saveApps'])
    }

    this.functionTimeouts['server-saveApps'] = setTimeout(async () => {
      this.notifyGlobal()
      await Promise.all(
        Object.keys(this.appDataCache).map(async (appName) => {
          await this.saveData(appName, notifyApp)
        })
      )
    }, 500)
  }

  private async saveData(name: string, notifyApp = true): Promise<void> {
    if (!this.appDataCache[name]) return

    // Clear any existing timeout for this app
    if (this.functionTimeouts[name]) {
      Logger.debug(`Cancelling previous ${name} request and starting a new one`, {
        source: 'AppDataStore',
        domain: name,
        function: 'saveAppToFile'
      })
      clearTimeout(this.functionTimeouts[name])
    }

    // Set new timeout
    this.functionTimeouts[name] = setTimeout(async () => {
      if (Object.values(this.appDataCache[name]).length > 1) {
        await setData(name, this.appDataCache[name])
      }
      await this.notifyAppFields(name, notifyApp)
      Logger.debug(`Saving and removing ${name} from cache`, {
        function: 'saveData',
        source: 'appDataStore'
      })
      delete this.appDataCache[name]
      delete this.functionTimeouts[name]
    }, 500)
  }

  /**
   * @implements CacheableStore
   */
  saveToFile = async (): Promise<void> => {
    await Promise.all(
      Object.keys(this.appDataCache).map(async (appName) => {
        // Check if there is any data besides settings
        if (Object.values(this.appDataCache[appName]).length > 1) {
          await this.saveData(appName)
        }
      })
    )
  }

  async setupListeners(taskStore: TaskStoreClass): Promise<void> {
    taskStore.on('taskList', async (taskData) => {
      if (this.appDataCache[taskData.source]) {
        // Update the task if it exists
        this.updateTasks(taskData.source, taskData.taskList)
      } else {
        // Otherwise, set it
        this.setTasks(taskData.source, taskData.taskList)
      }
    })

    taskStore.on('step', async (payload) => {
      if (payload.source && payload.taskId && payload.step) {
        if (this.appDataCache[payload.source]) {
          this.updateStep(payload.source, payload.taskId, payload.step)
        }
      }
    })

    taskStore.on('task', async (payload) => {
      if (payload.source && payload.id) {
        if (this.appDataCache[payload.source]) {
          this.updateTask(payload.source, payload)
        }
      }
    })
  }

  private notifyListeners: NotifyListenersType = async (event, payload): Promise<void> => {
    if (this.listeners[event]) {
      await Promise.all(this.listeners[event].map((listener) => listener(payload)))
    }
  }

  on<K extends keyof AppDataStoreListenerEvents>(
    event: K,
    listener: AppDataStoreListener<K>
  ): () => void {
    if (!this.listeners[event]) {
      this.listeners[event] = []
    }
    this.listeners[event].push(listener)
    return () => this.off(event, listener)
  }

  off<K extends keyof AppDataStoreListenerEvents>(
    event: K,
    listener: AppDataStoreListener<K>
  ): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(
        (l) => l !== listener
      ) as AppDataStoreListeners[K]
    }
  }

  async purgeAppData(name: string): Promise<boolean> {
    try {
      Logger.debug(`Purging app data for ${name}`, {
        source: 'AppDataStore',
        domain: name,
        function: 'purgeAppData'
      })
      await purgeAppData(name)
      return true
    } catch (error) {
      Logger.error('There was an error purging app data: ', {
        source: 'AppDataStore',
        domain: name,
        function: 'delAppData',
        error: error as Error
      })
      return false
    }
  }

  private initCacheVersion(name: string): void {
    // server 'app'
    if (name == 'server') {
      if (!this.appDataCache[name]) {
        this.appDataCache[name] = { version: '0.0.0' }
      }
      return
    }

    const app = this.appStore.get(name)

    if (!app || !app.manifest) {
      Logger.warn(`App ${name} not found`, {
        source: 'AppDataStore',
        domain: name,
        function: 'initCacheVersion'
      })
      // Remove the app cache as it does not exist
      delete this.appDataCache[name]
      return
    }

    if (!this.appDataCache[name] || this.appDataCache[name].version !== app.manifest.version) {
      this.appDataCache[name] = { version: '' }
    }

    this.appDataCache[name].version = app.manifest.version
  }

  /**
   * Will always fetch data from file
   * @param name
   * @returns
   */
  async getAppData(name: string): Promise<AppDataInterface | undefined> {
    this.initCacheVersion(name)

    Logger.debug('Getting Data', {
      source: 'AppDataStore',
      domain: name,
      function: 'getData'
    })
    const data = await getData(name)
    if (!data) return

    this.appDataCache[name] = data
    return data
  }

  async getData(name: string): Promise<Record<string, string> | undefined> {
    this.initCacheVersion(name)

    if (this.appDataCache[name].data) {
      return this.appDataCache[name].data
    } else {
      Logger.debug('Getting Data', {
        source: 'AppDataStore',
        domain: name,
        function: 'getData'
      })
      const data = await getData(name)
      this.appDataCache[name].data = data?.data
      return data?.data
    }
  }

  async getSettings(name: string): Promise<AppSettings | undefined> {
    this.initCacheVersion(name)

    // return cache
    if (this.appDataCache[name].settings) {
      return this.appDataCache[name].settings
    }

    const data = await getData(name)
    if (!data) return
    this.appDataCache[name].settings = data?.settings
    return data?.settings
  }

  async getTasks(name: string): Promise<Record<string, Task> | undefined> {
    this.initCacheVersion(name)

    if (this.appDataCache[name].tasks) {
      return this.appDataCache[name].tasks
    }
    const data = await getData(name)
    if (!data) {
      Logger.debug(`Unable to find tasks for ${name} in filesystem for`, {
        source: 'AppDataStore',
        function: 'getTasks'
      })
      return
    }
    this.appDataCache[name].tasks = data.tasks
    return data.tasks
  }

  async getTask(name: string, taskId: string): Promise<Task | undefined> {
    const tasks = await this.getTasks(name)
    return tasks?.[taskId]
  }

  async getTaskList(): Promise<FullTaskList> {
    const apps = this.getAvailableData()
    const tasks: FullTaskList = Object.fromEntries(
      await Promise.all(
        apps.map(async (app) => [app, (await this.getTasks(app)) || ({} as Record<string, Task>)])
      )
    )

    return tasks
  }

  /**
   * Adds the tasks to the existing tasks, overwriting if there is overlap
   * @param app
   * @param tasks - key-value pair of tasks in a map
   * @param notifyApp - whether to notify the app of the change
   */
  async setTasks(app: string, tasks: Record<string, Task>, notifyApp = true): Promise<void> {
    this.initCacheVersion(app)

    const oldTasks = await this.getTasks(app)

    const combinedTasks = { ...oldTasks, ...tasks }

    this.appDataCache[app].tasks = combinedTasks

    await this.saveData(app, notifyApp)
  }

  /**
   * @deprecated - use taskStore.addTasks instead!
   * @param app
   * @param task
   * @returns
   */
  async updateTaskList(app: string, task: Task): Promise<void> {
    try {
      isValidTask(task)
    } catch (error) {
      Logger.error('Invalid task', {
        source: 'AppDataStore',
        domain: app,
        function: 'updateTaskList',
        error: error as Error
      })
      return
    }

    this.initCacheVersion(app)

    const taskData = this.appDataCache[app].tasks || (await this.getTasks(app))

    const updatedTasks: Record<string, Task> = {
      ...taskData,
      [task.id]: task
    }

    this.appStore.sendDataToApp(app, {
      type: ServerEvent.TASKS,
      request: 'update',
      payload: updatedTasks
    })

    this.appDataCache[app].tasks = updatedTasks

    await this.saveData(app, true)
  }

  async updateStep(app: string, taskId: string, step: Partial<Step>): Promise<void> {
    try {
      isValidStep(step)
    } catch (error) {
      Logger.error('Invalid step', {
        source: 'AppDataStore',
        domain: app,
        function: 'updateStep',
        error: error as Error
      })
      return
    }

    const task = await this.getTask(app, taskId)

    if (!task) {
      Logger.debug(`Unable to update step ${step.id} because ${taskId} was not found!`, {
        function: 'updateStep',
        source: 'AppDataStore'
      })
      return
    }

    task.steps[step.id] = step

    this.appStore.sendDataToApp(app, { type: ServerEvent.TASKS, request: 'step', payload: step })

    this.saveData(app)
  }

  async getStep(source: string, id: string, stepId: string): Promise<Step | undefined> {
    const task = await this.getTask(source, id)
    return task?.steps[stepId]
  }

  async updateTasks(app: string, tasks: Record<string, Task>): Promise<void> {
    try {
      Object.values(tasks).forEach((task) => isValidTask(task))
    } catch (error) {
      Logger.error('Invalid tasks', {
        source: 'AppDataStore',
        domain: app,
        function: 'updateTasks',
        error: error as Error
      })
      return
    }

    const taskData = this.appDataCache[app]?.tasks || (await this.getTasks(app))
    const updatedTasks = {
      ...taskData,
      ...tasks
    }

    this.appDataCache[app].tasks = updatedTasks

    await this.saveData(app, true)
  }

  async updateTask(app: string, task: Partial<Task>): Promise<void> {
    try {
      isValidTask(task)
    } catch (error) {
      Logger.error('Invalid task', {
        source: 'AppDataStore',
        domain: app,
        function: 'updateTask',
        error: error as Error
      })
      return
    }

    const taskData = this.appDataCache[app]?.tasks || (await this.getTasks(app))
    if (!taskData) return

    if (!taskData[task.id]) {
      taskData[task.id] = task
    } else {
      taskData[task.id] = { ...taskData[task.id], ...task }
    }

    this.appDataCache[app].tasks = taskData

    await this.saveData(app, true)
  }

  async addData(app: string, data: Record<string, string>): Promise<void> {
    this.initCacheVersion(app)

    this.appDataCache[app].data = data

    await this.saveData(app, true)
  }

  async addAppData(app: string, data: AppDataInterface): Promise<void> {
    try {
      isValidAppDataInterface(data)
    } catch {
      Logger.error('Invalid app data interface', {
        source: 'AppDataStore',
        domain: 'SERVER.' + app.toUpperCase(),
        function: 'addAppData'
      })
      return
    }

    if (this.appDataCache[app]) {
      // deepest of merges
      this.appDataCache[app] = { ...this.appDataCache[app], ...data }
    } else {
      this.appDataCache[app] = data
    }
    await this.saveData(app, true)
  }

  // merge with existing settings
  addSettings = async (
    app: string,
    settings: AppSettings,
    { notifyApp = true }: addSettingsOptions = {
      notifyApp: true,
      notifyServer: true
    }
  ): Promise<void> => {
    Logger.debug('Adding settings to app', {
      source: 'AppDataStore',
      domain: app,
      function: 'addSettings'
    })
    this.initCacheVersion(app)

    try {
      isValidAppSettings(settings)
    } catch (error) {
      Logger.error('Invalid settings', {
        source: 'AppDataStore',
        domain: 'SERVER.' + app.toUpperCase(),
        function: 'addSettings',
        error: error as Error
      })
      return
    }

    const prevSettings = this.appDataCache[app].settings || (await this.getSettings(app))

    const newSettings = {
      ...prevSettings,
      ...settings
    }

    this.appDataCache[app].settings = newSettings

    this.saveData(app, notifyApp)
  }

  /**
   * Deletes a provided setting
   */
  async delSettings(app: string, settings: string[] | string): Promise<void> {
    Logger.debug('Deleting settings from app', {
      source: 'AppDataStore',
      domain: app,
      function: 'delSettings'
    })
    this.initCacheVersion(app)

    // Ignore cache and get all of the data from the file
    const curData = await this.getAppData(app)

    // Already gone
    if (!curData) return

    const settingsToDelete = Array.isArray(settings) ? settings : [settings]

    settingsToDelete.forEach((key) => {
      if (curData?.settings && curData.settings[key]) {
        delete curData.settings[key]
      }
    })

    this.appDataCache[app] = curData

    // Ensures it is deleted
    await overwriteData(app, curData)
  }

  /**
   * Deletes provided data
   */
  async delData(app: string, dataIds: string[] | string): Promise<void> {
    Logger.debug('Deleting data from app', {
      source: 'AppDataStore',
      domain: app,
      function: 'delData'
    })
    this.initCacheVersion(app)

    // Ignore cache and get all of the data from the file
    const curData = await this.getAppData(app)

    // Already gone
    if (!curData) return

    const dataToDelete = Array.isArray(dataIds) ? dataIds : [dataIds]

    dataToDelete.forEach((key) => {
      if (curData?.data && curData.data[key]) {
        delete curData.data[key]
      }
    })

    this.appDataCache[app] = curData

    // Ensures it is deleted
    await overwriteData(app, curData)
  }
  async delTasks(app: string, taskIds: string[] | string): Promise<void> {
    Logger.debug('Deleting tasks from app', {
      source: 'AppDataStore',
      domain: app,
      function: 'delTasks'
    })
    this.initCacheVersion(app)

    // Ignore cache and get all of the data from the file
    const curData = await this.getAppData(app)

    // Already gone
    if (!curData) return

    const tasksToDelete = Array.isArray(taskIds) ? taskIds : [taskIds]

    tasksToDelete.forEach((key) => {
      if (curData?.tasks && curData.tasks[key]) {
        delete curData.tasks[key]
      }
    })

    this.appDataCache[app] = curData

    // Ensures it is deleted
    await overwriteData(app, curData)
  }

  completeStep = async (taskRef: Task | TaskReference, stepId: string): Promise<void> => {
    Logger.debug('Completing task', {
      source: 'AppDataStore',
      domain: taskRef.source,
      function: 'completeStep'
    })

    const task = await this.getTask(taskRef.source, taskRef.id)

    if (!task) {
      Logger.error(`Task ${taskRef.label} was not found in the system or is not running`, {
        source: 'AppDataStore',
        domain: taskRef.source,
        function: 'completeStep'
      })
      return
    }

    task.steps[stepId].completed = true

    this.appStore.sendDataToApp(task.source, {
      type: ServerEvent.TASKS,
      payload: { ...task.steps[stepId], parentId: task.id },
      request: 'step'
    })

    this.updateTask(task.source, task)
  }

  async addSetting(app: string, id: string, setting: SettingsType): Promise<void> {
    let appSettings = await this.getSettings(app)

    if (appSettings && appSettings[id]) {
      appSettings[id] = setting
    } else {
      appSettings = {
        [id]: setting
      }
    }

    this.appDataCache[app].settings = appSettings

    this.saveData(app)
  }
  /**
   * Fetches the icon.svg from the file system and returns the file:// path for it
   */
  async getIcon(appName: string, icon?: string): Promise<string | null> {
    return await getIcon(appName, icon)
  }
}
