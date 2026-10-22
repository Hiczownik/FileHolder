// Sets the colour theme before the first paint, so a visitor whose system is light never sees the dark page flash
// first (#67). Loaded as its own file rather than inline, so a Content-Security-Policy can stay script-src 'self'.
// Keep the storage key and mode names in step with src/shared/hooks/useTheme.ts, which takes over once React runs.
(function () {
  var mode = 'system';
  try {
    var saved = window.localStorage.getItem('fileholder-theme');
    if (saved === 'light' || saved === 'dark') mode = saved;
  } catch (e) {
    // Private modes and blocked site data throw here; follow the system instead.
  }

  var prefersLight = false;
  try {
    prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch (e) {
    // No matchMedia: stay on dark, the stylesheet's default.
  }

  document.documentElement.dataset.theme = mode === 'system' ? (prefersLight ? 'light' : 'dark') : mode;
})();
