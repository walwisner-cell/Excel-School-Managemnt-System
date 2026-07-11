// The one place the public site's school code lives - change this if the school's
// code in the management system ever changes, and every public page picks it up.
const SCHOOL_CODE = 'DEMO01';

function toggleNav() {
  document.querySelector('nav.site-nav').classList.toggle('open');
}
