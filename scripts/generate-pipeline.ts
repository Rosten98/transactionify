import { generatePrPipeline } from "devex-framework";
import * as fs from "fs";
import * as path from "path";

/*
  Este script es el punto de integración entre Transactionify y el framework.
  
  Decisión: usamos un script explícito en lugar de generarlo automáticamente
  en el build porque así el equipo tiene control sobre cuándo regenerar
  el pipeline — por ejemplo, después de actualizar la versión del framework.
  
  El archivo generado se commitea al repo para que GitHub Actions lo encuentre.
  Esto también significa que el pipeline es auditable — puedes ver en el
  historial de git exactamente qué cambió en el pipeline y cuándo.
*/
const pipeline = generatePrPipeline({
  service: "transactionify",
  language: "python",
  workIdPattern: /[A-Z]+-\d+/,
  environments: ["sandbox", "staging", "production"],
  /*
    testCommand refleja exactamente cómo Transactionify corre sus tests
    según su propio README.
  */
  testCommand: "cd test/unit/src/python && pytest -v",
});

const outputPath = path.join(
  __dirname,
  "..",
  ".github",
  "workflows",
  "pr.yml"
);

fs.writeFileSync(outputPath, pipeline, "utf-8");
console.log(`Pipeline generado en: ${outputPath}`);
console.log("\n--- Contenido generado ---\n");
console.log(pipeline);