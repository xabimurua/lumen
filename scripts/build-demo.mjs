// Builds demo/lumen-demo.html: the production UI with an in-browser backend, for claude.ai.
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync("public/index.html", "utf8");
const css = readFileSync("public/styles.css", "utf8").replace(/@font-face\{[^}]*\}\n?/g, "");
const body = html.slice(html.indexOf("<body>") + 6, html.indexOf('<script src="/vendor'));
const js = (f) => readFileSync(f, "utf8").replace(/<\/script/gi, "<\\/script");
const out = `<title>Lumen</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap">
<style>
${css}
.demo-banner{position:sticky;top:env(safe-area-inset-top,0px);z-index:20;background:var(--lamp);color:#152038;font-size:12px;font-weight:700;text-align:center;padding-block:7px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.demo-banner button{background:none;border:0;text-decoration:underline;font-weight:700;color:inherit;padding:0}
</style>
${body.replaceAll('href="/privacidad.html" target="_blank" rel="noopener"', 'href="#privacidad"')}
<script>
${js("demo/shim-pre.js")}
</script>
<script>
${js("public/app.js")}
</script>
<script>
${js("demo/shim-post.js")}
</script>
`;
writeFileSync("demo/lumen-demo.html", out);
console.log("demo/lumen-demo.html", out.length, "bytes");
