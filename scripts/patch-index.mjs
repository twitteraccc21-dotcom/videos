import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');
let c = readFileSync(file, 'utf8');

c = c.replace(
  /function watchPageUrl\(videoId\) \{\s*return '\/watch\?id=' \+ encodeURIComponent\(String\(videoId \|\| ''\)\);\s*\}/,
  `function watchPageUrl(videoId, opts) {
        var u = '/watch?id=' + encodeURIComponent(String(videoId || ''));
        opts = opts || {};
        if (opts.preview) u += '&preview=1';
        if (opts.pay) u += '#pay';
        return u;
      }`
);

c = c.replace(
  /var previewHref = watchPageUrl\(v\.id\);/,
  'var previewHref = watchPageUrl(v.id, { preview: true });'
);

c = c.replace(
  /<button type="button" class="btn btn-primary js-payopen" style="flex:1">Buy now<\/button>/,
  `<a class="btn btn-primary" style="flex:1" href="' + escapeAttr(watchPageUrl(v.id, { pay: true })) + '" onclick="event.stopPropagation()">Buy now</a>`
);

c = c.replace(
  /\s*var po = el\.querySelector\('\.js-payopen'\);\s*if \(po\) po\.addEventListener\('click', function \(e\) \{\s*e\.stopPropagation\(\);\s*openPay\(v\);\s*\}\);\s*/,
  '\n'
);

if (!c.includes("p.get('paid') === '1'")) {
  c = c.replace(
    /function parseUrlParams\(\) \{\s*var p = new URLSearchParams\(window\.location\.search\);/,
    `function parseUrlParams() {
        var p = new URLSearchParams(window.location.search);
        if (p.get('paid') === '1') {
          var vid = p.get('video_id') || '';
          var ebooks = normalizeOrigin(String(EBOOKS_ORIGIN || '').trim());
          if (ebooks) {
            var redir = ebooksSuccessUrl(p.get('amount') || '0', 'Digital purchase', vid);
            if (redir) {
              window.location.replace(redir);
              return;
            }
          }
        }`
  );
}

c = c.replace(
  /<a class="btn btn-primary" href="' \+ escapeAttr\(watchPageUrl\(v\.id\)\) \+ '">Watch &amp; pay<\/a>[\s\S]*?if \(bp\) bp\.addEventListener\('click', function \(\) \{ d\.close\(\); openPay\(v\); \}\);\s*d\.showModal\(\);/,
  `<a class="btn btn-primary" href="' + escapeAttr(watchPageUrl(v.id, { pay: true })) + '">Watch &amp; pay</a>' +
          '<a class="btn" href="' + escapeAttr(tgUrlForVideo(v, tgUser) || '#') + '" target="_blank">Contact</a>' +
          '</div>';
        d.showModal();`
);

c = c.replace(/<\/motion\.motion\.div>/g, '</div>');

writeFileSync(file, c);
console.log('patched', file);
