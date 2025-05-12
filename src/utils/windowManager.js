const { BrowserWindow, app } = require('electron'); // Import app
const path = require('path');
const log = require('electron-log');

// __DEV__ will be passed as a parameter to createWindow

let mainWindow;

/**
 * Creates and manages the main application window.
 * @param {boolean} isDev - Whether the application is in development mode.
 * @returns {BrowserWindow} The created main window instance.
 */
function createWindow(isDev) {
  log.info('[WindowManager] 创建主窗口');
  mainWindow = new BrowserWindow({
    width: 1270,
    height: 800,
    icon: path.join(app.getAppPath(), 'assets/icon.png'), // Use app.getAppPath() for consistency
    webPreferences: {
      preload: path.join(app.getAppPath(), 'preload.js'), // Use app.getAppPath()
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(app.getAppPath(), 'src/renderer/index.html')); // Use app.getAppPath()

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    log.info('[WindowManager] 主窗口已关闭');
    // mainWindow = null; // Dereference the window object
  });

  return mainWindow;
}

function getMainWindow() {
  return mainWindow;
}

module.exports = {
  createWindow,
  getMainWindow
};