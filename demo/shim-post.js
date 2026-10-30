// Demo-only replacements for browser features the claude.ai viewer blocks.
(function () {
  const use = (n) => (window.claude?.use ? window.claude.use(n) : Promise.resolve(null));
  window.download = async function (filename, content) {
    const dl = await use("downloads");
    if (!dl) return;
    try { await dl.save({ filename, data: content }); } catch {}
  };
  window.openFile = async function () {
    const t = document.querySelector(".toast:not(:empty)") || document.getElementById("dToast");
    if (t) t.textContent = "En la demo los archivos se guardan solo durante la sesión y no se pueden abrir.";
  };
  const banner = document.createElement("div");
  banner.className = "demo-banner";
  banner.innerHTML = 'Demo de Lumen · los datos se guardan solo en este navegador · <button type="button">Reiniciar demo</button>';
  banner.querySelector("button").onclick = () => window.__lumenDemoReset();
  document.body.prepend(banner);
})();
