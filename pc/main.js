const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');

app.setAppUserModelId('com.daygoal.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const ICON = path.join(__dirname, 'assets', 'icon.png');
const startHidden = process.argv.includes('--hidden');
let win = null;
let tray = null;
let quitting = false;

function loginArgs() {
  return app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
}

function showWin() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function sendAction(action) {
  showWin();
  win?.webContents.send('action', action);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    show: false,
    icon: ICON,
    title: 'DayGoal',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false // keep the reminder timer running while hidden
    }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  // Closing the window keeps the app running in the tray.
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('DayGoal');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DayGoal', click: showWin },
    { type: 'separator' },
    { label: 'Set today\'s goals', click: () => sendAction('morning') },
    { label: 'Log what I did', click: () => sendAction('evening') },
    { label: 'New note', click: () => sendAction('note') },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', showWin);
}

function firstRunSetup() {
  const flag = path.join(app.getPath('userData'), '.first-run-done');
  if (fs.existsSync(flag)) return;
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: loginArgs() });
  try { fs.writeFileSync(flag, '1'); } catch {}
}

ipcMain.on('win:show', showWin);
ipcMain.on('notify', (_e, { title, body, action }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON });
  n.on('click', () => (action ? sendAction(action) : showWin()));
  n.show();
});
ipcMain.handle('autolaunch:get', () => app.getLoginItemSettings({ args: loginArgs() }).openAtLogin);
ipcMain.handle('autolaunch:set', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on, args: loginArgs() });
  return app.getLoginItemSettings({ args: loginArgs() }).openAtLogin;
});

app.on('second-instance', showWin);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => e.preventDefault?.());

app.whenReady().then(() => {
  firstRunSetup();
  createWindow();
  createTray();
  // Re-check reminders right after the PC wakes up.
  powerMonitor.on('resume', () => win?.webContents.send('action', 'tick'));
  powerMonitor.on('unlock-screen', () => win?.webContents.send('action', 'tick'));
});
