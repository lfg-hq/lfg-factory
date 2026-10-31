// Bridge for the app's own sign-in page (setup.html). The main process ignores these
// calls from anything but that local page, so the LFG website can't use them.
const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("lfg", {
    getSetup: () => ipcRenderer.invoke("lfg:get-setup"),
    signIn: () => ipcRenderer.invoke("lfg:sign-in"),
    cancelSignIn: () => ipcRenderer.invoke("lfg:cancel-sign-in"),
  });
}
