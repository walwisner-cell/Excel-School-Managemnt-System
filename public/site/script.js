// The one place the public site's school code lives - change this if the school's
// code in the management system ever changes, and every public page picks it up.
const SCHOOL_CODE = 'DEMO01';

function toggleNav() {
  document.querySelector('nav.site-nav').classList.toggle('open');
}

// Fetches the school's real name and any customized page text, then fills in
// every matching element on THIS page - elements that don't exist here are just
// skipped, so one shared function works across every page without needing to
// know which fields a given page actually uses.
function applySiteContent() {
  fetch(`/api/public/school-info?code=${SCHOOL_CODE}`)
    .then(r => r.json())
    .then(school => {
      if (!school.name) return;
      document.querySelectorAll('[data-site-name]').forEach(el => { el.textContent = school.name; });
      document.title = document.title.replace('Excel School System', school.name);
    })
    .catch(() => {});

  fetch(`/api/public/site-content?code=${SCHOOL_CODE}`)
    .then(r => r.json())
    .then(content => {
      Object.entries(content).forEach(([key, value]) => {
        const el = document.getElementById(key);
        if (el) el.textContent = value;
      });
    })
    .catch(() => {});
}
document.addEventListener('DOMContentLoaded', applySiteContent);
