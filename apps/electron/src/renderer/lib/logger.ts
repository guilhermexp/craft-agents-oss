import log from 'electron-log/renderer'

// Export scoped loggers for renderer process
export const searchLog = log.scope('search')
export const filePreviewLog = log.scope('file-preview')
