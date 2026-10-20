const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startProvider: (payload) => ipcRenderer.invoke('start-provider', payload),
  stopProvider: () => ipcRenderer.send('stop-provider'),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  onProviderLog: (cb) => ipcRenderer.on('provider-log', (e, msg) => cb(msg)),
  saveDataUrl: (dataUrl, fileName) => ipcRenderer.invoke('save-data-url', dataUrl, fileName),
  saveTextFile: (content, fileName) => ipcRenderer.invoke('save-text-file', content, fileName),
  copyImage: (dataUrl) => ipcRenderer.invoke('copy-image', dataUrl),
  accountsLoad: () => ipcRenderer.invoke('accounts-load'),
  accountsSave: (data) => ipcRenderer.invoke('accounts-save', data),
  /* round 28: logging & diagnostics bridge (batched, validated in main) */
  logBatch: (entries) => ipcRenderer.send('log-batch', entries),
  logsExport: (text, json, fileName) => ipcRenderer.invoke('logs-export', text, json, fileName),
  diagPing: () => ipcRenderer.invoke('diag-ping')
});

/* ROUND122: chart-tab undock / dock-back (Chrome-style detachable tabs).
   All channels are validated in main; the renderer never receives Node.
   ROUND123: claimTab — a detached window picks up the tab record main has
   been holding in memory since tabs:undock (the localStorage relay could
   never reliably cross two LIVE renderers, which stranded dock-back). */
contextBridge.exposeInMainWorld('mt5Tabs', {
  undock: (payload) => ipcRenderer.invoke('tabs:undock', payload),
  claimTab: (soloId) => ipcRenderer.invoke('tabs:claim', { soloId: (typeof soloId === 'string' && soloId) || ((/solo=([\w-]+)/.exec(location.hash || '') || [])[1] || '') }),
  dockback: (payload) => ipcRenderer.invoke('tabs:dockback', payload),
  dockAck: (payload) => ipcRenderer.invoke('tabs:dock-ack', payload),
  providerIdentity: () => ipcRenderer.invoke('provider-identity'),
  onDockRequest: (cb) => ipcRenderer.on('tabs:dock-request', (e, p) => cb(p)),
  onDockAck: (cb) => ipcRenderer.on('tabs:dock-ack', (e, p) => cb(p)),
});

/* ROUND125: frameless window shell (TradingView-Desktop style). The OS title
   bar is gone, so the integrated buttons in the tab strip (and on the login
   screen) drive these channels; main routes every call to the SENDING
   window, so the host and every detached window control themselves.
   onMaxState feeds the maximize ⇄ restore glyph flip. */
contextBridge.exposeInMainWorld('mt5Win', {
  minimize: () => ipcRenderer.send('win:minimize'),
  maxToggle: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  isMax: () => ipcRenderer.invoke('win:is-max'),
  onMaxState: (cb) => ipcRenderer.on('win:max-state', (e, m) => cb(!!m)),
});
