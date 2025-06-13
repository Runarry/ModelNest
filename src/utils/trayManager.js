const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const log = require('electron-log');

let tray = null;
let isEnabled = false;
let mainWin = null;

/**
 * Create the Tray instance and wire up events.
 * @param {string} iconPath Absolute path to icon file
 */
function createTray(iconPath) {
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);

  // Left click: show & focus main window.
  tray.on('click', () => {
    if (mainWin) {
      if (mainWin.isDestroyed()) return;
      if (!mainWin.isVisible()) {
        mainWin.show();
      }
      mainWin.focus();
    }
  });

  // Context menu (right click)
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开应用',
      click: () => {
        if (mainWin) {
          if (mainWin.isDestroyed()) return;
          mainWin.show();
          mainWin.focus();
        }
      }
    },
    {
      label: '退出应用',
      click: () => {
        // Mark app as quitting so close handler doesn't just hide window
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip(app.getName());
  tray.setContextMenu(contextMenu);

  log.info('[TrayManager] 系统托盘已创建');
}

/**
 * Initialize or update the tray according to enable flag.
 * @param {BrowserWindow} mainWindow The main application window.
 * @param {boolean} enable Whether tray should be enabled.
 */
function initializeTray(mainWindow, enable) {
  mainWin = mainWindow;
  if (enable === isEnabled) {
    // No change
    return;
  }

  // Destroy existing tray if disabling
  if (!enable && tray) {
    tray.destroy();
    tray = null;
    isEnabled = false;
    log.info('[TrayManager] 系统托盘已禁用');
    return;
  }

  // Create tray if enabling
  if (enable) {
    const iconPath = path.join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'icon.png' : 'icon.png');
    try {
      createTray(iconPath);
      isEnabled = true;
    } catch (err) {
      log.error('[TrayManager] 创建托盘失败:', err);
    }
  }
}

function isTrayEnabled() {
  return isEnabled;
}

module.exports = {
  initializeTray,
  isTrayEnabled
}; 