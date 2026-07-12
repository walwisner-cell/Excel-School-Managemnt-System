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

  // Replace the generic crest icon with the school's own uploaded logo, if one
  // exists - a 404 here just means no logo yet, so the default crest stays put.
  fetch(`/api/public/logo?code=${SCHOOL_CODE}`)
    .then(r => { if (!r.ok) throw new Error('no logo'); return r.blob(); })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      document.querySelectorAll('svg.crest').forEach(svg => {
        const img = document.createElement('img');
        img.src = url;
        img.className = svg.className.baseVal || 'crest';
        img.style.objectFit = 'contain';
        svg.replaceWith(img);
      });
    })
    .catch(() => {});

  // If this page has a hero section marked with a placement, check whether the
  // school has featured a gallery photo for that exact spot - if so, show it as
  // the hero's background image instead of the plain color/gradient.
  const heroEl = document.querySelector('[data-hero-placement]');
  if (heroEl) {
    const placement = heroEl.dataset.heroPlacement;
    fetch(`/api/public/featured-images?code=${SCHOOL_CODE}`)
      .then(r => r.json())
      .then(images => {
        const photoId = images[placement];
        if (!photoId) return;
        heroEl.style.backgroundImage = `linear-gradient(rgba(13,35,56,.72), rgba(13,35,56,.72)), url(/api/public/gallery/${photoId}/file)`;
        heroEl.style.backgroundSize = 'cover';
        heroEl.style.backgroundPosition = 'center';
      })
      .catch(() => {});
  }

  fetch(`/api/public/site-content?code=${SCHOOL_CODE}`)
    .then(r => r.json())
    .then(content => {
      Object.entries(content).forEach(([key, value]) => {
        const el = document.getElementById(key);
        if (el) el.textContent = value;
      });
      // Social links are hrefs, not plain text, and each icon only shows up if
      // that link was actually filled in - an empty field just means "no icon".
      const socialWrap = document.getElementById('socialLinks');
      if (socialWrap) {
        const links = [
          content.facebook_url && { href: content.facebook_url, label: 'Facebook', icon: '📘' },
          content.whatsapp_number && { href: `https://wa.me/${content.whatsapp_number.replace(/[^0-9]/g,'')}`, label: 'WhatsApp', icon: '💬' },
          content.instagram_url && { href: content.instagram_url, label: 'Instagram', icon: '📷' },
        ].filter(Boolean);
        socialWrap.innerHTML = links.map(l => `<a href="${l.href}" target="_blank" rel="noopener" title="${l.label}" style="margin-right:14px;font-size:20px">${l.icon}</a>`).join('');
      }
    })
    .catch(() => {});
}
document.addEventListener('DOMContentLoaded', applySiteContent);
