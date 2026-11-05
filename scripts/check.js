// Syntax-checks every server and browser script.
import { execFileSync } from "node:child_process";
const files = ["lib/server.js", "lib/claude.js", "api/chat.js", "api/analyze.js", "api/config.js", "api/account.js", "lib/fuente.js", "lib/web.js", "api/fuente.js", "api/catalogo.js", "api/investigar.js", "public/app.js"];
for (const f of files) execFileSync(process.execPath, ["--check", f], { stdio: "inherit" });
console.log(`OK: ${files.length} archivos sin errores de sintaxis`);
