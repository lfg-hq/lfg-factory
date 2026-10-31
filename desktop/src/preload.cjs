// Setup window bridge: the page can read and save the server address and token, nothing else.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lfg", {
  getSetup: () => ipcRenderer.invoke("lfg:get-setup"),
  saveSetup: (serverUrl, token) => ipcRenderer.invoke("lfg:save-setup", { serverUrl, token }),
});
