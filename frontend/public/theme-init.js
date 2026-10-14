// Applies the stored theme before the first paint to avoid a light/dark flash.
// Loaded as an external file because the backend's Content-Security-Policy forbids inline scripts.
(function () {
  try {
    var t = localStorage.getItem("taskradar.theme") || "system";
    var dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    var lang = localStorage.getItem("taskradar.language");
    if (lang === "en" || lang === "zh-CN") document.documentElement.lang = lang;
  } catch (e) {
    /* storage unavailable */
  }
})();
