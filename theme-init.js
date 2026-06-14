// Resolve and apply the theme before first paint to avoid a flash.
// Kept as an external file (not inline) so it complies with the page's
// Content-Security-Policy without needing 'unsafe-inline' in script-src.
(function () {
  var pref = localStorage.getItem('themePref') || 'auto';
  var hour = new Date().getHours();
  var resolved = pref === 'auto' ? ((hour >= 19 || hour < 7) ? 'dark' : 'light') : pref;
  document.documentElement.setAttribute('data-theme', resolved);
})();
