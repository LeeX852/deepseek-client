document.getElementById('retry').addEventListener('click', () => {
  window.ipcRenderer?.send?.('overlay:retry');
});
